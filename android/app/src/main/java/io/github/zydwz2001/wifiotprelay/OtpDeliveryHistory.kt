package io.github.zydwz2001.wifiotprelay

/** Accessed under the server state lock. Retains hashes, never notification text. */
internal class OtpDeliveryHistory {
    private var requestId: String? = null
    private val fingerprints = mutableSetOf<String>()

    fun begin(id: String) {
        if (requestId == id) return
        fingerprints.clear()
        requestId = id
    }

    fun mark(id: String, fingerprint: String): Boolean =
        requestId == id && fingerprints.add(fingerprint)

    fun release(id: String, fingerprint: String) {
        if (requestId == id) fingerprints.remove(fingerprint)
    }

    fun clear() {
        requestId = null
        fingerprints.clear()
    }
}
