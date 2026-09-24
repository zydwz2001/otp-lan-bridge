package io.github.zydwz2001.wifiotprelay

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import java.io.FileDescriptor
import java.io.PrintWriter

class OtpNotificationListener : NotificationListenerService() {
    private val coordinator get() = (application as BridgeApplication).coordinator
    private val handler = Handler(Looper.getMainLooper())
    private var captureWakeLock: PowerManager.WakeLock? = null
    private var wakeLockRequestId: String? = null
    private var snapshotReadCount = 0L
    private var snapshotReadFailureCount = 0L
    private var smsCallbackCount = 0L
    private var lastSmsCallbackAt = 0L
    private var lastSnapshotSmsPostTime = 0L
    private val replayLoop = NotificationReplayLoop(
        captureSession = { if (activeInstance === this && isConnected) coordinator.captureSession() else null },
        replay = { arm ->
            keepCaptureAwake(arm)
            replayActiveNotifications(arm.createdAt - NOTIFICATION_RACE_WINDOW_MS)
        },
        schedule = { task, delay -> handler.postDelayed(task, delay) },
        cancel = { handler.removeCallbacks(it) },
        onStopped = { releaseCaptureWakeLock() }
    )

    override fun onListenerConnected() {
        super.onListenerConnected()
        activeInstance = this
        isConnected = true
        disconnectedSinceElapsedRealtime = 0L
        coordinator.onNotificationAccessMayHaveChanged()
        replayLoop.start()
    }

    override fun onListenerDisconnected() {
        replayLoop.stop()
        if (markDisconnected(this)) {
            coordinator.onNotificationAccessMayHaveChanged()
            requestReconnect(this)
        }
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        replayLoop.stop()
        markDisconnected(this)
        super.onDestroy()
    }

    override fun onNotificationPosted(statusBarNotification: StatusBarNotification) {
        if (statusBarNotification.packageName == coordinator.selectedSmsPackage()) {
            smsCallbackCount++
            lastSmsCallbackAt = System.currentTimeMillis()
        }
        inspectNotification(statusBarNotification)
    }

    private fun inspectNotification(statusBarNotification: StatusBarNotification) {
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

    private fun replayActiveNotifications(earliestPostTime: Long) {
        try {
            snapshotReadCount++
            activeNotifications.orEmpty()
                .asSequence()
                .filter { it.packageName == coordinator.selectedSmsPackage() }
                .filter { shouldReplayActiveNotification(it.postTime, earliestPostTime) }
                .sortedBy { it.postTime }
                .forEach {
                    lastSnapshotSmsPostTime = it.postTime
                    inspectNotification(it)
                }
        } catch (_: Exception) {
            snapshotReadFailureCount++
            // Some vendor builds briefly deny access while the listener is rebinding.
        }
    }

    override fun dump(fd: FileDescriptor, writer: PrintWriter, args: Array<out String>) {
        // Timing/counters only: never include OTPs, notification keys or bodies.
        writer.println("listenerConnected=$isConnected")
        writer.println("captureActive=${coordinator.captureSession() != null}")
        writer.println("captureWakeLockHeld=${captureWakeLock?.isHeld == true}")
        writer.println("snapshotReads=$snapshotReadCount snapshotFailures=$snapshotReadFailureCount")
        writer.println("smsCallbacks=$smsCallbackCount lastSmsCallbackAt=$lastSmsCallbackAt")
        writer.println("lastSnapshotSmsPostTime=$lastSnapshotSmsPostTime")
        writer.println("diagnostic=${coordinator.snapshot().diagnostic}")
    }

    private fun keepCaptureAwake(arm: ArmSession) {
        if (captureWakeLock?.isHeld == true && wakeLockRequestId == arm.requestId) return
        releaseCaptureWakeLock()
        val remaining = (arm.expiresAt - System.currentTimeMillis()).coerceIn(1L, 5 * 60_000L)
        captureWakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wifiotprelay:otp-wait")
            .apply {
                setReferenceCounted(false)
                // Never illuminate/unlock the screen; Android also releases this
                // lock at expiry if our cancellation callback cannot run.
                acquire(remaining)
            }
        wakeLockRequestId = arm.requestId
    }

    private fun releaseCaptureWakeLock() {
        captureWakeLock?.let { if (it.isHeld) it.release() }
        captureWakeLock = null
        wakeLockRequestId = null
    }

    companion object {
        private const val MAX_BUNDLE_DEPTH = 4
        private const val MAX_TEXT_PARTS = 64
        private const val MAX_TEXT_LENGTH = 4_096

        @Volatile
        var isConnected: Boolean = false
            private set

        @Volatile
        private var activeInstance: OtpNotificationListener? = null

        @Volatile
        private var disconnectedSinceElapsedRealtime: Long = SystemClock.elapsedRealtime()

        @Volatile
        private var lastForcedReconnectAt: Long = 0L

        fun recoverRecentNotifications(context: Context) {
            if (!isConnected) {
                try {
                    requestReconnect(context, force = true)
                } catch (_: Exception) {
                    // The foreground service keeps retrying the listener binding.
                }
            }
            Handler(Looper.getMainLooper()).post { activeInstance?.replayLoop?.start() }
        }

        fun disconnectedForMs(now: Long = SystemClock.elapsedRealtime()): Long =
            if (isConnected) 0L else (now - disconnectedSinceElapsedRealtime).coerceAtLeast(0L)

        fun requestReconnect(context: Context, force: Boolean = false) {
            val component = ComponentName(context, OtpNotificationListener::class.java)
            val now = SystemClock.elapsedRealtime()
            if (force && Build.VERSION.SDK_INT >= 34 &&
                (lastForcedReconnectAt == 0L || now - lastForcedReconnectAt >= FORCE_RECONNECT_COOLDOWN_MS)
            ) {
                lastForcedReconnectAt = now
                try {
                    // Android 14+ can recycle a stale listener binding without
                    // asking the user to switch notification access off and on.
                    NotificationListenerService.requestUnbind(component)
                    Handler(Looper.getMainLooper()).postDelayed(
                        { NotificationListenerService.requestRebind(component) },
                        FORCE_REBIND_DELAY_MS
                    )
                    return
                } catch (_: Exception) {
                    // Fall back to the regular host-managed rebind request.
                }
            }
            NotificationListenerService.requestRebind(component)
        }

        @Synchronized
        private fun markDisconnected(instance: OtpNotificationListener): Boolean {
            // A delayed onDestroy from an old binding must not overwrite the
            // state of a newer listener instance that is already connected.
            if (activeInstance != null && activeInstance !== instance) return false
            activeInstance = null
            isConnected = false
            if (disconnectedSinceElapsedRealtime == 0L) {
                disconnectedSinceElapsedRealtime = SystemClock.elapsedRealtime()
            }
            return true
        }

        private const val FORCE_REBIND_DELAY_MS = 750L
        private const val FORCE_RECONNECT_COOLDOWN_MS = 45_000L
    }
}
