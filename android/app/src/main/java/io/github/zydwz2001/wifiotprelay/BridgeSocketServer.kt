package io.github.zydwz2001.wifiotprelay

import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.InetAddress
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs

class BridgeSocketServer(
    address: InetSocketAddress,
    advertisedHostAddress: String,
    private val config: ConfigStore,
    private val pairCodeProvider: () -> PairCodeState?,
    private val pairingAllowed: () -> Boolean,
    private val notificationAccessProvider: () -> Boolean,
    private val onPairingComplete: () -> Unit,
    private val onOtpAcknowledged: (String) -> Unit,
    private val onStateChanged: (String) -> Unit
) : WebSocketServer(address) {
    val hostAddress: String = advertisedHostAddress
    val listenPort: Int = address.port

    private enum class Stage { NEW, CHALLENGED, AUTHENTICATED }

    private class ClientContext {
        var stage = Stage.NEW
        var clientId: String? = null
        var deviceId: String? = null
        var sessionId: String? = null
        var sessionKey: ByteArray? = null
        var incomingSeq = 0L
        var outgoingSeq = 0L
        var lastSeenAt = System.currentTimeMillis()
        var lastSentAt = 0L
    }

    private data class PendingOtp(val messageId: String, val expiresAt: Long)

    private val contexts = ConcurrentHashMap<WebSocket, ClientContext>()
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "bridge-heartbeat").apply { isDaemon = true }
    }
    private val recentFingerprints = ConcurrentHashMap<String, Long>()
    private val stateLock = Any()
    private var activeClient: WebSocket? = null
    private var activeArm: ArmSession? = null
    private var pendingOtp: PendingOtp? = null
    private var deliveredForArm = 0
    private var failedPairAttempts = 0
    private var pairLockedUntil = 0L

    init {
        setReuseAddr(true)
        // Drop half-open browser connections so a cancelled Chrome permission
        // request cannot leave the phone bridge stuck until the app is restarted.
        connectionLostTimeout = 20
    }

    override fun onStart() {
        scheduler.scheduleWithFixedDelay(::heartbeatTick, 5, 5, TimeUnit.SECONDS)
        onStateChanged("验证码传递已开始，等待电脑连接")
    }

    override fun onOpen(connection: WebSocket, handshake: ClientHandshake) {
        val remoteAddress = connection.remoteSocketAddress?.address
        if (remoteAddress == null || !isAllowedBridgePeer(remoteAddress)) {
            connection.close(1008, "Local connections only")
            return
        }
        if (handshake.resourceDescriptor.substringBefore('?') != PATH) {
            connection.close(1008, "Unsupported path")
            return
        }
        contexts[connection] = ClientContext()
        onStateChanged("浏览器正在认证")
    }

    override fun onClose(connection: WebSocket, code: Int, reason: String?, remote: Boolean) {
        contexts.remove(connection)
        synchronized(stateLock) {
            if (activeClient == connection) {
                activeClient = null
                activeArm = null
                pendingOtp = null
                deliveredForArm = 0
                onStateChanged("电脑已断开，后台会自动恢复")
            }
        }
    }

    override fun onMessage(connection: WebSocket, message: String) {
        val context = contexts[connection] ?: return
        if (message.length > MAX_MESSAGE_SIZE) {
            connection.close(1009, "Message too large")
            return
        }
        context.lastSeenAt = System.currentTimeMillis()
        try {
            val json = JSONObject(message)
            if (json.has("ciphertext")) {
                handleEncrypted(connection, context, json)
            } else {
                handlePlain(connection, context, json)
            }
        } catch (_: Exception) {
            sendProtocolError(connection, context, "INVALID_MESSAGE", "消息格式无效")
        }
    }

    override fun onError(connection: WebSocket?, exception: Exception) {
        onStateChanged(if (connection == null) "验证码传递启动失败" else "浏览器连接异常")
    }

    fun stopSafely() {
        scheduler.shutdownNow()
        try {
            stop(1_000)
        } catch (_: Exception) {
            // The service is already stopped.
        }
    }

    fun isClientOnline(): Boolean = synchronized(stateLock) {
        activeClient?.isOpen == true && contexts[activeClient]?.stage == Stage.AUTHENTICATED
    }

    fun captureSession(now: Long = System.currentTimeMillis()): ArmSession? = synchronized(stateLock) {
        val connection = activeClient
        val arm = activeArm
        if (connection?.isOpen == true && arm != null && arm.expiresAt > now) arm else null
    }

    fun markFingerprintIfNew(fingerprint: String, now: Long): Boolean {
        val previous = recentFingerprints.put(fingerprint, now)
        recentFingerprints.entries.removeIf { now - it.value > DEDUPE_WINDOW_MS }
        return previous == null || now - previous > DEDUPE_WINDOW_MS
    }

    fun deliverOtp(
        arm: ArmSession,
        code: String?,
        candidates: List<String>,
        confidence: Double,
        receivedAt: Long,
        sourceAppLabel: String
    ): Boolean = synchronized(stateLock) {
        val connection = activeClient ?: return false
        if (!connection.isOpen || activeArm?.requestId != arm.requestId || arm.expiresAt <= receivedAt) return false
        if (deliveredForArm >= MAX_OTP_PER_ARM) return false

        val messageId = UUID.randomUUID().toString()
        val payload = JSONObject()
            .put("requestId", arm.requestId)
            .put("messageId", messageId)
            .put("digits", code?.length ?: candidates.firstOrNull()?.length ?: 0)
            .put("receivedAt", receivedAt)
            .put("sourceAppLabel", sourceAppLabel.take(40))
            .put("senderMasked", "")
            .put("confidence", confidence)
            .put("ambiguous", code == null)
        if (code != null) payload.put("code", code)
        if (candidates.isNotEmpty()) payload.put("candidates", JSONArray(candidates))

        sendEncrypted(connection, "OTP", payload)
        deliveredForArm++
        pendingOtp = PendingOtp(messageId, System.currentTimeMillis() + OTP_RETENTION_MS)
        true
    }

    fun sendDiagnostic(code: String, message: String) {
        val connection = synchronized(stateLock) { activeClient } ?: return
        sendEncrypted(
            connection,
            "ERROR",
            JSONObject().put("code", code).put("message", message.take(100))
        )
    }

    fun broadcastStatus() {
        val connection = synchronized(stateLock) { activeClient } ?: return
        sendStatus(connection)
    }

    private fun handlePlain(connection: WebSocket, context: ClientContext, json: JSONObject) {
        if (context.stage != Stage.NEW) {
            connection.close(1008, "Plaintext is not allowed after handshake")
            return
        }
        when (json.optString("type")) {
            "PAIR_INIT" -> handlePair(connection, json)
            "AUTH_INIT" -> handleAuthInit(connection, context, json)
            else -> sendPlainError(connection, "AUTH_REQUIRED", "需要先配对或认证")
        }
    }

    private fun handlePair(connection: WebSocket, json: JSONObject) {
        val now = System.currentTimeMillis()
        if (!pairingAllowed()) {
            sendPlainError(connection, "PAIRING_NOT_VISIBLE", "请保持手机配对页面处于前台")
            return
        }
        if (config.loadPairing() != null) {
            sendPlainError(connection, "ALREADY_PAIRED", "请先在手机上解除现有配对")
            return
        }
        if (now < pairLockedUntil) {
            sendPlainError(connection, "PAIRING_LOCKED", "尝试次数过多，请稍后重试")
            return
        }

        val state = pairCodeProvider()
        val suppliedCode = json.optString("pairCode")
        if (state == null || state.expiresAt <= now || !constantTimeTextEquals(state.code, suppliedCode)) {
            failedPairAttempts++
            if (failedPairAttempts >= 5) {
                pairLockedUntil = now + PAIR_LOCK_MS
                failedPairAttempts = 0
            }
            sendPlainError(connection, "INVALID_PAIR_CODE", "配对码无效或已过期")
            return
        }

        val clientId = json.optString("clientId").takeIf { it.length in 16..128 }
        val clientPublic = json.optString("clientPublicKey").takeIf { it.length in 80..1024 }
        if (clientId == null || clientPublic == null) {
            sendPlainError(connection, "INVALID_PAIR_REQUEST", "配对参数无效")
            return
        }

        val serverKeyPair = CryptoBox.generateEcdhKeyPair()
        val sharedSecret = CryptoBox.deriveEcdh(serverKeyPair, CryptoBox.decode(clientPublic))
        val pairingKey = CryptoBox.pairingKey(sharedSecret, suppliedCode)
        val serverPublic = CryptoBox.encode(serverKeyPair.public.encoded)
        val deviceId = config.deviceId
        val proof = CryptoBox.encode(
            CryptoBox.hmac(
                pairingKey,
                CryptoBox.pairingProofMessage(clientPublic, serverPublic, deviceId, clientId)
            )
        )

        config.savePairing(clientId, pairingKey)
        failedPairAttempts = 0
        connection.send(
            JSONObject()
                .put("v", 1)
                .put("type", "PAIR_OK")
                .put("deviceId", deviceId)
                .put("serverPublicKey", serverPublic)
                .put("proof", proof)
                .toString()
        )
        onPairingComplete()
        onStateChanged("设备配对成功")
        connection.close(1000, "Pairing complete")
    }

    private fun handleAuthInit(connection: WebSocket, context: ClientContext, json: JSONObject) {
        val pairing = config.loadPairing()
        val clientId = json.optString("clientId")
        val deviceId = json.optString("deviceId")
        val clientNonceText = json.optString("clientNonce")
        val timestamp = json.optLong("timestamp")
        val now = System.currentTimeMillis()
        if (pairing == null || pairing.clientId != clientId || pairing.deviceId != deviceId) {
            sendPlainError(connection, "NOT_PAIRED", "设备未配对")
            return
        }
        if (abs(now - timestamp) > CLOCK_TOLERANCE_MS) {
            sendPlainError(connection, "CLOCK_SKEW", "设备时间偏差过大")
            return
        }
        val clientNonce = try { CryptoBox.decode(clientNonceText) } catch (_: Exception) { ByteArray(0) }
        if (clientNonce.size != 16) {
            sendPlainError(connection, "INVALID_NONCE", "认证随机数无效")
            return
        }

        val serverNonce = CryptoBox.randomBytes(16)
        val serverNonceText = CryptoBox.encode(serverNonce)
        val sessionId = UUID.randomUUID().toString()
        val key = CryptoBox.sessionKey(pairing.key, clientNonce, serverNonce, sessionId)
        val proof = CryptoBox.encode(
            CryptoBox.hmac(
                pairing.key,
                CryptoBox.authProofMessage(deviceId, clientId, sessionId, clientNonceText, serverNonceText)
            )
        )

        context.clientId = clientId
        context.deviceId = deviceId
        context.sessionId = sessionId
        context.sessionKey = key
        context.stage = Stage.CHALLENGED
        connection.send(
            JSONObject()
                .put("v", 1)
                .put("type", "AUTH_CHALLENGE")
                .put("deviceId", deviceId)
                .put("sessionId", sessionId)
                .put("serverNonce", serverNonceText)
                .put("proof", proof)
                .toString()
        )
    }

    private fun handleEncrypted(connection: WebSocket, context: ClientContext, envelope: JSONObject) {
        val key = context.sessionKey ?: run {
            connection.close(1008, "Authentication required")
            return
        }
        if (envelope.optString("deviceId") != context.deviceId || envelope.optString("sessionId") != context.sessionId) {
            connection.close(1008, "Session mismatch")
            return
        }
        val seq = envelope.optLong("seq", -1)
        val timestamp = envelope.optLong("timestamp", 0)
        if (seq <= context.incomingSeq || abs(System.currentTimeMillis() - timestamp) > CLOCK_TOLERANCE_MS) {
            connection.close(1008, "Replay rejected")
            return
        }
        val payload = CryptoBox.decryptEnvelope(envelope, key)
        context.incomingSeq = seq

        if (context.stage == Stage.CHALLENGED) {
            if (envelope.optString("type") != "ACK" || payload.optString("kind") != "AUTH_OK") {
                connection.close(1008, "Authentication proof required")
                return
            }
            val previous = synchronized(stateLock) {
                val old = activeClient
                activeClient = connection
                activeArm = null
                pendingOtp = null
                deliveredForArm = 0
                old
            }
            context.stage = Stage.AUTHENTICATED
            if (previous != null && previous != connection) previous.close(1000, "Replaced by a new session")
            sendStatus(connection)
            onStateChanged("浏览器已连接")
            return
        }
        if (context.stage != Stage.AUTHENTICATED) {
            connection.close(1008, "Authentication required")
            return
        }

        when (envelope.getString("type")) {
            "ARM" -> handleArm(connection, payload)
            "CANCEL" -> handleCancel(connection, payload)
            "PING" -> sendEncrypted(connection, "PONG", JSONObject().put("at", System.currentTimeMillis()))
            "PONG" -> Unit
            "ACK" -> handleAck(payload)
            else -> sendProtocolError(connection, context, "UNSUPPORTED_TYPE", "不支持的消息类型")
        }
    }

    private fun handleArm(connection: WebSocket, payload: JSONObject) {
        val now = System.currentTimeMillis()
        val requestId = payload.optString("requestId")
        val createdAt = payload.optLong("createdAt")
        val expiresAt = payload.optLong("expiresAt")
        if (requestId.length !in 16..128 || createdAt > now + 5_000 || createdAt < now - ARM_MAX_MS ||
            expiresAt <= now || expiresAt > createdAt + ARM_MAX_MS
        ) {
            sendEncrypted(connection, "ERROR", JSONObject().put("code", "INVALID_ARM").put("message", "等待会话无效"))
            return
        }
        val expected = payload.optJSONArray("expectedDigits") ?: JSONArray()
        val digits = buildSet {
            for (index in 0 until expected.length()) {
                val value = expected.optInt(index)
                if (value in 4..8) add(value)
            }
        }.ifEmpty { setOf(4, 5, 6) }
        val arm = ArmSession(requestId, createdAt, expiresAt, digits, payload.optString("siteLabel").take(80))
        synchronized(stateLock) {
            activeClient = connection
            activeArm = arm
            pendingOtp = null
            deliveredForArm = 0
        }
        sendEncrypted(connection, "ACK", JSONObject().put("kind", "ARMED").put("requestId", requestId))
        onStateChanged("正在等待验证码")
    }

    private fun handleCancel(connection: WebSocket, payload: JSONObject) {
        val requestId = payload.optString("requestId")
        synchronized(stateLock) {
            if (activeClient == connection && activeArm?.requestId == requestId) {
                activeArm = null
                pendingOtp = null
                deliveredForArm = 0
            }
        }
        sendEncrypted(connection, "ACK", JSONObject().put("kind", "CANCELLED").put("requestId", requestId))
        onStateChanged("等待已取消")
    }

    private fun handleAck(payload: JSONObject) {
        if (payload.optString("kind") != "OTP_RECEIVED") return
        val messageId = payload.optString("messageId")
        synchronized(stateLock) {
            if (pendingOtp?.messageId == messageId) {
                pendingOtp = null
                onOtpAcknowledged(messageId)
            }
        }
    }

    private fun sendStatus(connection: WebSocket) {
        sendEncrypted(
            connection,
            "ACK",
            JSONObject()
                .put("kind", "STATUS")
                .put("notificationAccess", notificationAccessProvider())
                .put("serverTime", System.currentTimeMillis())
        )
    }

    private fun sendEncrypted(connection: WebSocket, type: String, payload: JSONObject) {
        val context = contexts[connection] ?: return
        val key = context.sessionKey ?: return
        val deviceId = context.deviceId ?: return
        val sessionId = context.sessionId ?: return
        synchronized(context) {
            val now = System.currentTimeMillis()
            context.outgoingSeq++
            connection.send(CryptoBox.encryptEnvelope(type, deviceId, sessionId, context.outgoingSeq, now, payload, key).toString())
            context.lastSentAt = now
        }
    }

    private fun sendProtocolError(connection: WebSocket, context: ClientContext, code: String, message: String) {
        if (context.sessionKey != null) {
            sendEncrypted(connection, "ERROR", JSONObject().put("code", code).put("message", message))
        } else {
            sendPlainError(connection, code, message)
        }
    }

    private fun sendPlainError(connection: WebSocket, code: String, message: String) {
        connection.send(JSONObject().put("v", 1).put("type", "ERROR").put("code", code).put("message", message).toString())
    }

    private fun heartbeatTick() {
        val now = System.currentTimeMillis()
        contexts.forEach { (connection, context) ->
            if (context.stage == Stage.AUTHENTICATED) {
                if (now - context.lastSeenAt > CONNECTION_TIMEOUT_MS) {
                    connection.close(1001, "Heartbeat timeout")
                } else if (now - context.lastSentAt >= HEARTBEAT_MS) {
                    sendEncrypted(connection, "PING", JSONObject().put("at", now))
                }
            }
        }
        synchronized(stateLock) {
            if (activeArm?.expiresAt?.let { it <= now } == true) {
                activeArm = null
                pendingOtp = null
                deliveredForArm = 0
                onStateChanged("等待已超时")
            }
            if (pendingOtp?.expiresAt?.let { it <= now } == true) pendingOtp = null
        }
        recentFingerprints.entries.removeIf { now - it.value > DEDUPE_WINDOW_MS }
    }

    private fun constantTimeTextEquals(left: String, right: String): Boolean = CryptoBox.constantTimeEquals(
        left.toByteArray(StandardCharsets.UTF_8),
        right.toByteArray(StandardCharsets.UTF_8)
    )

    companion object {
        const val PATH = "/v1/bridge"
        private const val MAX_MESSAGE_SIZE = 32 * 1024
        private const val ARM_MAX_MS = 5 * 60 * 1000L
        private const val OTP_RETENTION_MS = 2 * 60 * 1000L
        private const val DEDUPE_WINDOW_MS = 60 * 1000L
        private const val CLOCK_TOLERANCE_MS = 2 * 60 * 1000L
        private const val PAIR_LOCK_MS = 5 * 60 * 1000L
        private const val HEARTBEAT_MS = 20 * 1000L
        private const val CONNECTION_TIMEOUT_MS = 55 * 1000L
        private const val MAX_OTP_PER_ARM = 5
    }
}

internal fun isAllowedBridgePeer(address: InetAddress): Boolean {
    return address.isSiteLocalAddress && !address.isLoopbackAddress && !address.isLinkLocalAddress
}
