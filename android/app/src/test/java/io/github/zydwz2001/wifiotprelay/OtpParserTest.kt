package io.github.zydwz2001.wifiotprelay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OtpParserTest {
    @Test
    fun extractsChineseOtp() {
        val result = OtpParser.parse("【示例】验证码 483921，5 分钟内有效，请勿泄露。")
        assertEquals("483921", (result as OtpParseResult.Match).code)
    }

    @Test
    fun extractsShortChineseNotificationOtp() {
        val result = OtpParser.parse("杰瑞股份 | 验证码\n328467")
        assertEquals("328467", (result as OtpParseResult.Match).code)
    }

    @Test
    fun extractsOtpFromVendorAdditionalNotificationText() {
        val payload = NotificationPayload(
            packageName = "com.android.mms",
            notificationKey = "test",
            postedAt = 1L,
            title = "杰瑞股份 | 验证码",
            text = null,
            bigText = null,
            textLines = emptyList(),
            additionalTexts = listOf("338328")
        )
        val result = OtpParser.parse(payload.combinedText())
        assertEquals("338328", (result as OtpParseResult.Match).code)
    }

    @Test
    fun extractsEnglishOtp() {
        val result = OtpParser.parse("Your verification code is 7254. Do not share it.")
        assertEquals("7254", (result as OtpParseResult.Match).code)
    }

    @Test
    fun extractsEightDigitOtp() {
        val result = OtpParser.parse("Your verification code is 72548319. Do not share it.")
        assertEquals("72548319", (result as OtpParseResult.Match).code)
    }

    @Test
    fun rejectsHighRiskMessages() {
        assertTrue(OtpParser.parse("银行支付验证码 667788") is OtpParseResult.HighRisk)
    }

    @Test
    fun acceptsRecruitmentSystemCodesFromBankSender() {
        val login = "光大银行\n95595\n【光大银行】验证码：246810，序号02，用途：您正在光大银行招聘管理系统，进行系统登录，切勿泄露。"
        val inquiry = "【光大银行】验证码：384921，序号07，用途：您正在光大银行招聘管理系统，进行信息查询，切勿泄露。"
        assertEquals("246810", (OtpParser.parse(login) as OtpParseResult.Match).code)
        assertEquals("384921", (OtpParser.parse(inquiry) as OtpParseResult.Match).code)
    }

    @Test
    fun stillRejectsBankMessagesOutsideRecruitmentAndTransactions() {
        assertTrue(OtpParser.parse("【光大银行】登录验证码 246810") is OtpParseResult.HighRisk)
        assertTrue(OtpParser.parse("【光大银行】招聘管理系统支付验证码 246810，用于系统登录") is OtpParseResult.HighRisk)
        assertTrue(OtpParser.parse("【其他银行】验证码 246810，用于其他银行招聘管理系统登录") is OtpParseResult.HighRisk)
    }

    @Test
    fun doesNotTreatPhoneNumberAsOtp() {
        assertTrue(OtpParser.parse("联系电话 13800138000") is OtpParseResult.NoConfidentCandidate)
    }

    @Test
    fun reportsEquallyStrongCandidates() {
        val result = OtpParser.parse("验证码 123456，备用验证码 654321")
        assertTrue(result is OtpParseResult.Ambiguous)
    }

    @Test
    fun respectsExpectedLength() {
        assertTrue(OtpParser.parse("验证码 123456", setOf(4)) is OtpParseResult.NoConfidentCandidate)
    }
}
