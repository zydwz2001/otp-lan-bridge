package io.github.zydwz2001.wifiotprelay

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.util.UUID

class BridgeProtocolTest {
    private class Store : BridgePairingStore {
        override val deviceId = UUID.randomUUID().toString()
        override val port = 42871
        var pairing: PairingRecord? = null
        override fun savePairing(clientId: String, key: ByteArray) { pairing = PairingRecord(deviceId, clientId, key) }
        override fun loadPairing() = pairing
    }

    private class Peer : BridgeConnection {
        override var isOpen = true
        val messages = mutableListOf<JSONObject>()
        override fun send(message: String) { messages.add(JSONObject(message)) }
        override fun close(code: Int, reason: String) { isOpen = false }
    }

    @Test
    fun pairsWithoutWifiAndRejectsIncorrectCode() {
        val store = Store()
        val protocol = protocol(store)
        try {
            val peer = Peer()
            protocol.onOpen(peer)
            val clientKey = CryptoBox.generateEcdhKeyPair()
            val clientId = UUID.randomUUID().toString()
            val publicKey = CryptoBox.encode(clientKey.public.encoded)
            val request = JSONObject().put("type", "PAIR_INIT").put("clientId", clientId)
                .put("clientPublicKey", publicKey).put("pairCode", "000000")
            protocol.onMessage(peer, request.toString())
            assertEquals("INVALID_PAIR_CODE", peer.messages.last().getString("code"))
            assertNull(store.pairing)
            request.put("pairCode", "123456")
            protocol.onMessage(peer, request.toString())
            val response = peer.messages.last()
            assertEquals("PAIR_OK", response.getString("type"))
            val serverPublic = response.getString("serverPublicKey")
            val key = CryptoBox.pairingKey(CryptoBox.deriveEcdh(clientKey, CryptoBox.decode(serverPublic)), "123456")
            assertArrayEquals(key, store.pairing!!.key)
            assertArrayEquals(CryptoBox.hmac(key, CryptoBox.pairingProofMessage(publicKey, serverPublic, store.deviceId, clientId)),
                CryptoBox.decode(response.getString("proof")))
            assertTrue("PAIR_OK must remain queued until delivered", peer.isOpen)
        } finally { protocol.stopSafely() }
    }

    @Test
    fun switchesTransportWithoutLosingPendingCodeOrDeduplication() {
        val store = Store()
        val clientId = UUID.randomUUID().toString()
        store.savePairing(clientId, CryptoBox.randomBytes(32))
        val protocol = protocol(store)
        try {
            val first = Peer()
            val firstSession = authenticate(protocol, store, first)
            val now = System.currentTimeMillis()
            val requestId = UUID.randomUUID().toString()
            send(protocol, store, first, firstSession, 2, "ARM", JSONObject()
                .put("requestId", requestId).put("createdAt", now).put("expiresAt", now + 60_000))
            val arm = protocol.captureSession()!!
            assertTrue(protocol.markFingerprintIfNew("notification-1", arm))
            assertTrue(protocol.deliverOtp(arm, "246810", emptyList(), 1.0, now, "Test"))
            val firstOtp = CryptoBox.decryptEnvelope(first.messages.last(), firstSession.second)

            val second = Peer()
            val secondSession = authenticate(protocol, store, second)
            assertFalse(first.isOpen)
            assertTrue(protocol.isClientOnline())
            assertEquals(requestId, protocol.captureSession()!!.requestId)
            val replayed = CryptoBox.decryptEnvelope(second.messages.last(), secondSession.second)
            assertEquals(firstOtp.getString("messageId"), replayed.getString("messageId"))
            assertEquals("246810", replayed.getString("code"))
            assertFalse(protocol.markFingerprintIfNew("notification-1", arm))
            send(protocol, store, second, secondSession, 2, "ACK", JSONObject()
                .put("kind", "OTP_RECEIVED").put("messageId", replayed.getString("messageId")))

            val third = Peer()
            authenticate(protocol, store, third)
            assertEquals("STATUS", CryptoBox.decryptEnvelope(third.messages.last(),
                sessions.getValue(third).second).getString("kind"))
            assertFalse(protocol.markFingerprintIfNew("notification-1", arm))
        } finally { protocol.stopSafely() }
    }

    @Test
    fun framesUseByteLengthsAndRejectOversizedInput() {
        val bytes = ByteArrayOutputStream()
        val output = DataOutputStream(bytes)
        BridgeFrames.write(output, "连接手机")
        BridgeFrames.write(output, "next")
        val input = DataInputStream(ByteArrayInputStream(bytes.toByteArray()))
        assertEquals("连接手机", BridgeFrames.read(input))
        assertEquals("next", BridgeFrames.read(input))
        val invalid = ByteArrayOutputStream()
        DataOutputStream(invalid).writeInt(BridgeFrames.MAX_BYTES + 1)
        assertThrows(IllegalArgumentException::class.java) {
            BridgeFrames.read(DataInputStream(ByteArrayInputStream(invalid.toByteArray())))
        }
    }

    private val sessions = mutableMapOf<Peer, Pair<String, ByteArray>>()

    private fun authenticate(protocol: BridgeProtocol, store: Store, peer: Peer): Pair<String, ByteArray> {
        protocol.onOpen(peer)
        val nonce = CryptoBox.randomBytes(16)
        protocol.onMessage(peer, JSONObject().put("type", "AUTH_INIT").put("deviceId", store.deviceId)
            .put("clientId", store.pairing!!.clientId).put("clientNonce", CryptoBox.encode(nonce))
            .put("timestamp", System.currentTimeMillis()).toString())
        val challenge = peer.messages.last()
        val sessionId = challenge.getString("sessionId")
        val key = CryptoBox.sessionKey(store.pairing!!.key, nonce, CryptoBox.decode(challenge.getString("serverNonce")), sessionId)
        val session = sessionId to key
        sessions[peer] = session
        send(protocol, store, peer, session, 1, "ACK", JSONObject().put("kind", "AUTH_OK"))
        return session
    }

    private fun send(protocol: BridgeProtocol, store: Store, peer: Peer, session: Pair<String, ByteArray>,
                     seq: Long, type: String, payload: JSONObject) {
        protocol.onMessage(peer, CryptoBox.encryptEnvelope(type, store.deviceId, session.first, seq,
            System.currentTimeMillis(), payload, session.second).toString())
    }

    private fun protocol(store: Store) = BridgeProtocol(
        hostAddressProvider = { "" }, config = store,
        pairCodeProvider = { PairCodeState("123456", System.currentTimeMillis() + 60_000) },
        pairingAllowed = { true }, notificationAccessProvider = { true },
        onPairingComplete = {}, onArmActivated = {}, onOtpAcknowledged = {}, onStateChanged = {}
    )
}
