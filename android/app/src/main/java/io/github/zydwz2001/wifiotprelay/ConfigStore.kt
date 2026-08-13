package io.github.zydwz2001.wifiotprelay

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class PairingRecord(val deviceId: String, val clientId: String, val key: ByteArray)

@SuppressLint("ApplySharedPref") // Pairing changes must be durable before a success response is sent.
class ConfigStore(context: Context) {
    private val preferences = context.getSharedPreferences("wifi_relay_config", Context.MODE_PRIVATE)

    var port: Int
        get() = preferences.getInt(KEY_PORT, DEFAULT_PORT)
        set(value) {
            require(value in 1024..65535)
            preferences.edit().putInt(KEY_PORT, value).apply()
        }

    var selectedSmsPackage: String?
        get() = preferences.getString(KEY_SMS_PACKAGE, null)
        set(value) {
            preferences.edit().putString(KEY_SMS_PACKAGE, value).apply()
        }

    var bridgeEnabled: Boolean
        get() = preferences.getBoolean(KEY_ENABLED, false)
        set(value) {
            preferences.edit().putBoolean(KEY_ENABLED, value).apply()
        }

    val deviceId: String
        get() {
            preferences.getString(KEY_DEVICE_ID, null)?.let { return it }
            val created = UUID.randomUUID().toString()
            preferences.edit().putString(KEY_DEVICE_ID, created).commit()
            return created
        }

    @Synchronized
    fun savePairing(clientId: String, key: ByteArray) {
        require(key.size == 32)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateMasterKey())
        val encrypted = cipher.doFinal(key)
        preferences.edit()
            .putString(KEY_CLIENT_ID, clientId)
            .putString(KEY_PAIR_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(KEY_PAIR_SECRET, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .commit()
    }

    @Synchronized
    fun loadPairing(): PairingRecord? {
        val clientId = preferences.getString(KEY_CLIENT_ID, null) ?: return null
        val iv = preferences.getString(KEY_PAIR_IV, null)?.decodeBase64() ?: return null
        val encrypted = preferences.getString(KEY_PAIR_SECRET, null)?.decodeBase64() ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateMasterKey(), GCMParameterSpec(128, iv))
            PairingRecord(deviceId, clientId, cipher.doFinal(encrypted))
        } catch (_: Exception) {
            clearPairing()
            null
        }
    }

    @Synchronized
    fun clearPairing() {
        preferences.edit()
            .remove(KEY_CLIENT_ID)
            .remove(KEY_PAIR_IV)
            .remove(KEY_PAIR_SECRET)
            .commit()
    }

    private fun getOrCreateMasterKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEYSTORE_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private fun String.decodeBase64(): ByteArray = Base64.decode(this, Base64.NO_WRAP)

    companion object {
        const val DEFAULT_PORT = 42871
        private const val KEYSTORE_ALIAS = "wifi_otp_relay_pairing_master_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val KEY_PORT = "port"
        private const val KEY_SMS_PACKAGE = "sms_package"
        private const val KEY_ENABLED = "bridge_enabled"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_CLIENT_ID = "paired_client_id"
        private const val KEY_PAIR_IV = "paired_secret_iv"
        private const val KEY_PAIR_SECRET = "paired_secret"
    }
}
