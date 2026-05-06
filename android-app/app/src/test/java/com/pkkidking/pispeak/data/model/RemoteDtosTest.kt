package com.pkkidking.pispeak.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDtosTest {

    @Test
    fun `status response maps route metadata into domain summary`() {
        val response = StatusResponseDto(
            ok = true,
            status = StatusDto(
                speak = SpeakStatusDto(
                    enabled = true,
                    provider = null,
                    configuredProvider = "edge",
                ),
                mono = MonoStatusDto(running = true),
                phone = PhoneStatusDto(enabled = true),
                remote = RemoteStatusDto(
                    enabled = true,
                    port = 8767,
                    defaultTarget = "codex",
                    currentSession = "codex",
                    availableTargets = listOf("codex", "claude"),
                ),
            ),
        )

        val domain = response.toDomain()

        assertTrue(domain.remoteEnabled)
        assertEquals(8767, domain.remotePort)
        assertTrue(domain.speakEnabled)
        assertEquals("edge", domain.speakProvider)
        assertTrue(domain.monoRunning)
        assertTrue(domain.phoneEnabled)
        assertEquals("codex", domain.defaultTarget)
        assertEquals("codex", domain.currentSession)
        assertEquals(listOf("codex", "claude"), domain.availableTargets)
    }

    @Test
    fun `status response defaults missing route metadata safely`() {
        val domain = StatusResponseDto(ok = true, status = StatusDto()).toDomain()

        assertFalse(domain.remoteEnabled)
        assertEquals(null, domain.remotePort)
        assertEquals(null, domain.defaultTarget)
        assertEquals(null, domain.currentSession)
        assertTrue(domain.availableTargets.isEmpty())
    }

    @Test
    fun `summary text prefers default target over session name`() {
        val summary = StatusResponseDto(
            ok = true,
            status = StatusDto(
                remote = RemoteStatusDto(
                    enabled = true,
                    port = 8767,
                    defaultTarget = "hermes",
                    currentSession = "codex",
                    availableTargets = listOf("hermes", "codex"),
                ),
            ),
        ).toDomain()

        assertEquals(
            "Remote on at port 8767. Speak off, mono off, phone off, route hermes.",
            summary.summaryText(),
        )
    }

    @Test
    fun `text turn request can carry launch cwd`() {
        val request = TextTurnRequestDto(
            text = "build it",
            audio = true,
            target = "codex",
            cwd = "C:\\dev\\Desktop-Projects\\pi-speak-extension",
        )

        assertEquals("C:\\dev\\Desktop-Projects\\pi-speak-extension", request.cwd)
    }
}
