package io.github.zydwz2001.wifiotprelay

internal enum class NotificationRecoveryAction {
    NONE,
    REQUEST_REBIND,
    FORCE_REBIND
}

internal fun notificationRecoveryAction(
    bridgeEnabled: Boolean,
    accessGranted: Boolean,
    listenerConnected: Boolean,
    previousAttempts: Int
): NotificationRecoveryAction {
    if (!bridgeEnabled || !accessGranted || listenerConnected) return NotificationRecoveryAction.NONE
    val currentAttempt = previousAttempts + 1
    return if (currentAttempt >= 3 && (currentAttempt - 3) % 4 == 0) {
        NotificationRecoveryAction.FORCE_REBIND
    } else {
        NotificationRecoveryAction.REQUEST_REBIND
    }
}
