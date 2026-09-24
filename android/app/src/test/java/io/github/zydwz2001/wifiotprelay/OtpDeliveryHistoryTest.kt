package io.github.zydwz2001.wifiotprelay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OtpDeliveryHistoryTest {
    @Test
    fun `five minutes of polling and reconnects do not redeliver an acknowledged notification`() {
        val history = OtpDeliveryHistory()
        history.begin("wait-1")
        assertTrue(history.mark("wait-1", "notification-code-hash"))
        repeat(300) {
            history.begin("wait-1")
            assertFalse(history.mark("wait-1", "notification-code-hash"))
        }
        assertTrue(history.mark("wait-1", "new-code-hash"))
    }

    @Test
    fun `failed send can retry and new wait has its own delivery history`() {
        val history = OtpDeliveryHistory()
        history.begin("wait-1")
        assertTrue(history.mark("wait-1", "hash"))
        history.release("wait-1", "hash")
        assertTrue(history.mark("wait-1", "hash"))
        history.begin("wait-2")
        assertTrue(history.mark("wait-2", "hash"))
        history.release("wait-1", "hash")
        assertFalse(history.mark("wait-2", "hash"))
        assertFalse(history.mark("wait-1", "other-hash"))
        history.clear()
        assertFalse(history.mark("wait-2", "other-hash"))
    }
}
