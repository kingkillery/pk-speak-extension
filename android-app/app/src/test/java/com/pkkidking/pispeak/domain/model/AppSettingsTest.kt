package com.pkkidking.pispeak.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppSettingsTest {

    @Test
    fun `https base urls are accepted for production use`() {
        val settings = AppSettings(
            baseUrl = "https://pi.example.com/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
        )

        assertNull(settings.validate(allowInsecureLoopback = false))
    }

    @Test
    fun `http is rejected outside debug loopback`() {
        val settings = AppSettings(
            baseUrl = "http://192.168.1.20:8767/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
        )

        assertEquals(
            "Use an HTTPS base URL. HTTP is only allowed for local debug endpoints.",
            settings.validate(allowInsecureLoopback = false),
        )
    }

    @Test
    fun `debug loopback http is accepted`() {
        val settings = AppSettings(
            baseUrl = "http://10.0.2.2:8767/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
        )

        assertNull(settings.validate(allowInsecureLoopback = true))
    }

    @Test
    fun `workspace path is optional and does not affect connection validation`() {
        val settings = AppSettings(
            baseUrl = "https://pi.example.com/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
            workspacePath = "C:\\dev\\Desktop-Projects\\pi-speak-extension",
        )

        assertNull(settings.validate(allowInsecureLoopback = false))
    }
}
