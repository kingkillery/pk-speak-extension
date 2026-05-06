package com.pkkidking.pispeak.presentation.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.core.AppAudioPlayer
import com.pkkidking.pispeak.core.AppAudioRecorder
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.domain.model.validate
import com.pkkidking.pispeak.domain.usecase.GetStatusUseCase
import com.pkkidking.pispeak.domain.usecase.LoadSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.ResolveAudioUrlUseCase
import com.pkkidking.pispeak.domain.usecase.SaveSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.SendTextTurnUseCase
import com.pkkidking.pispeak.domain.usecase.SendVoiceTurnUseCase
import com.pkkidking.pispeak.domain.usecase.UpdateRouteTargetUseCase
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
class MainViewModel @Inject constructor(
    private val loadSettings: LoadSettingsUseCase,
    private val saveSettings: SaveSettingsUseCase,
    private val getStatus: GetStatusUseCase,
    private val updateRouteTarget: UpdateRouteTargetUseCase,
    private val sendTextTurn: SendTextTurnUseCase,
    private val sendVoiceTurn: SendVoiceTurnUseCase,
    private val resolveAudioUrl: ResolveAudioUrlUseCase,
    private val recorder: AppAudioRecorder,
    private val player: AppAudioPlayer,
) : ViewModel() {

    private val _uiState = MutableStateFlow(MainUiState())
    val uiState: StateFlow<MainUiState> = _uiState.asStateFlow()

    init {
        val settings = loadSettings()
        _uiState.update {
            it.copy(
                baseUrl = settings.baseUrl,
                token = settings.token,
                workspacePath = settings.workspacePath,
                machineProfiles = settings.machineProfiles,
                selectedMachineId = settings.selectedMachineId,
                machineProfileName = "",
                requestAudioReplies = settings.requestAudioReplies,
                autoplayReplyAudio = settings.autoplayReplyAudio,
            )
        }
        refreshStatus()
    }

    fun applyBootstrap(baseUrl: String?, token: String?) {
        if (baseUrl.isNullOrBlank() && token.isNullOrBlank()) return
        val nextState = uiState.value.copy(
            baseUrl = baseUrl?.trim().takeUnless { it.isNullOrBlank() } ?: uiState.value.baseUrl,
            token = token?.trim().takeUnless { it.isNullOrBlank() } ?: uiState.value.token,
            selectedMachineId = null,
        )
        _uiState.value = nextState
        addDiagnostic("setup", "Setup link applied.")
        saveSettings(currentSettings())
        refreshStatus()
    }

    fun onBaseUrlChanged(value: String) = _uiState.update {
        it.copy(baseUrl = value, selectedMachineId = null, machineProfileName = "")
    }
    fun onTokenChanged(value: String) = _uiState.update {
        it.copy(token = value, selectedMachineId = null, machineProfileName = "")
    }
    fun onWorkspacePathChanged(value: String) = _uiState.update {
        it.copy(workspacePath = value, selectedMachineId = null, machineProfileName = "")
    }
    fun onMachineSelected(machineId: String?) {
        val profiles = uiState.value.machineProfiles
        if (machineId == null) {
            _uiState.update {
                it.copy(
                    selectedMachineId = null,
                    machineProfileName = "",
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
                workspacePath = selectedProfile.workspacePath,
            )
        }
        addDiagnostic("machine", "Switched to ${selectedProfile.name}.")
    }

    fun onMachineProfileNameChanged(value: String) = _uiState.update { it.copy(machineProfileName = value) }
    fun onTargetChanged(value: String) = _uiState.update { it.copy(targetName = value) }
    fun onTextPromptChanged(value: String) = _uiState.update { it.copy(textPrompt = value) }
    fun onRequestAudioRepliesChanged(value: Boolean) = _uiState.update { it.copy(requestAudioReplies = value) }
    fun onAutoplayReplyAudioChanged(value: Boolean) = _uiState.update { it.copy(autoplayReplyAudio = value) }
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
            )
        }
        addDiagnostic("machine", "${removedName ?: "Machine"} removed.")
        onMachineSelected(_uiState.value.selectedMachineId)
        saveSettings(currentSettings())
    }

    fun clearError() = _uiState.update { it.copy(error = null) }
    fun onMicrophonePermissionDenied() {
        _uiState.update {
            it.copy(
                error = "Microphone access is required for voice turns. Enable it in Android settings and try again.",
                isRecording = false,
                turnPhase = TurnPhase.Failed,
            )
        }
        addDiagnostic("permission", "Microphone permission denied.")
    }

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
            _uiState.update { it.copy(isBusy = true, error = null, connectionState = ConnectionState.Unknown) }
            getStatus(settings)
                .onSuccess { status ->
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            statusSummary = status.summaryText(),
                            speakProvider = status.speakProvider,
                            speakEnabled = status.speakEnabled,
                            targetName = status.defaultTarget.orEmpty(),
                            currentSession = status.currentSession,
                            availableTargets = status.availableTargets,
                            connectionState = ConnectionState.Connected,
                        )
                    }
                    addDiagnostic("connection", "Status check succeeded.")
                }
                .onFailure { error ->
                    val message = error.message ?: "Status request failed"
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            error = message,
                            speakEnabled = false,
                            speakProvider = null,
                            connectionState = message.toConnectionState(),
                        )
                    }
                    addDiagnostic("connection", message.toDiagnosticMessage())
                }
        }
    }

    fun applyRouteTarget() {
        val settings = validatedSettings() ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, error = null, turnPhase = TurnPhase.Waiting) }
            updateRouteTarget(settings, uiState.value.targetName)
                .onSuccess {
                    addDiagnostic("route", "Route target updated.")
                    refreshStatus()
                }
                .onFailure { error ->
                    val message = error.message ?: "Failed to update route target"
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            error = message,
                            turnPhase = TurnPhase.Failed,
                        )
                    }
                    addDiagnostic("route", message.toDiagnosticMessage())
                }
        }
    }

    fun submitTextTurn() {
        val text = uiState.value.textPrompt.trim()
        if (text.isEmpty()) {
            _uiState.update { it.copy(error = "Enter text before sending.") }
            return
        }
        val settings = validatedSettings() ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, error = null, transcript = "", turnPhase = TurnPhase.Waiting) }
            sendTextTurn(settings, text, activeTarget())
                .onSuccess { turn ->
                    val recentTurn = buildRecentTurn(
                        source = "Text",
                        transcript = turn.transcript,
                        replyText = turn.replyText,
                        hasAudio = turn.audioUrl != null,
                    )
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            replyText = turn.replyText,
                            transcript = turn.transcript,
                            textPrompt = "",
                            audioUrl = turn.audioUrl,
                            recentTurns = listOf(recentTurn) + it.recentTurns.take(4),
                            statusSummary = "Text turn complete.",
                            turnPhase = TurnPhase.Complete,
                            connectionState = ConnectionState.Connected,
                        )
                    }
                    addDiagnostic("turn", "Text turn completed.")
                    maybeAutoplay(turn.audioUrl)
                }
                .onFailure { error ->
                    val message = error.message ?: "Text turn failed"
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            error = message,
                            turnPhase = TurnPhase.Failed,
                            connectionState = message.toConnectionState(),
                        )
                    }
                    addDiagnostic("turn", message.toDiagnosticMessage())
                }
        }
    }

    fun startRecording() {
        validatedSettings() ?: return
        runCatching { recorder.start() }
            .onSuccess {
                _uiState.update {
                    it.copy(
                        isRecording = true,
                        statusSummary = "Recording... tap again to send.",
                        error = null,
                        turnPhase = TurnPhase.Recording,
                    )
                }
                addDiagnostic("recording", "Recording started.")
            }
            .onFailure { error ->
                val message = error.message ?: "Failed to start recording"
                _uiState.update { it.copy(error = message, turnPhase = TurnPhase.Failed) }
                addDiagnostic("recording", message.toDiagnosticMessage())
            }
    }

    fun stopRecordingAndSend() {
        val settings = validatedSettings() ?: run {
            recorder.cancel()
            _uiState.update { it.copy(isRecording = false, isBusy = false) }
            return
        }
        val target = activeTarget()
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isBusy = true,
                    isRecording = false,
                    error = null,
                    statusSummary = "Uploading voice turn...",
                    turnPhase = TurnPhase.Uploading,
                )
            }
            runCatching { recorder.stop() }
                .onSuccess { audio ->
                    _uiState.update { it.copy(turnPhase = TurnPhase.Waiting) }
                    sendVoiceTurn(settings, audio, target)
                        .onSuccess { turn ->
                            val recentTurn = buildRecentTurn(
                                source = "Voice",
                                transcript = turn.transcript,
                                replyText = turn.replyText,
                                hasAudio = turn.audioUrl != null,
                            )
                            _uiState.update {
                                it.copy(
                                    isBusy = false,
                                    transcript = turn.transcript,
                                    replyText = turn.replyText,
                                            audioUrl = turn.audioUrl,
                                            recentTurns = listOf(recentTurn) + it.recentTurns.take(4),
                                            statusSummary = "Voice turn complete.",
                                            turnPhase = TurnPhase.Complete,
                                            connectionState = ConnectionState.Connected,
                                        )
                            }
                            addDiagnostic("turn", "Voice turn completed.")
                            maybeAutoplay(turn.audioUrl)
                        }
                        .onFailure { error ->
                            val message = error.message ?: "Voice turn failed"
                            _uiState.update {
                                it.copy(
                                    isBusy = false,
                                    error = message,
                                    turnPhase = TurnPhase.Failed,
                                    connectionState = message.toConnectionState(),
                                )
                            }
                            addDiagnostic("turn", message.toDiagnosticMessage())
                        }
                }
                .onFailure { error ->
                    val message = error.message ?: "Failed to stop recording"
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            error = message,
                            turnPhase = TurnPhase.Failed,
                        )
                    }
                    addDiagnostic("recording", message.toDiagnosticMessage())
                }
        }
    }

    fun playReplyAudio() {
        maybeAutoplay(uiState.value.audioUrl, force = true)
    }

    fun stopReplyAudio() {
        player.stop()
        _uiState.update { it.copy(playbackState = PlaybackState.Idle) }
        addDiagnostic("playback", "Playback stopped.")
    }

    private fun maybeAutoplay(audioUrl: String?, force: Boolean = false) {
        if (audioUrl.isNullOrBlank()) return
        val state = uiState.value
        if (!force && !state.autoplayReplyAudio) return
        val resolved = resolveAudioUrl(state.baseUrl, audioUrl)
        val headers = state.token.takeIf { it.isNotBlank() }?.let { mapOf("Authorization" to "Bearer $it") }.orEmpty()
        _uiState.update { it.copy(playbackState = PlaybackState.Loading) }
        player.play(
            url = resolved,
            headers = headers,
            onStart = {
                _uiState.update { it.copy(playbackState = PlaybackState.Playing) }
                addDiagnostic("playback", "Playback started.")
            },
            onComplete = {
                _uiState.update { it.copy(playbackState = PlaybackState.Idle) }
                addDiagnostic("playback", "Playback completed.")
            },
            onError = { message ->
                _uiState.update { it.copy(error = message, playbackState = PlaybackState.Failed) }
                addDiagnostic("playback", message.toDiagnosticMessage())
            },
        )
    }

    private fun currentSettings(): AppSettings = AppSettings(
        baseUrl = uiState.value.baseUrl.trim(),
        token = uiState.value.token.trim(),
        selectedMachineId = uiState.value.selectedMachineId,
        machineProfiles = uiState.value.machineProfiles,
        machineProfileName = uiState.value.machineProfileName,
        workspacePath = uiState.value.workspacePath.trim(),
        requestAudioReplies = uiState.value.requestAudioReplies,
        autoplayReplyAudio = uiState.value.autoplayReplyAudio,
    )

    private fun activeTarget(): String? = uiState.value.targetName.trim().takeIf { it.isNotEmpty() }

    private fun validatedSettings(): AppSettings? {
        val settings = currentSettings()
        val error = settings.validate(allowInsecureLoopback = BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update {
                it.copy(
                    error = error,
                    isBusy = false,
                    connectionState = ConnectionState.Misconfigured,
                    turnPhase = if (it.turnPhase == TurnPhase.Recording) TurnPhase.Failed else it.turnPhase,
                )
            }
            return null
        }
        return settings
    }

    private fun addDiagnostic(area: String, message: String) {
        _uiState.update {
            val event = DiagnosticEventUiState(
                id = System.currentTimeMillis(),
                area = area,
                message = message.redactSensitiveText(),
            )
            it.copy(diagnostics = listOf(event) + it.diagnostics.take(7))
        }
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

    private fun String.toDiagnosticMessage(): String = redactSensitiveText().take(180)

    private fun String.redactSensitiveText(): String =
        replace(Regex("Bearer\\s+[A-Za-z0-9._~+/-]+=*", RegexOption.IGNORE_CASE), "Bearer [redacted]")
            .replace(Regex("token=([^\\s&]+)", RegexOption.IGNORE_CASE), "token=[redacted]")
            .replace(Regex("(remote token[:=]\\s*)(\\S+)", RegexOption.IGNORE_CASE), "$1[redacted]")

    private fun buildRecentTurn(
        source: String,
        transcript: String,
        replyText: String,
        hasAudio: Boolean,
    ): RecentTurnUiState {
        val state = uiState.value
        val routeLabel = state.targetName.ifBlank { state.currentSession ?: "Current session" }
        return RecentTurnUiState(
            id = System.currentTimeMillis(),
            source = source,
            routeLabel = routeLabel,
            transcript = transcript.ifBlank { "No transcript returned." },
            replyText = replyText.ifBlank { "No reply text returned." },
            hasAudio = hasAudio,
        )
    }

    override fun onCleared() {
        recorder.cancel()
        player.stop()
        super.onCleared()
    }
}
