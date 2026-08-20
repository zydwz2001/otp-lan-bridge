package io.github.zydwz2001.wifiotprelay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OtpDeliveryRetryTest {
    @Test
    fun `retries an unacknowledged code after the retry interval`() {
        val now = 100_000L
        assertFalse(shouldRetryOtpDelivery(now, now + 60_000L, now - OTP_DELIVERY_RETRY_MS + 1L))
        assertTrue(shouldRetryOtpDelivery(now, now + 60_000L, now - OTP_DELIVERY_RETRY_MS))
    }

    @Test
    fun `does not retry an expired code`() {
        assertFalse(shouldRetryOtpDelivery(100_000L, 100_000L, 0L))
    }
}
