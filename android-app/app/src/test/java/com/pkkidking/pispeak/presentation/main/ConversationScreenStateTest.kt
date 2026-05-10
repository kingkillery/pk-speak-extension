package com.pkkidking.pispeak.presentation.main

import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
import com.pkkidking.pispeak.presentation.audio.AudioUiState
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.DiagnosticEventUiState
import com.pkkidking.pispeak.presentation.common.PlaybackState
import com.pkkidking.pispeak.presentation.common.TurnPhase
import com.pkkidking.pispeak.presentation.connection.ConnectionUiState
import com.pkkidking.pispeak.presentation.turn.TurnUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationScreenStateTest {

    @Test
    fun `defaults start in explicit idle states`() {
        val state = ConversationScreenState(
            connection = ConnectionUiState(),
            turn = TurnUiState(),
            audio = AudioUiState(),
        )

        assertEquals(ConnectionState.Unknown, state.connection.connectionState)
        assertEquals(TurnPhase.Idle, state.turn.turnPhase)
        assertEquals(PlaybackState.Idle, state.audio.playbackState)
        assertEquals("", state.connection.workspacePath)
        assertFalse(state.isBusy)
        assertFalse(state.turn.isRecording)
    }

    @Test
    fun `diagnostic events store redaction-ready support messages separately from turns`() {
        val state = ConversationScreenState(
            connection = ConnectionUiState(
                diagnostics = listOf(
                    DiagnosticEventUiState(
                        id = 1L,
                        createdAtMillis = 1L,
                        area = "connection",
                        severity = DiagnosticSeverity.ERROR,
                        message = "Unauthorized. Check the remote token from /remote setup.",
                    ),
                ),
            ),
            turn = TurnUiState(),
            audio = AudioUiState(),
        )

        assertEquals("connection", state.connection.diagnostics.first().area)
        assertTrue(state.turn.recentTurns.isEmpty())
    }

    @Test
    fun `hands free reply mode requires setup speech and autoplay`() {
        val state = ConversationScreenState(
            connection = ConnectionUiState(
                baseUrl = "https://pi.example",
                token = "token",
                speakEnabled = true,
            ),
            turn = TurnUiState(),
            audio = AudioUiState(
                requestAudioReplies = true,
                autoplayReplyAudio = true,
            ),
        )

        assertFalse(state.needsSetup)
        assertTrue(state.canUseHandsFreeReplies)
        assertEquals("Hands-free", state.replyModeLabel())
        assertEquals("Tap to talk. The reply should play out loud.", state.nextTurnHint())
    }

    @Test
    fun `requested audio reports speech off when gateway cannot speak`() {
        val state = ConversationScreenState(
            connection = ConnectionUiState(
                baseUrl = "https://pi.example",
                token = "token",
                speakEnabled = false,
            ),
            turn = TurnUiState(),
            audio = AudioUiState(
                requestAudioReplies = true,
                autoplayReplyAudio = true,
            ),
        )

        assertFalse(state.canUseHandsFreeReplies)
        assertEquals("Speech off", state.replyModeLabel())
        assertTrue(state.replyModeHint().contains("/speak is off"))
        assertEquals("Tap to talk, but expect text until /speak is enabled.", state.nextTurnHint())
    }

    @Test
    fun `continuous conversation only auto listens after complete hands free voice state`() {
        val ready = ConversationScreenState(
            connection = ConnectionUiState(
                baseUrl = "https://pi.example",
                token = "token",
                speakEnabled = true,
            ),
            turn = TurnUiState(turnPhase = TurnPhase.Complete),
            audio = AudioUiState(
                requestAudioReplies = true,
                autoplayReplyAudio = true,
                continuousConversation = true,
            ),
        )

        assertTrue(ready.canAutoListenAfterReply)
        assertEquals("Loop on", ready.replyModeLabel())
        assertEquals("Tap to talk. After the spoken reply, listening resumes.", ready.nextTurnHint())

        assertFalse(ready.copy(turn = ready.turn.copy(turnPhase = TurnPhase.Waiting)).canAutoListenAfterReply)
        assertFalse(ready.copy(turn = ready.turn.copy(isLoading = true)).canAutoListenAfterReply)
        assertFalse(ready.copy(turn = ready.turn.copy(isRecording = true)).canAutoListenAfterReply)
        assertFalse(ready.copy(turn = ready.turn.copy(error = "Playback failed")).canAutoListenAfterReply)
    }
}
