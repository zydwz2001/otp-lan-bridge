package io.github.zydwz2001.wifiotprelay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BridgeBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED && intent?.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!ConfigStore(context).bridgeEnabled) return
        try {
            context.startForegroundService(
                Intent(context, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_START)
            )
        } catch (_: Exception) {
            // Vendor background policies can still require the user to open the
            // app once after a reboot; the normal launcher path starts it again.
        }
    }
}
