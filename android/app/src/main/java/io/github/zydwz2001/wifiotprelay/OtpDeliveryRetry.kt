package io.github.zydwz2001.wifiotprelay

internal const val OTP_DELIVERY_RETRY_MS = 5_000L

internal fun shouldRetryOtpDelivery(now: Long, expiresAt: Long, lastSentAt: Long): Boolean =
    expiresAt > now && (lastSentAt == 0L || now - lastSentAt >= OTP_DELIVERY_RETRY_MS)
