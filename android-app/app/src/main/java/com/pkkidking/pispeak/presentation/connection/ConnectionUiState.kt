package com.pkkidking.pispeak.presentation.connection

import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.DiagnosticEventUiState

data class ConnectionUiState(
    val machineProfiles: List<MachineProfile> = emptyList(),
    val selectedMachineId: String? = null,
    val machineProfileName: String = "",
    val baseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val token: String = "",
    val connectionMode: ConnectionMode = ConnectionMode.MANUAL,
    val workspacePath: String = "",
    val connectionState: ConnectionState = ConnectionState.Unknown,
    val speakProvider: String? = null,
    val speakEnabled: Boolean = false,
    val validationMessage: String? = null,
    val statusSummary: String = "Ready.",
    val targetName: String = "",
    val currentSession: String? = null,
    val availableTargets: List<String> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val diagnostics: List<DiagnosticEventUiState> = emptyList(),
) {
    val needsSetup: Boolean
        get() = baseUrl.isBlank() || token.isBlank()

    val selectedMachineName: String
        get() = machineProfiles.firstOrNull { it.id == selectedMachineId }?.name ?: "Manual connection"
}
