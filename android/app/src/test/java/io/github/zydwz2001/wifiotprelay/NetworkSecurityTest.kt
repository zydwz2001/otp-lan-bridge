package io.github.zydwz2001.wifiotprelay

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkSecurityTest {
    @Test
    fun acceptsPrivateWifiPeers() {
        assertTrue(isAllowedBridgePeer(InetAddress.getByName("192.168.31.38")))
        assertTrue(isAllowedBridgePeer(InetAddress.getByName("10.0.0.42")))
        assertTrue(isAllowedBridgePeer(InetAddress.getByName("172.20.10.3")))
    }

    @Test
    fun rejectsPublicAndOutOfRangePeers() {
        assertFalse(isAllowedBridgePeer(InetAddress.getByName("8.8.8.8")))
        assertFalse(isAllowedBridgePeer(InetAddress.getByName("127.0.0.1")))
        assertFalse(isAllowedBridgePeer(InetAddress.getByName("100.64.0.1")))
        assertFalse(isAllowedBridgePeer(InetAddress.getByName("169.254.10.2")))
    }

    @Test
    fun selectsOnlyPrivateWifiAddressFromProvidedWifiLinks() {
        val selected = selectWifiAddress(
            listOf(
                InetAddress.getByName("192.168.1.23"),
                InetAddress.getByName("100.64.0.10")
            )
        )
        assertEquals("192.168.1.23", selected?.hostAddress)
    }
}
