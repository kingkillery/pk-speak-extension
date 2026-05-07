package com.pkkidking.pispeak.presentation.main

import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainUiStateTest {

    @Test
    fun `defaults start in explicit idle states`() {
        val state = MainUiState()

        assertEquals(ConnectionState.Unknown, state.connectionState)
        assertEquals(TurnPhase.Idle, state.turnPhase)
        assertEquals(PlaybackState.Idle, state.playbackState)
        assertEquals("", state.workspacePath)
        assertFalse(state.isBusy)
        assertFalse(state.isRecording)
    }

    @Test
    fun `diagnostic events store redaction-ready support messages separately from turns`() {
        val state = MainUiState(
            diagnostics = listOf(
                DiagnosticEventUiState(
                    id = 1L,
                    createdAtMillis = 1L,
                    area = "connection",
                    severity = DiagnosticSeverity.ERROR,
                    message = "Unauthorized. Check the remote token from /remote setup.",
                ),
            ),
        )

        assertEquals("connection", state.diagnostics.first().area)
        assertTrue(state.recentTurns.isEmpty())
    }

    @Test
    fun `hands free reply mode requires setup speech and autoplay`() {
        val state = MainUiState(
            baseUrl = "https://pi.example",
            token = "token",
            requestAudioReplies = true,
            speakEnabled = true,
            autoplayReplyAudio = true,
        )

        assertFalse(state.needsSetup)
        assertTrue(state.canUseHandsFreeReplies)
        assertEquals("Hands-free", state.replyModeLabel())
        assertEquals("Tap to talk. The reply should play out loud.", state.nextTurnHint())
    }

    @Test
    fun `requested audio reports speech off when gateway cannot speak`() {
        val state = MainUiState(
            baseUrl = "https://pi.example",
            token = "token",
            requestAudioReplies = true,
            speakEnabled = false,
            autoplayReplyAudio = true,
        )

        assertFalse(state.canUseHandsFreeReplies)
        assertEquals("Speech off", state.replyModeLabel())
        assertTrue(state.replyModeHint().contains("/speak is off"))
        assertEquals("Tap to talk, but expect text until /speak is enabled.", state.nextTurnHint())
    }

    @Test
    fun `continuous conversation only auto listens after complete hands free voice state`() {
        val ready = MainUiState(
            baseUrl = "https://pi.example",
            token = "token",
            requestAudioReplies = true,
            speakEnabled = true,
            autoplayReplyAudio = true,
            continuousConversation = true,
            turnPhase = TurnPhase.Complete,
        )

        assertTrue(ready.canAutoListenAfterReply)
        assertEquals("Loop on", ready.replyModeLabel())
        assertEquals("Tap to talk. After the spoken reply, listening resumes.", ready.nextTurnHint())

        assertFalse(ready.copy(turnPhase = TurnPhase.Waiting).canAutoListenAfterReply)
        assertFalse(ready.copy(isBusy = true).canAutoListenAfterReply)
        assertFalse(ready.copy(isRecording = true).canAutoListenAfterReply)
        assertFalse(ready.copy(error = "Playback failed").canAutoListenAfterReply)
    }
}
