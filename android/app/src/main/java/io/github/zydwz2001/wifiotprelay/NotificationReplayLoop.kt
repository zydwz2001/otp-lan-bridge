package io.github.zydwz2001.wifiotprelay

/** Main-thread loop: callbacks are the fast path, snapshots recover missed updates. */
internal class NotificationReplayLoop(
    private val captureSession: () -> ArmSession?,
    private val replay: (ArmSession) -> Unit,
    private val schedule: (Runnable, Long) -> Unit,
    private val cancel: (Runnable) -> Unit,
    private val onStopped: () -> Unit
) : Runnable {
    fun start() {
        cancel(this)
        run()
    }

    override fun run() {
        val arm = captureSession()
        if (arm == null) {
            stop()
            return
        }
        try {
            replay(arm)
        } catch (_: Exception) {
            // Notification access can be temporarily unavailable during a rebind.
        } finally {
            // A temporary vendor error must not terminate recovery for this wait.
            schedule(this, 1_000L)
        }
    }

    fun stop() {
        cancel(this)
        onStopped()
    }
}

internal fun shouldReplayActiveNotification(postedAt: Long, earliestPostTime: Long): Boolean =
    postedAt >= earliestPostTime
