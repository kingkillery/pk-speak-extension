package com.pkkidking.pispeak.presentation.main

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
                    area = "connection",
                    message = "Unauthorized. Check the remote token from /remote setup.",
                ),
            ),
        )

        assertEquals("connection", state.diagnostics.first().area)
        assertTrue(state.recentTurns.isEmpty())
    }
}
