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
            "Use an HTTPS base URL. HTTP is only allowed for local debug, approved Tailscale, or Bluetooth local-link endpoints.",
            settings.validate(allowInsecureLoopback = false),
        )
    }

    @Test
    fun `debug loopback http is accepted`() {
        val settings = AppSettings(
            baseUrl = "http://127.0.0.1:8767/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
        )

        assertNull(settings.validate(allowInsecureLoopback = true))
    }

    @Test
    fun `tailscale appserver http is accepted`() {
        val settings = AppSettings(
            baseUrl = "http://100.76.136.91:8767/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
        )

        assertNull(settings.validate(allowInsecureLoopback = false))
    }

    @Test
    fun `tailscale mac http is accepted`() {
        val settings = AppSettings(
            baseUrl = "http://100.76.176.119:8767/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
        )

        assertNull(settings.validate(allowInsecureLoopback = false))
    }

    @Test
    fun `bluetooth local-link http is accepted when bluetooth mode is selected`() {
        val settings = AppSettings(
            baseUrl = "http://192.168.44.12:8767/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
            connectionMode = ConnectionMode.BLUETOOTH,
        )

        assertNull(settings.validate(allowInsecureLoopback = false))
    }

    @Test
    fun `approved owner lan http is accepted`() {
        val settings = AppSettings(
            baseUrl = "http://10.0.0.117:8767/",
            token = "token",
            requestAudioReplies = true,
            autoplayReplyAudio = true,
        )

        assertNull(settings.validate(allowInsecureLoopback = false))
    }

    @Test
    fun `default machine profiles include selectable appserver mac and bluetooth targets`() {
        assertEquals("tailscale-appserver", DefaultMachineProfiles[0].id)
        assertEquals("MSI / appserver", DefaultMachineProfiles[0].name)
        assertEquals("http://100.76.136.91:8767/", DefaultMachineProfiles[0].baseUrl)
        assertEquals("", DefaultMachineProfiles[0].token)
        assertEquals(ConnectionMode.TAILSCALE, DefaultMachineProfiles[0].connectionMode)
        assertEquals("tailscale-mac", DefaultMachineProfiles[1].id)
        assertEquals("Mac", DefaultMachineProfiles[1].name)
        assertEquals("http://100.76.176.119:8767/", DefaultMachineProfiles[1].baseUrl)
        assertEquals("", DefaultMachineProfiles[1].token)
        assertEquals(ConnectionMode.TAILSCALE, DefaultMachineProfiles[1].connectionMode)
        assertEquals("lan-msi", DefaultMachineProfiles[2].id)
        assertEquals("MSI / LAN", DefaultMachineProfiles[2].name)
        assertEquals("http://10.0.0.117:8767/", DefaultMachineProfiles[2].baseUrl)
        assertEquals("", DefaultMachineProfiles[2].token)
        assertEquals(ConnectionMode.MANUAL, DefaultMachineProfiles[2].connectionMode)
        assertEquals("bluetooth-local", DefaultMachineProfiles[3].id)
        assertEquals("Bluetooth / local link", DefaultMachineProfiles[3].name)
        assertEquals("http://192.168.44.1:8767/", DefaultMachineProfiles[3].baseUrl)
        assertEquals("", DefaultMachineProfiles[3].token)
        assertEquals(ConnectionMode.BLUETOOTH, DefaultMachineProfiles[3].connectionMode)
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
