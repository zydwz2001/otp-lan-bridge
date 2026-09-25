package io.github.zydwz2001.wifiotprelay

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
import java.security.SecureRandom

class BridgeCoordinator(private val context: Context) {
    val config = ConfigStore(context)

    @Volatile private var server: BridgeProtocol? = null
    @Volatile private var wifiServer: BridgeSocketServer? = null
    @Volatile private var usbServer: BridgeUsbServer? = null
    @Volatile private var advertisedWifiAddress: String? = null
    private val mdnsAdvertiser = BridgeMdnsAdvertiser(context)
    @Volatile private var activityVisible = false
    @Volatile private var pairCode: PairCodeState? = null
    @Volatile private var diagnostic = "验证码传递尚未开始"
    @Volatile private var lastObservedNotificationPackage: String? = null
    @Volatile private var lastObservedNotificationAt: Long? = null
    @Volatile private var lastCode: String? = null
    @Volatile private var lastCodeAt: Long? = null
    private val secureRandom = SecureRandom()

    @Synchronized
    fun startServer() {
        val address = findLanAddress()
        val protocol = server ?: BridgeProtocol(
            hostAddressProvider = { advertisedWifiAddress.orEmpty() },
            config = config,
            pairCodeProvider = { currentPairCode() },
            pairingAllowed = { activityVisible },
            notificationAccessProvider = { hasNotificationAccess() && OtpNotificationListener.isConnected },
            onPairingComplete = { pairCode = null },
            onArmActivated = { OtpNotificationListener.recoverRecentNotifications(context) },
            onOtpAcknowledged = {
                lastCode = null
                lastCodeAt = null
            },
            onStateChanged = { diagnostic = it }
        ).also { server = it }
        if (usbServer?.isRunning != true) {
            val usb = BridgeUsbServer(protocol)
            try {
                usb.start()
                usbServer = usb
            } catch (_: Exception) {
                usb.stopSafely()
                usbServer = null
            }
        }

        // Refresh only the Wi-Fi listener. A network change must not tear down
        // an authenticated USB session or its pending delivery history.
        val current = wifiServer
        if (current?.hostAddress == address?.hostAddress && current?.listenPort == config.port) return
        mdnsAdvertiser.stop()
        current?.stopSafely()
        wifiServer = null
        advertisedWifiAddress = address?.hostAddress
        if (address != null) {
            lateinit var wifi: BridgeSocketServer
            wifi = BridgeSocketServer(InetSocketAddress(address, config.port), protocol) {
                if (wifiServer === wifi) {
                    wifiServer = null
                    mdnsAdvertiser.stop()
                }
            }
            wifiServer = wifi
            try {
                wifi.start()
                mdnsAdvertiser.start(address, config.port, config.deviceId)
            } catch (_: Exception) {
                wifi.stopSafely()
                wifiServer = null
            }
        }
        if (protocol.isClientOnline()) {
            // Let an existing USB client learn a newly available Wi-Fi address
            // immediately, so unplugging can fall back without another pairing.
            protocol.broadcastStatus()
        } else {
            diagnostic = "验证码传递已开始，等待电脑连接"
        }
    }

    @Synchronized
    fun stopServer() {
        stopServerInternal()
        diagnostic = "验证码传递已停止"
    }

    @Synchronized
    fun restartServer() {
        if (!config.bridgeEnabled) return
        startServer()
    }

    @Synchronized
    fun forceRestartServer() {
        if (!config.bridgeEnabled) return
        stopServerInternal()
        diagnostic = "正在重新启动传递"
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
        val arm = captureSession() ?: return false
        return postedAt >= arm.createdAt - NOTIFICATION_RACE_WINDOW_MS
    }

    fun captureSession(): ArmSession? = if (config.bridgeEnabled) server?.captureSession() else null

    fun noteNotificationObserved(packageName: String, postedAt: Long) {
        val arm = captureSession() ?: return
        if (postedAt < arm.createdAt - NOTIFICATION_RACE_WINDOW_MS) return
        lastObservedNotificationPackage = packageName
        lastObservedNotificationAt = postedAt
    }

    fun handleNotification(payload: NotificationPayload) {
        val activeServer = server ?: return
        val arm = captureSession() ?: return
        if (payload.packageName != selectedSmsPackage() || payload.postedAt < arm.createdAt - NOTIFICATION_RACE_WINDOW_MS) return

        when (val result = OtpParser.parse(payload.combinedText(), arm.expectedDigits)) {
            OtpParseResult.NoContent -> {
                val changed = diagnostic != "短信通知隐藏了内容"
                diagnostic = "短信通知隐藏了内容"
                if (changed) activeServer.sendDiagnostic("NOTIFICATION_CONTENT_HIDDEN", "短信通知隐藏了内容，请开启通知内容显示")
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
                    listOf(payload.packageName, payload.notificationKey, result.code)
                )
                if (!activeServer.markFingerprintIfNew(fingerprint, arm)) return
                val sent = activeServer.deliverOtp(
                    arm, result.code, emptyList(), result.confidence, payload.postedAt, sourceAppLabel(payload.packageName)
                )
                if (sent) {
                    lastCode = result.code
                    lastCodeAt = payload.postedAt
                    diagnostic = "验证码已发送到浏览器"
                } else {
                    activeServer.releaseFingerprint(fingerprint, arm)
                    diagnostic = "验证码发送失败，正在等待通知重试"
                }
            }
            is OtpParseResult.Ambiguous -> {
                val fingerprint = CryptoBox.fingerprint(
                    listOf(payload.packageName, payload.notificationKey, result.candidates.joinToString(","))
                )
                if (!activeServer.markFingerprintIfNew(fingerprint, arm)) return
                if (activeServer.deliverOtp(
                        arm, null, result.candidates, result.confidence, payload.postedAt, sourceAppLabel(payload.packageName)
                    )
                ) {
                    diagnostic = "识别到多个候选验证码，等待浏览器确认"
                } else {
                    activeServer.releaseFingerprint(fingerprint, arm)
                    diagnostic = "验证码发送失败，正在等待通知重试"
                }
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
            running = usbServer?.isRunning == true || wifiServer != null,
            notificationListenerConnected = OtpNotificationListener.isConnected,
            boundAddress = advertisedWifiAddress,
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

    private fun findLanAddress(): Inet4Address? {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val connectivityAddresses = manager.allNetworks
            .filter { network ->
                manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            }
            .flatMap { network -> manager.getLinkProperties(network)?.linkAddresses.orEmpty() }
            .map { it.address }
        return selectWifiAddress(connectivityAddresses)
    }

    @Synchronized
    private fun stopServerInternal() {
        mdnsAdvertiser.stop()
        wifiServer?.stopSafely()
        wifiServer = null
        usbServer?.stopSafely()
        usbServer = null
        server?.stopSafely()
        server = null
        advertisedWifiAddress = null
    }

    companion object {
        private const val PAIR_CODE_TTL_MS = 30 * 60 * 1000L
        private const val OTP_LOCAL_TTL_MS = 2 * 60 * 1000L
        private const val OBSERVED_NOTIFICATION_TTL_MS = 10 * 60 * 1000L
    }
}

internal const val NOTIFICATION_RACE_WINDOW_MS = 5_000L

internal fun selectWifiAddress(addresses: List<InetAddress>): Inet4Address? = addresses
        .filterIsInstance<Inet4Address>()
        .filter { it.isSiteLocalAddress && !it.isLoopbackAddress && !it.isLinkLocalAddress }
        .distinctBy { it.hostAddress }
        .firstOrNull()
