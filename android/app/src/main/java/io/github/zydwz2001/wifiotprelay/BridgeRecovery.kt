package io.github.zydwz2001.wifiotprelay

internal const val BRIDGE_OFFLINE_RECOVERY_MS = 5 * 60 * 1000L

internal fun shouldRestartBridge(
    bridgeEnabled: Boolean,
    serverRunning: Boolean,
    clientOnline: Boolean,
    offlineForMs: Long,
    sinceLastRecoveryMs: Long
): Boolean {
    if (!bridgeEnabled || clientOnline) return false
    if (!serverRunning) return true
    return offlineForMs >= BRIDGE_OFFLINE_RECOVERY_MS &&
        sinceLastRecoveryMs >= BRIDGE_OFFLINE_RECOVERY_MS
}
