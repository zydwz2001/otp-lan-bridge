package io.github.zydwz2001.wifiotprelay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationReplayTest {
    @Test
    fun `replays notifications from the arm race window`() {
        val armCreatedAt = 10_000L
        val earliestPostTime = armCreatedAt - 5_000L

        assertTrue(shouldReplayActiveNotification(9_999L, earliestPostTime))
        assertTrue(shouldReplayActiveNotification(armCreatedAt, earliestPostTime))
        assertFalse(shouldReplayActiveNotification(4_999L, earliestPostTime))
    }

    @Test
    fun `checks active notifications through the listener rebind window`() {
        assertEquals(listOf(0L, 750L, 2_000L), NOTIFICATION_REPLAY_DELAYS_MS)
    }
}
