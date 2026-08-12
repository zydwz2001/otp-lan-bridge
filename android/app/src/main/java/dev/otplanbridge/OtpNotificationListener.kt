package dev.otplanbridge

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView

class OtpNotificationListener : NotificationListenerService() {
    private val coordinator get() = (application as BridgeApplication).coordinator

    override fun onListenerConnected() {
        super.onListenerConnected()
        isConnected = true
        coordinator.onNotificationAccessMayHaveChanged()
        try {
            activeNotifications.orEmpty().forEach(::onNotificationPosted)
        } catch (_: Exception) {
            // Some vendor builds briefly deny access while the listener is rebinding.
        }
    }

    override fun onListenerDisconnected() {
        isConnected = false
        coordinator.onNotificationAccessMayHaveChanged()
        requestRebind(ComponentName(this, OtpNotificationListener::class.java))
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        isConnected = false
        super.onDestroy()
    }

    override fun onNotificationPosted(statusBarNotification: StatusBarNotification) {
        val packageName = statusBarNotification.packageName
        val postedAt = statusBarNotification.postTime
        coordinator.noteNotificationObserved(packageName, postedAt)
        if (!coordinator.shouldInspect(packageName, postedAt)) return

        val extras = statusBarNotification.notification.extras
        val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
            ?.map(CharSequence::toString)
            .orEmpty()
        val additionalTexts = extractAdditionalTexts(statusBarNotification.notification)
        coordinator.handleNotification(
            NotificationPayload(
                packageName = packageName,
                notificationKey = statusBarNotification.key,
                postedAt = postedAt,
                title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
                text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
                bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
                textLines = textLines,
                additionalTexts = additionalTexts
            )
        )
    }

    /**
     * MIUI's SMS app can render the message body from MessagingStyle bundles or
     * custom RemoteViews instead of the usual EXTRA_TEXT field. Read those
     * in-memory representations only while an OTP wait session is active.
     */
    private fun extractAdditionalTexts(notification: Notification): List<String> {
        val values = mutableListOf<String>()
        notification.tickerText?.let { addText(values, it) }
        collectBundleTexts(notification.extras, values, 0)
        listOf(notification.contentView, notification.bigContentView, notification.headsUpContentView)
            .distinct()
            .forEach { remoteViews ->
                if (remoteViews == null || values.size >= MAX_TEXT_PARTS) return@forEach
                try {
                    val parent = FrameLayout(this)
                    collectViewTexts(remoteViews.apply(this, parent), values)
                } catch (_: Exception) {
                    // A vendor RemoteViews layout may not be inflatable by a listener.
                }
            }
        return values.distinct()
    }

    private fun collectBundleTexts(bundle: Bundle?, output: MutableList<String>, depth: Int) {
        if (bundle == null || depth > MAX_BUNDLE_DEPTH || output.size >= MAX_TEXT_PARTS) return
        bundle.keySet().forEach { key ->
            if (output.size >= MAX_TEXT_PARTS) return
            collectValueTexts(bundle.get(key), output, depth)
        }
    }

    private fun collectValueTexts(value: Any?, output: MutableList<String>, depth: Int) {
        when (value) {
            is CharSequence -> addText(output, value)
            is Bundle -> collectBundleTexts(value, output, depth + 1)
            is Array<*> -> value.forEach { collectValueTexts(it, output, depth + 1) }
            is Iterable<*> -> value.forEach { collectValueTexts(it, output, depth + 1) }
        }
    }

    private fun collectViewTexts(view: View, output: MutableList<String>) {
        if (output.size >= MAX_TEXT_PARTS) return
        if (view is TextView) addText(output, view.text)
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) collectViewTexts(view.getChildAt(index), output)
        }
    }

    private fun addText(output: MutableList<String>, value: CharSequence?) {
        val text = value?.toString()?.trim().orEmpty()
        if (text.isNotEmpty() && output.size < MAX_TEXT_PARTS) output += text.take(MAX_TEXT_LENGTH)
    }

    companion object {
        private const val MAX_BUNDLE_DEPTH = 4
        private const val MAX_TEXT_PARTS = 64
        private const val MAX_TEXT_LENGTH = 4_096

        @Volatile
        var isConnected: Boolean = false
            private set

        fun requestReconnect(context: Context) {
            requestRebind(ComponentName(context, OtpNotificationListener::class.java))
        }
    }
}
