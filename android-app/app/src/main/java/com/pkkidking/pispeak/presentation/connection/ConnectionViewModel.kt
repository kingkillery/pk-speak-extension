package com.pkkidking.pispeak.presentation.connection

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.DiagnosticEvent
import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.domain.model.PrivacyRedactor
import com.pkkidking.pispeak.domain.model.validate
import com.pkkidking.pispeak.domain.usecase.AppendDiagnosticUseCase
import com.pkkidking.pispeak.domain.usecase.GetStatusUseCase
import com.pkkidking.pispeak.domain.usecase.LoadSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.SaveSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.UpdateRouteTargetUseCase
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.DiagnosticEventUiState
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
class ConnectionViewModel @Inject constructor(
    private val loadSettings: LoadSettingsUseCase,
    private val saveSettings: SaveSettingsUseCase,
    private val appendDiagnostic: AppendDiagnosticUseCase,
    private val getStatus: GetStatusUseCase,
    private val updateRouteTarget: UpdateRouteTargetUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ConnectionUiState())
    val uiState: StateFlow<ConnectionUiState> = _uiState.asStateFlow()

    init {
        val settings = loadSettings()
        _uiState.value = ConnectionUiState(
            baseUrl = settings.baseUrl,
            token = settings.token,
            connectionMode = settings.connectionMode,
            workspacePath = settings.workspacePath,
            machineProfiles = settings.machineProfiles,
            selectedMachineId = settings.selectedMachineId,
        )
        refreshStatus()
    }

    fun applyBootstrap(
        baseUrl: String?,
        token: String?,
        machineId: String? = null,
        profileName: String? = null,
        connectionMode: String? = null,
    ) {
        if (baseUrl.isNullOrBlank() && token.isNullOrBlank()) return
        val nextBaseUrl = baseUrl?.trim().takeUnless { it.isNullOrBlank() } ?: uiState.value.baseUrl
        val nextToken = token?.trim().takeUnless { it.isNullOrBlank() } ?: uiState.value.token
        val requestedMachineId = machineId?.trim().takeUnless { it.isNullOrBlank() }
        val requestedProfileName = profileName?.trim().takeUnless { it.isNullOrBlank() }
        val nextConnectionMode = ConnectionMode.fromStorage(
            connectionMode,
            inferConnectionMode(requestedMachineId, requestedProfileName, nextBaseUrl),
        )
        val profileId = requestedMachineId
            ?: uiState.value.machineProfiles.firstOrNull { it.baseUrl == nextBaseUrl }?.id
            ?: UUID.randomUUID().toString()
        val profileLabel = requestedProfileName
            ?: uiState.value.machineProfiles.firstOrNull { it.id == profileId || it.baseUrl == nextBaseUrl }?.name
            ?: "Machine ${uiState.value.machineProfiles.size + 1}"
        val nextProfiles = uiState.value.machineProfiles
            .filterNot { it.id == profileId || it.baseUrl == nextBaseUrl }
            .plus(
                MachineProfile(
                    id = profileId,
                    name = profileLabel,
                    baseUrl = nextBaseUrl,
                    token = nextToken,
                    connectionMode = nextConnectionMode,
                    workspacePath = uiState.value.workspacePath.trim(),
                ),
            )
        val nextState = uiState.value.copy(
            baseUrl = nextBaseUrl,
            token = nextToken,
            connectionMode = nextConnectionMode,
            machineProfiles = nextProfiles,
            selectedMachineId = profileId,
            machineProfileName = "",
        )
        _uiState.value = nextState
        addDiagnostic("setup", "Setup link applied.")
        saveSettings(currentSettings())
        refreshStatus()
    }

    fun onBaseUrlChanged(value: String) = _uiState.update {
        it.copy(baseUrl = value, validationMessage = null)
    }

    fun onTokenChanged(value: String) = _uiState.update { it.copy(token = value) }

    fun onWorkspacePathChanged(value: String) = _uiState.update { it.copy(workspacePath = value) }

    fun onConnectionModeChanged(value: ConnectionMode) = _uiState.update {
        it.copy(
            connectionMode = value,
            selectedMachineId = null,
            machineProfileName = if (value == ConnectionMode.BLUETOOTH) "Bluetooth / local link" else "",
        )
    }

    fun onMachineSelected(machineId: String?) {
        val profiles = uiState.value.machineProfiles
        if (machineId == null) {
            _uiState.update {
                it.copy(
                    selectedMachineId = null,
                    machineProfileName = "",
                    connectionMode = ConnectionMode.MANUAL,
                )
            }
            return
        }

        val selectedProfile = profiles.firstOrNull { it.id == machineId }
        if (selectedProfile == null) {
            _uiState.update {
                it.copy(
                    selectedMachineId = null,
                    machineProfileName = "",
                    connectionMode = ConnectionMode.MANUAL,
                )
            }
            return
        }

        _uiState.update {
            it.copy(
                selectedMachineId = selectedProfile.id,
                machineProfileName = selectedProfile.name,
                baseUrl = selectedProfile.baseUrl,
                token = selectedProfile.token,
                connectionMode = selectedProfile.connectionMode,
                workspacePath = selectedProfile.workspacePath,
            )
        }
        addDiagnostic("machine", "Switched to ${selectedProfile.name}.")
    }

    fun onMachineProfileNameChanged(value: String) = _uiState.update { it.copy(machineProfileName = value) }

    fun onSaveMachineProfile() {
        val name = uiState.value.machineProfileName.trim().ifBlank { null }
        val baseUrl = uiState.value.baseUrl.trim()
        if (baseUrl.isBlank()) {
            _uiState.update { it.copy(error = "Base URL is required to save a machine profile.") }
            return
        }

        val token = uiState.value.token.trim()
        val workspacePath = uiState.value.workspacePath.trim()
        val profileName = name ?: "Machine ${uiState.value.machineProfiles.size + 1}"
        val existingProfiles = uiState.value.machineProfiles
        val nextProfiles: List<MachineProfile> = if (uiState.value.selectedMachineId != null) {
            existingProfiles.map { existing ->
                if (existing.id == uiState.value.selectedMachineId) {
                    existing.copy(
                        name = profileName,
                        baseUrl = baseUrl,
                        token = token,
                        connectionMode = uiState.value.connectionMode,
                        workspacePath = workspacePath,
                    )
                } else {
                    existing
                }
            }
        } else {
            existingProfiles + MachineProfile(
                id = UUID.randomUUID().toString(),
                name = profileName,
                baseUrl = baseUrl,
                token = token,
                connectionMode = uiState.value.connectionMode,
                workspacePath = workspacePath,
            )
        }
        _uiState.update {
            it.copy(
                machineProfiles = nextProfiles,
                selectedMachineId = uiState.value.selectedMachineId ?: nextProfiles.last().id,
                machineProfileName = "",
            )
        }
        addDiagnostic("machine", "Machine profile saved.")
        saveSettings(currentSettings())
    }

    fun onDeleteSelectedMachine() {
        val selectedId = uiState.value.selectedMachineId ?: return
        val remaining = uiState.value.machineProfiles.filterNot { it.id == selectedId }
        val removedName = uiState.value.machineProfiles.firstOrNull { it.id == selectedId }?.name
        _uiState.update {
            it.copy(
                machineProfiles = remaining,
                selectedMachineId = remaining.firstOrNull()?.id,
                machineProfileName = remaining.firstOrNull()?.name ?: "",
            )
        }
        addDiagnostic("machine", "${removedName ?: "Machine"} removed.")
        onMachineSelected(_uiState.value.selectedMachineId)
        saveSettings(currentSettings())
    }

    fun onTargetChanged(value: String) = _uiState.update { it.copy(targetName = value) }

    fun clearError() = _uiState.update { it.copy(error = null) }

    fun saveCurrentSettings() {
        val settings = validatedSettings() ?: return
        saveSettings(settings)
        _uiState.update { it.copy(statusSummary = "Settings saved.", error = null, connectionState = ConnectionState.Unknown) }
        addDiagnostic("settings", "Connection settings saved.")
        refreshStatus()
    }

    fun refreshStatus() {
        val settings = validatedSettings() ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null, connectionState = ConnectionState.Unknown) }
            getStatus(settings)
                .onSuccess { status ->
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            statusSummary = status.summaryText(),
                            speakProvider = status.speakProvider,
                            speakEnabled = status.speakEnabled,
                            targetName = status.defaultTarget.orEmpty(),
                            currentSession = status.currentSession,
                            availableTargets = status.availableTargets,
                            connectionState = ConnectionState.Connected,
                            validationMessage = null,
                        )
                    }
                    addDiagnostic("connection", "Status check succeeded.")
                }
                .onFailure { error ->
                    val fallback = findReachableFallback(settings)
                    if (fallback != null) {
                        val (fallbackSettings, status) = fallback
                        saveSettings(fallbackSettings)
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                baseUrl = fallbackSettings.baseUrl,
                                token = fallbackSettings.token,
                                connectionMode = fallbackSettings.connectionMode,
                                workspacePath = fallbackSettings.workspacePath,
                                selectedMachineId = fallbackSettings.selectedMachineId,
                                machineProfileName = fallbackSettings.machineProfiles
                                    .firstOrNull { profile -> profile.id == fallbackSettings.selectedMachineId }
                                    ?.name
                                    .orEmpty(),
                                statusSummary = status.summaryText(),
                                speakProvider = status.speakProvider,
                                speakEnabled = status.speakEnabled,
                                targetName = status.defaultTarget.orEmpty(),
                                currentSession = status.currentSession,
                                availableTargets = status.availableTargets,
                                connectionState = ConnectionState.Connected,
                                validationMessage = null,
                            )
                        }
                        addDiagnostic("connection", "Switched to reachable profile.")
                    } else {
                        val message = buildConnectionFailureMessage(error.message ?: "Status request failed")
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                error = message,
                                connectionState = message.toConnectionState(),
                                validationMessage = message,
                            )
                        }
                        addDiagnostic("connection", message.toDiagnosticMessage())
                    }
                }
        }
    }

    fun applyRouteTarget() {
        val settings = validatedSettings() ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            updateRouteTarget(settings, uiState.value.targetName)
                .onSuccess {
                    addDiagnostic("route", "Route target updated.")
                    refreshStatus()
                }
                .onFailure { error ->
                    val message = error.message ?: "Failed to update route target"
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            error = message,
                        )
                    }
                    addDiagnostic("route", message.toDiagnosticMessage())
                }
        }
    }

    fun currentSettings(): AppSettings = AppSettings(
        baseUrl = uiState.value.baseUrl.trim(),
        token = uiState.value.token.trim(),
        connectionMode = uiState.value.connectionMode,
        selectedMachineId = uiState.value.selectedMachineId,
        machineProfiles = uiState.value.machineProfiles,
        machineProfileName = uiState.value.machineProfileName,
        workspacePath = uiState.value.workspacePath.trim(),
        requestAudioReplies = true,
        autoplayReplyAudio = true,
        continuousConversation = false,
    )

    private fun validatedSettings(): AppSettings? {
        val settings = currentSettings()
        val error = settings.validate(allowInsecureLoopback = BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update {
                it.copy(
                    error = error,
                    isLoading = false,
                    connectionState = ConnectionState.Misconfigured,
                    validationMessage = error,
                )
            }
            return null
        }
        return settings
    }

    private suspend fun findReachableFallback(
        failedSettings: AppSettings,
    ): Pair<AppSettings, com.pkkidking.pispeak.domain.model.RemoteStatusSummary>? {
        val profiles = uiState.value.machineProfiles
        val candidates = profiles
            .filter { it.id != failedSettings.selectedMachineId }
            .sortedWith(
                compareBy<MachineProfile> {
                    when {
                        it.id == "lan-msi" -> 0
                        it.connectionMode == ConnectionMode.BLUETOOTH -> 1
                        it.connectionMode == ConnectionMode.TAILSCALE -> 2
                        else -> 3
                    }
                }.thenBy { it.name },
            )

        for (profile in candidates) {
            val candidate = failedSettings.copy(
                baseUrl = profile.baseUrl,
                token = profile.token,
                connectionMode = profile.connectionMode,
                selectedMachineId = profile.id,
                workspacePath = profile.workspacePath,
            )
            if (candidate.validate(allowInsecureLoopback = BuildConfig.DEBUG) != null) continue
            val status = getStatus(candidate).getOrNull() ?: continue
            return candidate to status
        }
        return null
    }

    private fun buildConnectionFailureMessage(original: String): String =
        "${original.toDiagnosticMessage()} No saved route is reachable yet. Start /remote on for this machine, stay on the same Wi-Fi for LAN, or turn on Tailscale."

    private fun inferConnectionMode(machineId: String?, profileName: String?, baseUrl: String): ConnectionMode {
        val normalizedId = machineId?.lowercase().orEmpty()
        val normalizedName = profileName?.lowercase().orEmpty()
        val normalizedBaseUrl = baseUrl.lowercase()
        return when {
            "bluetooth" in normalizedId || "bluetooth" in normalizedName -> ConnectionMode.BLUETOOTH
            "tailscale" in normalizedId || "tailscale" in normalizedName || "100." in normalizedBaseUrl -> ConnectionMode.TAILSCALE
            else -> uiState.value.connectionMode
        }
    }

    private fun addDiagnostic(area: String, message: String) {
        val severity = message.toDiagnosticSeverity()
        val event = DiagnosticEvent(
            id = System.currentTimeMillis(),
            createdAtMillis = System.currentTimeMillis(),
            area = area,
            severity = severity,
            message = PrivacyRedactor.redact(message).take(180),
        )
        val persisted = appendDiagnostic(event).map { it.toUiState() }
        _uiState.update { it.copy(diagnostics = persisted) }
    }

    private fun String.toConnectionState(): ConnectionState {
        val lower = lowercase()
        return when {
            "unauthorized" in lower || "token" in lower -> ConnectionState.Unauthorized
            "offline" in lower || "unreachable" in lower || "network" in lower -> ConnectionState.Offline
            "base url" in lower || "endpoint" in lower || "https" in lower -> ConnectionState.Misconfigured
            else -> ConnectionState.Unknown
        }
    }

    private fun String.toDiagnosticMessage(): String = PrivacyRedactor.redact(this).take(180)

    private fun String.toDiagnosticSeverity(): DiagnosticSeverity {
        val lower = lowercase()
        return when {
            "failed" in lower || "unauthorized" in lower || "denied" in lower || "error" in lower -> DiagnosticSeverity.ERROR
            "offline" in lower || "busy" in lower || "timeout" in lower || "retry" in lower -> DiagnosticSeverity.WARNING
            else -> DiagnosticSeverity.INFO
        }
    }

    private fun com.pkkidking.pispeak.domain.model.DiagnosticEvent.toUiState(): DiagnosticEventUiState =
        DiagnosticEventUiState(
            id = id,
            createdAtMillis = createdAtMillis,
            area = area,
            severity = severity,
            message = message,
        )
}
