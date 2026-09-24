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
    fun `recovers a notification arriving long after the first two seconds without a callback`() {
        val fixture = ReplayFixture()
        fixture.loop.start()
        fixture.advanceTo(30_000L)
        fixture.notificationAvailable = true
        fixture.advanceTo(31_000L)
        assertEquals(listOf(31_000L), fixture.recoveredAt)
    }

    @Test
    fun `keeps checking after a notification initially has no readable content`() {
        val fixture = ReplayFixture()
        fixture.loop.start()
        fixture.advanceTo(10_000L)
        fixture.notificationAvailable = true
        fixture.advanceTo(11_000L)
        assertEquals(listOf(11_000L), fixture.recoveredAt)
    }

    @Test
    fun `cancellation and expiry stop reading and release the capture resources`() {
        for (cancel in listOf(false, true)) {
            val fixture = ReplayFixture()
            fixture.loop.start()
            fixture.advanceTo(1_000L)
            if (cancel) fixture.arm = null else fixture.arm = fixture.arm?.copy(expiresAt = 2_000L)
            val readsBeforeStop = fixture.reads
            fixture.advanceTo(60_000L)
            assertEquals(readsBeforeStop, fixture.reads)
            assertTrue(fixture.stopped)
            assertTrue(fixture.tasks.isEmpty())
        }
    }

    @Test
    fun `rearming the same request does not create parallel polling loops`() {
        val fixture = ReplayFixture()
        repeat(10) { fixture.loop.start() }
        assertEquals(1, fixture.tasks.size)
        fixture.advanceTo(3_000L)
        assertEquals(1, fixture.tasks.size)
    }

    @Test
    fun `disconnected wait can resume with the same request`() {
        val fixture = ReplayFixture()
        val original = fixture.arm
        fixture.loop.start()
        fixture.arm = null
        fixture.advanceTo(1_000L)
        fixture.arm = original
        fixture.notificationAvailable = true
        fixture.loop.start()
        assertEquals(listOf(1_000L), fixture.recoveredAt)
    }

    @Test
    fun `temporary snapshot failure does not stop recovery`() {
        val fixture = ReplayFixture()
        fixture.failRead = true
        fixture.loop.start()
        fixture.failRead = false
        fixture.notificationAvailable = true
        fixture.advanceTo(1_000L)
        assertEquals(listOf(1_000L), fixture.recoveredAt)
    }

    @Test
    fun `listener destruction cancels pending work`() {
        val fixture = ReplayFixture()
        fixture.loop.start()
        fixture.loop.stop()
        fixture.notificationAvailable = true
        fixture.advanceTo(60_000L)
        assertTrue(fixture.recoveredAt.isEmpty())
        assertTrue(fixture.stopped)
    }

    private class ReplayFixture {
        var now = 0L
        var arm: ArmSession? = ArmSession("request", 0L, 300_000L, setOf(6), "test")
        var notificationAvailable = false
        var failRead = false
        var reads = 0
        var stopped = false
        val recoveredAt = mutableListOf<Long>()
        val tasks = mutableListOf<Pair<Long, Runnable>>()
        val loop = NotificationReplayLoop(
            captureSession = { arm?.takeIf { it.expiresAt > now } },
            replay = {
                reads++
                if (failRead) throw IllegalStateException("Temporary notification service failure")
                if (notificationAvailable) {
                    recoveredAt += now
                    notificationAvailable = false
                }
            },
            schedule = { task, delay -> tasks += now + delay to task },
            cancel = { task -> tasks.removeAll { it.second === task } },
            onStopped = { stopped = true }
        )

        fun advanceTo(target: Long) {
            while (true) {
                val next = tasks.minByOrNull { it.first }?.takeIf { it.first <= target } ?: break
                tasks.remove(next)
                now = next.first
                next.second.run()
            }
            now = target
        }
    }
}
