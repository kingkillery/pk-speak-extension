package com.pkkidking.pispeak.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PrivacyRedactorTest {
    @Test
    fun `redacts bearer and query tokens`() {
        val redacted = PrivacyRedactor.redact(
            "Authorization: Bearer abc.def? token=secret https://host/setup?token=also-secret",
        )

        assertFalse(redacted.contains("abc.def"))
        assertFalse(redacted.contains("secret"))
        assertEquals(
            "Authorization: Bearer [redacted] token=[redacted] https://host/setup?token=[redacted]",
            redacted,
        )
    }
}
