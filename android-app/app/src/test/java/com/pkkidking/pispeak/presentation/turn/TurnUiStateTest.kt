package com.pkkidking.pispeak.presentation.turn

import com.pkkidking.pispeak.presentation.common.TurnPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnUiStateTest {

    @Test
    fun `defaults start idle`() {
        val state = TurnUiState()

        assertEquals("", state.textPrompt)
        assertEquals("", state.transcript)
        assertEquals("", state.replyText)
        assertEquals(TurnPhase.Idle, state.turnPhase)
        assertTrue(state.recentTurns.isEmpty())
        assertFalse(state.isLoading)
        assertFalse(state.isRecording)
        assertNull(state.error)
        assertNull(state.latestAudioUrl)
    }

    @Test
    fun `recording state is distinct from loading`() {
        val recording = TurnUiState(isRecording = true, turnPhase = TurnPhase.Recording)

        assertTrue(recording.isRecording)
        assertEquals(TurnPhase.Recording, recording.turnPhase)
    }

    @Test
    fun `failed turn preserves error and phase`() {
        val failed = TurnUiState(error = "Upload failed", turnPhase = TurnPhase.Failed)

        assertEquals("Upload failed", failed.error)
        assertEquals(TurnPhase.Failed, failed.turnPhase)
    }
}
