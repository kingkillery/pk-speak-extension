package com.pkkidking.pispeak.presentation.connection

import com.pkkidking.pispeak.presentation.common.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionUiStateTest {

    @Test
    fun `defaults are safe and explicit`() {
        val state = ConnectionUiState()

        assertEquals(ConnectionState.Unknown, state.connectionState)
        assertEquals("", state.token)
        assertEquals("", state.workspacePath)
        assertEquals("", state.targetName)
        assertNull(state.currentSession)
        assertTrue(state.machineProfiles.isEmpty())
        assertNull(state.selectedMachineId)
        assertFalse(state.isLoading)
        assertNull(state.error)
        assertTrue(state.diagnostics.isEmpty())
    }

    @Test
    fun `needsSetup when baseUrl or token is blank`() {
        val blankBase = ConnectionUiState(baseUrl = "", token = "tk")
        val blankToken = ConnectionUiState(baseUrl = "https://pi.example", token = "")
        val complete = ConnectionUiState(baseUrl = "https://pi.example", token = "tk")

        assertTrue(blankBase.needsSetup)
        assertTrue(blankToken.needsSetup)
        assertFalse(complete.needsSetup)
    }

    @Test
    fun `selectedMachineName falls back to manual connection`() {
        val noSelection = ConnectionUiState()
        val withSelection = ConnectionUiState(
            machineProfiles = listOf(
                com.pkkidking.pispeak.domain.model.MachineProfile(
                    id = "1",
                    name = "Office Pi",
                    baseUrl = "https://pi.example",
                    token = "tk",
                ),
            ),
            selectedMachineId = "1",
        )

        assertEquals("Manual connection", noSelection.selectedMachineName)
        assertEquals("Office Pi", withSelection.selectedMachineName)
    }
}
