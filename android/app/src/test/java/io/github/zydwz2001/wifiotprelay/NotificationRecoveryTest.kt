package io.github.zydwz2001.wifiotprelay

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationRecoveryTest {
    @Test
    fun `does nothing when bridge cannot or need not recover`() {
        assertEquals(NotificationRecoveryAction.NONE, notificationRecoveryAction(false, true, false, 0))
        assertEquals(NotificationRecoveryAction.NONE, notificationRecoveryAction(true, false, false, 0))
        assertEquals(NotificationRecoveryAction.NONE, notificationRecoveryAction(true, true, true, 4))
    }

    @Test
    fun `spaces forced recycle attempts between ordinary rebind requests`() {
        assertEquals(NotificationRecoveryAction.REQUEST_REBIND, notificationRecoveryAction(true, true, false, 0))
        assertEquals(NotificationRecoveryAction.REQUEST_REBIND, notificationRecoveryAction(true, true, false, 1))
        assertEquals(NotificationRecoveryAction.FORCE_REBIND, notificationRecoveryAction(true, true, false, 2))
        assertEquals(NotificationRecoveryAction.REQUEST_REBIND, notificationRecoveryAction(true, true, false, 3))
        assertEquals(NotificationRecoveryAction.FORCE_REBIND, notificationRecoveryAction(true, true, false, 6))
    }
}
