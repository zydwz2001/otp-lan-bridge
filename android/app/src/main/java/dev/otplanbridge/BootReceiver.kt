package dev.otplanbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED || !ConfigStore(context).bridgeEnabled) return
        try {
            context.startForegroundService(
                Intent(context, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_START)
            )
        } catch (_: Exception) {
            // Android/vendor restrictions can block boot starts; the app status page explains recovery.
        }
    }
}
