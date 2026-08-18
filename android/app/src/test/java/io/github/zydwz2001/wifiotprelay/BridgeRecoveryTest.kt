package io.github.zydwz2001.wifiotprelay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeRecoveryTest {
    @Test
    fun `does not restart when transfer is stopped or browser is online`() {
        assertFalse(shouldRestartBridge(false, true, false, Long.MAX_VALUE, Long.MAX_VALUE))
        assertFalse(shouldRestartBridge(true, true, true, Long.MAX_VALUE, Long.MAX_VALUE))
    }

    @Test
    fun `immediately recovers a missing server`() {
        assertTrue(shouldRestartBridge(true, false, false, 0, 0))
    }

    @Test
    fun `restarts a running server only after a sustained offline period`() {
        assertFalse(shouldRestartBridge(true, true, false, BRIDGE_OFFLINE_RECOVERY_MS - 1, Long.MAX_VALUE))
        assertFalse(shouldRestartBridge(true, true, false, BRIDGE_OFFLINE_RECOVERY_MS, BRIDGE_OFFLINE_RECOVERY_MS - 1))
        assertTrue(shouldRestartBridge(true, true, false, BRIDGE_OFFLINE_RECOVERY_MS, BRIDGE_OFFLINE_RECOVERY_MS))
    }
}
