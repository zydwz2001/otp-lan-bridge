package dev.otplanbridge

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.provider.Telephony
import android.provider.Settings
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.security.SecureRandom

class BridgeCoordinator(private val context: Context) {
    val config = ConfigStore(context)

    @Volatile private var server: BridgeSocketServer? = null
    @Volatile private var activityVisible = false
    @Volatile private var pairCode: PairCodeState? = null
    @Volatile private var diagnostic = "桥接服务未启用"
    @Volatile private var lastObservedNotificationPackage: String? = null
    @Volatile private var lastObservedNotificationAt: Long? = null
    @Volatile private var lastCode: String? = null
    @Volatile private var lastCodeAt: Long? = null
    private val secureRandom = SecureRandom()

    @Synchronized
    fun startServer() {
        val address = findLanAddress()
        if (address == null) {
            diagnostic = "未检测到可用的 Wi-Fi/LAN IPv4 地址"
            stopServerInternal()
            return
        }
        val current = server
        if (current != null && current.hostAddress == address && current.listenPort == config.port) return

        stopServerInternal()
        val created = BridgeSocketServer(
            // Listen on loopback as well as Wi-Fi so `adb forward` can provide a
            // cable-only transport when the access point isolates its clients.
            InetSocketAddress("0.0.0.0", config.port),
            address,
            config,
            pairCodeProvider = { currentPairCode() },
            pairingAllowed = { activityVisible },
            notificationAccessProvider = { hasNotificationAccess() },
            onPairingComplete = { pairCode = null },
            onOtpAcknowledged = {
                lastCode = null
                lastCodeAt = null
            },
            onStateChanged = { diagnostic = it }
        )
        server = created
        try {
            created.start()
            diagnostic = "正在启动局域网服务"
        } catch (_: Exception) {
            server = null
            diagnostic = "局域网服务启动失败，请检查端口是否被占用"
        }
    }

    @Synchronized
    fun stopServer() {
        stopServerInternal()
        diagnostic = "桥接服务已暂停"
    }

    @Synchronized
    fun restartServer() {
        if (!config.bridgeEnabled) return
        startServer()
    }

    @Synchronized
    fun unpair() {
        config.clearPairing()
        pairCode = null
        stopServerInternal()
        if (config.bridgeEnabled) startServer()
        diagnostic = "已解除配对"
    }

    fun setActivityVisible(visible: Boolean) {
        activityVisible = visible
        if (visible && config.bridgeEnabled && config.loadPairing() == null) currentPairCode()
    }

    @Synchronized
    fun regeneratePairCode(): PairCodeState {
        val code = (secureRandom.nextInt(900_000) + 100_000).toString()
        return PairCodeState(code, System.currentTimeMillis() + PAIR_CODE_TTL_MS).also { pairCode = it }
    }

    fun currentPairCode(now: Long = System.currentTimeMillis()): PairCodeState? {
        if (!activityVisible || config.loadPairing() != null) return null
        val current = pairCode
        return if (current == null || current.expiresAt <= now) regeneratePairCode() else current
    }

    fun shouldInspect(packageName: String, postedAt: Long): Boolean {
        val selectedPackage = selectedSmsPackage() ?: return false
        if (packageName != selectedPackage) return false
        val arm = server?.captureSession(postedAt) ?: return false
        return postedAt >= arm.createdAt - CLOCK_SKEW_ALLOWANCE_MS
    }

    fun noteNotificationObserved(packageName: String, postedAt: Long) {
        val arm = server?.captureSession(postedAt) ?: return
        if (postedAt < arm.createdAt - CLOCK_SKEW_ALLOWANCE_MS) return
        lastObservedNotificationPackage = packageName
        lastObservedNotificationAt = postedAt
    }

    fun handleNotification(payload: NotificationPayload) {
        val activeServer = server ?: return
        val arm = activeServer.captureSession(payload.postedAt) ?: return
        if (payload.packageName != selectedSmsPackage() || payload.postedAt < arm.createdAt - CLOCK_SKEW_ALLOWANCE_MS) return

        when (val result = OtpParser.parse(payload.combinedText(), arm.expectedDigits)) {
            OtpParseResult.NoContent -> {
                diagnostic = "短信通知隐藏了内容"
                activeServer.sendDiagnostic("NOTIFICATION_CONTENT_HIDDEN", "短信通知隐藏了内容，请开启通知内容显示")
            }
            OtpParseResult.HighRisk -> diagnostic = "已拦截高风险通知"
            OtpParseResult.NoConfidentCandidate -> {
                diagnostic = if (Regex("(?<!\\d)\\d{4,8}(?!\\d)").containsMatchIn(payload.combinedText())) {
                    "通知中读取到数字，但未满足验证码规则"
                } else {
                    "短信通知未提供可读取的验证码数字"
                }
            }
            is OtpParseResult.Match -> {
                val fingerprint = CryptoBox.fingerprint(
                    listOf(payload.packageName, payload.notificationKey, result.code, (payload.postedAt / 60_000).toString())
                )
                if (!activeServer.markFingerprintIfNew(fingerprint, payload.postedAt)) return
                val sent = activeServer.deliverOtp(
                    arm, result.code, emptyList(), result.confidence, payload.postedAt, sourceAppLabel(payload.packageName)
                )
                if (sent) {
                    lastCode = result.code
                    lastCodeAt = payload.postedAt
                    diagnostic = "验证码已发送到浏览器"
                }
            }
            is OtpParseResult.Ambiguous -> {
                val fingerprint = CryptoBox.fingerprint(
                    listOf(payload.packageName, payload.notificationKey, result.candidates.joinToString(","), (payload.postedAt / 60_000).toString())
                )
                if (!activeServer.markFingerprintIfNew(fingerprint, payload.postedAt)) return
                if (activeServer.deliverOtp(
                        arm, null, result.candidates, result.confidence, payload.postedAt, sourceAppLabel(payload.packageName)
                    )
                ) diagnostic = "识别到多个候选验证码，等待浏览器确认"
            }
        }
    }

    fun sendSyntheticNotification(): Boolean {
        val smsPackage = selectedSmsPackage() ?: return false
        val activeServer = server ?: return false
        if (activeServer.captureSession() == null) return false
        val code = (secureRandom.nextInt(900_000) + 100_000).toString()
        handleNotification(
            NotificationPayload(
                packageName = smsPackage,
                notificationKey = "local-test-${System.currentTimeMillis()}",
                postedAt = System.currentTimeMillis(),
                title = "本地端到端测试",
                text = "验证码 $code，5 分钟内有效，请勿泄露。",
                bigText = null,
                textLines = emptyList()
            )
        )
        return true
    }

    fun selectedSmsPackage(): String? = config.selectedSmsPackage ?: Telephony.Sms.getDefaultSmsPackage(context)

    fun hasNotificationAccess(): Boolean {
        return if (Build.VERSION.SDK_INT >= 27) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.isNotificationListenerAccessGranted(ComponentName(context, OtpNotificationListener::class.java))
        } else {
            Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
                ?.contains(context.packageName) == true
        }
    }

    fun onNotificationAccessMayHaveChanged() {
        server?.broadcastStatus()
    }

    fun snapshot(): BridgeSnapshot {
        if (lastCodeAt?.let { System.currentTimeMillis() - it > OTP_LOCAL_TTL_MS } == true) {
            lastCode = null
            lastCodeAt = null
        }
        val activeServer = server
        val code = if (activityVisible) currentPairCode() else null
        if (lastObservedNotificationAt?.let { System.currentTimeMillis() - it > OBSERVED_NOTIFICATION_TTL_MS } == true) {
            lastObservedNotificationPackage = null
            lastObservedNotificationAt = null
        }
        return BridgeSnapshot(
            enabled = config.bridgeEnabled,
            running = activeServer != null,
            notificationListenerConnected = OtpNotificationListener.isConnected,
            boundAddress = activeServer?.hostAddress,
            port = config.port,
            clientOnline = activeServer?.isClientOnline() == true,
            paired = config.loadPairing() != null,
            pairCode = code?.code,
            pairCodeExpiresAt = code?.expiresAt,
            diagnostic = diagnostic,
            lastObservedNotificationPackage = lastObservedNotificationPackage,
            lastCode = lastCode,
            lastCodeAt = lastCodeAt
        )
    }

    private fun sourceAppLabel(packageName: String): String = try {
        val info = context.packageManager.getApplicationInfo(packageName, 0)
        context.packageManager.getApplicationLabel(info).toString()
    } catch (_: Exception) {
        "短信"
    }

    private fun findLanAddress(): String? {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val connectivityAddresses = manager.allNetworks
            .flatMap { network -> manager.getLinkProperties(network)?.linkAddresses.orEmpty() }
            .map { it.address }
        val interfaceAddresses = try {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
        } catch (_: Exception) {
            emptyList()
        }
        return selectBridgeAddress(connectivityAddresses + interfaceAddresses)?.hostAddress
    }

    @Synchronized
    private fun stopServerInternal() {
        server?.stopSafely()
        server = null
    }

    companion object {
        private const val PAIR_CODE_TTL_MS = 30 * 60 * 1000L
        private const val CLOCK_SKEW_ALLOWANCE_MS = 5_000L
        private const val OTP_LOCAL_TTL_MS = 2 * 60 * 1000L
        private const val OBSERVED_NOTIFICATION_TTL_MS = 10 * 60 * 1000L
    }
}

internal fun selectBridgeAddress(addresses: List<InetAddress>): Inet4Address? {
    val candidates = addresses
        .filterIsInstance<Inet4Address>()
        .filterNot { it.isLoopbackAddress || it.isLinkLocalAddress }
        .distinctBy { it.hostAddress }
    return candidates.firstOrNull(::isTailscaleAddress)
        ?: candidates.firstOrNull { it.isSiteLocalAddress }
}

internal fun isTailscaleAddress(address: InetAddress): Boolean {
    val bytes = address.address
    if (bytes.size != 4) return false
    val first = bytes[0].toInt() and 0xff
    val second = bytes[1].toInt() and 0xff
    return first == 100 && second in 64..127
}
