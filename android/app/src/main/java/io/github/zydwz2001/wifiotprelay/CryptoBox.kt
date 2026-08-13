package io.github.zydwz2001.wifiotprelay

import android.util.Base64
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object CryptoBox {
    private val secureRandom = SecureRandom()

    fun randomBytes(size: Int): ByteArray = ByteArray(size).also(secureRandom::nextBytes)

    fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP)

    fun decode(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)

    fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

    fun hmac(key: ByteArray, value: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(value)
    }

    fun constantTimeEquals(left: ByteArray, right: ByteArray): Boolean = MessageDigest.isEqual(left, right)

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val effectiveSalt = if (salt.isEmpty()) ByteArray(32) else salt
        val prk = hmac(effectiveSalt, ikm)
        val result = ByteArray(length)
        var previous = ByteArray(0)
        var written = 0
        var counter = 1
        while (written < length) {
            previous = hmac(prk, previous + info + byteArrayOf(counter.toByte()))
            val amount = minOf(previous.size, length - written)
            previous.copyInto(result, written, 0, amount)
            written += amount
            counter++
        }
        return result
    }

    fun generateEcdhKeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"), secureRandom)
        generateKeyPair()
    }

    fun deriveEcdh(privateKeyPair: KeyPair, peerSpki: ByteArray): ByteArray {
        val peerKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(peerSpki))
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKeyPair.private)
        agreement.doPhase(peerKey, true)
        return agreement.generateSecret()
    }

    fun pairingKey(sharedSecret: ByteArray, pairCode: String): ByteArray = hkdf(
        sharedSecret,
        sha256(pairCode.toByteArray(StandardCharsets.UTF_8)),
        "wifi-otp-relay/pairing/v1".toByteArray(StandardCharsets.UTF_8)
    )

    fun sessionKey(pairingKey: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray, sessionId: String): ByteArray = hkdf(
        pairingKey,
        clientNonce + serverNonce,
        "wifi-otp-relay/session/v1|$sessionId".toByteArray(StandardCharsets.UTF_8)
    )

    fun encryptEnvelope(
        type: String,
        deviceId: String,
        sessionId: String,
        seq: Long,
        timestamp: Long,
        payload: JSONObject,
        key: ByteArray
    ): JSONObject {
        val nonce = randomBytes(12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(type, deviceId, sessionId, seq, timestamp))
        val ciphertext = cipher.doFinal(payload.toString().toByteArray(StandardCharsets.UTF_8))
        return JSONObject()
            .put("v", 1)
            .put("type", type)
            .put("deviceId", deviceId)
            .put("sessionId", sessionId)
            .put("seq", seq)
            .put("timestamp", timestamp)
            .put("nonce", encode(nonce))
            .put("ciphertext", encode(ciphertext))
    }

    fun decryptEnvelope(envelope: JSONObject, key: ByteArray): JSONObject {
        require(envelope.getInt("v") == 1) { "Unsupported protocol version" }
        val type = envelope.getString("type")
        val deviceId = envelope.getString("deviceId")
        val sessionId = envelope.getString("sessionId")
        val seq = envelope.getLong("seq")
        val timestamp = envelope.getLong("timestamp")
        val nonce = decode(envelope.getString("nonce"))
        require(nonce.size == 12) { "Invalid nonce" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(type, deviceId, sessionId, seq, timestamp))
        return JSONObject(String(cipher.doFinal(decode(envelope.getString("ciphertext"))), StandardCharsets.UTF_8))
    }

    fun pairingProofMessage(clientPublicKey: String, serverPublicKey: String, deviceId: String, clientId: String): ByteArray =
        "$clientPublicKey|$serverPublicKey|$deviceId|$clientId".toByteArray(StandardCharsets.UTF_8)

    fun authProofMessage(
        deviceId: String,
        clientId: String,
        sessionId: String,
        clientNonce: String,
        serverNonce: String
    ): ByteArray = "$deviceId|$clientId|$sessionId|$clientNonce|$serverNonce".toByteArray(StandardCharsets.UTF_8)

    fun fingerprint(parts: List<String>): String {
        val digest = sha256(parts.joinToString("|").toByteArray(StandardCharsets.UTF_8))
        return encode(digest.copyOfRange(0, 16))
    }

    private fun aad(type: String, deviceId: String, sessionId: String, seq: Long, timestamp: Long): ByteArray =
        "1|$type|$deviceId|$sessionId|$seq|$timestamp".toByteArray(StandardCharsets.UTF_8)
}
