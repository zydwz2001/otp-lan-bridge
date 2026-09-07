package io.github.zydwz2001.wifiotprelay

import android.content.Context
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.util.concurrent.Executors
import javax.jmdns.JmDNS
import javax.jmdns.ServiceInfo

internal class BridgeMdnsAdvertiser(context: Context) {
    private val wifiManager = context.applicationContext.getSystemService(WifiManager::class.java)
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "bridge-mdns").apply { isDaemon = true }
    }

    @Volatile private var generation = 0L
    private var activeDns: JmDNS? = null
    private var activeMulticastLock: WifiManager.MulticastLock? = null

    @Synchronized
    fun start(address: Inet4Address, port: Int, deviceId: String) {
        generation += 1
        val requestedGeneration = generation
        worker.execute {
            closeActive()
            if (generation != requestedGeneration) return@execute

            var dns: JmDNS? = null
            var multicastLock: WifiManager.MulticastLock? = null
            try {
                multicastLock = wifiManager.createMulticastLock("wifi-otp-bridge-mdns").apply {
                    setReferenceCounted(false)
                    acquire()
                }
                val hostLabel = bridgeDiscoveryHostLabel(deviceId)
                dns = JmDNS.create(address, hostLabel)
                dns.registerService(
                    ServiceInfo.create(SERVICE_TYPE, hostLabel, port, "path=/v1/bridge")
                )
                if (generation == requestedGeneration) {
                    synchronized(this) {
                        if (generation == requestedGeneration) {
                            activeDns = dns
                            activeMulticastLock = multicastLock
                            dns = null
                            multicastLock = null
                        }
                    }
                }
            } catch (_: Exception) {
                // Direct IP and same-subnet discovery remain available if mDNS
                // is disabled by the device or access point.
            } finally {
                closeResources(dns, multicastLock)
            }
        }
    }

    @Synchronized
    fun stop() {
        generation += 1
        worker.execute(::closeActive)
    }

    private fun closeActive() {
        val resources = synchronized(this) {
            val result = activeDns to activeMulticastLock
            activeDns = null
            activeMulticastLock = null
            result
        }
        closeResources(resources.first, resources.second)
    }

    private fun closeResources(dns: JmDNS?, multicastLock: WifiManager.MulticastLock?) {
        try { dns?.unregisterAllServices() } catch (_: Exception) { /* already stopped */ }
        try { dns?.close() } catch (_: Exception) { /* already stopped */ }
        try {
            if (multicastLock?.isHeld == true) multicastLock.release()
        } catch (_: Exception) { /* already released */ }
    }

    companion object {
        private const val SERVICE_TYPE = "_wifi-otp._tcp.local."
    }
}

internal fun bridgeDiscoveryHostLabel(deviceId: String): String {
    val stableId = deviceId.lowercase()
        .filter { it in 'a'..'z' || it in '0'..'9' }
        .take(16)
    require(stableId.length >= 8)
    return "otp-$stableId"
}
