package dev.otplanbridge

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkSecurityTest {
    @Test
    fun acceptsLocalAndTailscalePeers() {
        assertTrue(isAllowedBridgePeer(InetAddress.getByName("127.0.0.1")))
        assertTrue(isAllowedBridgePeer(InetAddress.getByName("192.168.31.38")))
        assertTrue(isAllowedBridgePeer(InetAddress.getByName("100.64.0.1")))
        assertTrue(isAllowedBridgePeer(InetAddress.getByName("100.127.255.254")))
    }

    @Test
    fun rejectsPublicAndOutOfRangePeers() {
        assertFalse(isAllowedBridgePeer(InetAddress.getByName("8.8.8.8")))
        assertFalse(isAllowedBridgePeer(InetAddress.getByName("100.63.255.255")))
        assertFalse(isAllowedBridgePeer(InetAddress.getByName("100.128.0.1")))
    }

    @Test
    fun advertisesTailscaleBeforeWifiWhenVpnIsActive() {
        val selected = selectBridgeAddress(
            listOf(
                InetAddress.getByName("192.168.1.23"),
                InetAddress.getByName("100.64.0.10")
            )
        )
        assertEquals("100.64.0.10", selected?.hostAddress)
    }
}
