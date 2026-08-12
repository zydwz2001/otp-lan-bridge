package dev.otplanbridge

data class NotificationPayload(
    val packageName: String,
    val notificationKey: String,
    val postedAt: Long,
    val title: String?,
    val text: String?,
    val bigText: String?,
    val textLines: List<String>,
    val additionalTexts: List<String> = emptyList()
) {
    fun combinedText(): String = listOfNotNull(title, text, bigText)
        .plus(textLines)
        .plus(additionalTexts)
        .map(String::trim)
        .filter(String::isNotBlank)
        .distinct()
        .joinToString("\n")
}

data class ArmSession(
    val requestId: String,
    val createdAt: Long,
    val expiresAt: Long,
    val expectedDigits: Set<Int>,
    val siteLabel: String
)

data class PairCodeState(val code: String, val expiresAt: Long)

sealed interface OtpParseResult {
    data object NoContent : OtpParseResult
    data object HighRisk : OtpParseResult
    data object NoConfidentCandidate : OtpParseResult
    data class Match(val code: String, val confidence: Double) : OtpParseResult
    data class Ambiguous(val candidates: List<String>, val confidence: Double) : OtpParseResult
}

data class BridgeSnapshot(
    val enabled: Boolean,
    val running: Boolean,
    val notificationListenerConnected: Boolean,
    val boundAddress: String?,
    val port: Int,
    val clientOnline: Boolean,
    val paired: Boolean,
    val pairCode: String?,
    val pairCodeExpiresAt: Long?,
    val diagnostic: String,
    val lastObservedNotificationPackage: String?,
    val lastCode: String?,
    val lastCodeAt: Long?
)
