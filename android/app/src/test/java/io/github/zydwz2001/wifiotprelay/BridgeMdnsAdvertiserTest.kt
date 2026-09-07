package io.github.zydwz2001.wifiotprelay

import org.junit.Assert.assertEquals
import org.junit.Test

class BridgeMdnsAdvertiserTest {
    @Test
    fun `stable hostname is derived from device UUID`() {
        assertEquals(
            "otp-ca8f82b412b44dc8",
            bridgeDiscoveryHostLabel("CA8F82B4-12B4-4DC8-954F-52B50DB52EA1")
        )
    }
}
