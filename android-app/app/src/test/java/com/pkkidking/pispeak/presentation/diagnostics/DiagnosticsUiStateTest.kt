package com.pkkidking.pispeak.presentation.diagnostics

import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticsUiStateTest {

    @Test
    fun `defaults to empty events`() {
        val state = DiagnosticsUiState()

        assertTrue(state.events.isEmpty())
    }
}
