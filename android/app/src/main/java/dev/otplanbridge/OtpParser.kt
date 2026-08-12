package dev.otplanbridge

import kotlin.math.max
import kotlin.math.min

object OtpParser {
    private val candidateRegex = Regex("(?<!\\d)\\d{4,8}(?!\\d)")
    private val positiveKeywords = listOf(
        "验证码", "校验码", "动态码", "短信码", "确认码", "otp", "one-time", "verification code", "security code", "code"
    )
    private val supportingKeywords = listOf(
        "有效", "分钟", "请勿泄露", "不要泄露", "expires", "valid", "do not share", "never share"
    )
    private val riskKeywords = listOf(
        "银行", "支付", "付款", "钱包", "转账", "交易", "bank", "payment", "wallet", "transfer", "transaction"
    )
    private val negativeNearby = listOf(
        "订单", "单号", "金额", "人民币", "元", "order", "amount", "cny", "usd", "日期", "时间"
    )

    fun parse(text: String, expectedDigits: Set<Int> = setOf(4, 5, 6), threshold: Double = 0.68): OtpParseResult {
        val normalized = text.trim()
        if (normalized.isEmpty()) return OtpParseResult.NoContent
        val lower = normalized.lowercase()
        if (riskKeywords.any(lower::contains)) return OtpParseResult.HighRisk

        val candidates = candidateRegex.findAll(normalized)
            .filter { expectedDigits.isEmpty() || it.value.length in expectedDigits }
            .map { match -> score(normalized, match.range.first, match.range.last + 1, match.value) }
            .filter { it.second >= threshold }
            .toList()

        if (candidates.isEmpty()) return OtpParseResult.NoConfidentCandidate
        val maxScore = candidates.maxOf { it.second }
        val winners = candidates
            .filter { maxScore - it.second < 0.0001 }
            .map { it.first }
            .distinct()

        return if (winners.size == 1) {
            OtpParseResult.Match(winners.first(), maxScore.coerceAtMost(0.99))
        } else {
            OtpParseResult.Ambiguous(winners, maxScore.coerceAtMost(0.99))
        }
    }

    private fun score(text: String, start: Int, end: Int, code: String): Pair<String, Double> {
        val contextStart = max(0, start - 36)
        val contextEnd = min(text.length, end + 36)
        val context = text.substring(contextStart, contextEnd).lowercase()
        var score = 0.36

        if (positiveKeywords.any(context::contains)) score += 0.42
        if (supportingKeywords.any(context::contains)) score += 0.10
        if (code.length == 6) score += 0.07
        if (negativeNearby.any(context::contains)) score -= 0.36
        if (looksLikeDateOrTime(text, start, end)) score -= 0.5
        if (looksLikeMoney(text, start, end)) score -= 0.45

        return code to score.coerceIn(0.0, 1.0)
    }

    private fun looksLikeDateOrTime(text: String, start: Int, end: Int): Boolean {
        val around = text.substring(max(0, start - 2), min(text.length, end + 2))
        return Regex("\\d{2,4}[-/.年]\\d{1,2}").containsMatchIn(around) ||
            Regex("\\d{1,2}:\\d{2}").containsMatchIn(around)
    }

    private fun looksLikeMoney(text: String, start: Int, end: Int): Boolean {
        val around = text.substring(max(0, start - 4), min(text.length, end + 4)).lowercase()
        return Regex("(?:¥|￥|\\$|usd|cny)\\s*\\d|\\d+(?:\\.\\d{1,2})?\\s*(?:元|美元)").containsMatchIn(around)
    }
}
