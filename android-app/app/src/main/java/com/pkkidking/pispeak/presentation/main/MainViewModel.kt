package com.pkkidking.pispeak.presentation.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.core.AppAudioPlayer
import com.pkkidking.pispeak.core.AppAudioRecorder
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.DiagnosticEvent
import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.domain.model.PrivacyRedactor
import com.pkkidking.pispeak.domain.model.TurnHistoryItem
import com.pkkidking.pispeak.domain.model.TurnHistoryStatus
import com.pkkidking.pispeak.domain.model.TurnSource
import com.pkkidking.pispeak.domain.model.validate
import com.pkkidking.pispeak.domain.usecase.AppendDiagnosticUseCase
import com.pkkidking.pispeak.domain.usecase.AppendTurnHistoryUseCase
import com.pkkidking.pispeak.domain.usecase.GetStatusUseCase
import com.pkkidking.pispeak.domain.usecase.LoadDiagnosticsUseCase
import com.pkkidking.pispeak.domain.usecase.LoadSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.LoadTurnHistoryUseCase
import com.pkkidking.pispeak.domain.usecase.ResolveAudioUrlUseCase
import com.pkkidking.pispeak.domain.usecase.SaveSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.SendTextTurnUseCase
import com.pkkidking.pispeak.domain.usecase.SendVoiceTurnUseCase
import com.pkkidking.pispeak.domain.usecase.UpdateRouteTargetUseCase
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
class MainViewModel @Inject constructor(
    private val loadSettings: LoadSettingsUseCase,
    private val saveSettings: SaveSettingsUseCase,
    private val loadTurnHistory: LoadTurnHistoryUseCase,
    private val appendTurnHistory: AppendTurnHistoryUseCase,
    private val loadDiagnostics: LoadDiagnosticsUseCase,
    private val appendDiagnostic: AppendDiagnosticUseCase,
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
    private var continuousListenJob: Job? = null

    init {
        val settings = loadSettings()
        val recentTurns = loadTurnHistory().map { it.toUiState() }
        val diagnostics = loadDiagnostics().map { it.toUiState() }
        _uiState.update {
            it.copy(
                baseUrl = settings.baseUrl,
                token = settings.token,
                connectionMode = settings.connectionMode,
                workspacePath = settings.workspacePath,
                machineProfiles = settings.machineProfiles,
                selectedMachineId = settings.selectedMachineId,
                machineProfileName = "",
                requestAudioReplies = settings.requestAudioReplies,
                autoplayReplyAudio = settings.autoplayReplyAudio,
                continuousConversation = settings.continuousConversation,
                recentTurns = recentTurns,
                diagnostics = diagnostics,
                connection = buildConnectionUi(settings, ConnectionState.Unknown, null),
                route = it.route.copy(selectedTarget = ""),
                composer = it.composer.copy(textPrompt = it.textPrompt),
            )
        }
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
            machineProfileName = profileLabel,
        )
        _uiState.value = nextState
        addDiagnostic("setup", "Setup link applied.")
        saveSettings(currentSettings())
        refreshStatus()
    }

    fun onBaseUrlChanged(value: String) = _uiState.update {
        it.copy(
            baseUrl = value,
            connection = it.connection.copy(baseUrl = value, validationMessage = null),
        )
    }
    fun onTokenChanged(value: String) = _uiState.update {
        it.copy(token = value, connection = it.connection.copy(tokenSaved = value.isNotBlank()))
    }
    fun onWorkspacePathChanged(value: String) = _uiState.update {
        it.copy(workspacePath = value)
    }
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
    fun onTargetChanged(value: String) = _uiState.update { it.copy(targetName = value) }
    fun onTextPromptChanged(value: String) = _uiState.update {
        it.copy(textPrompt = value, composer = it.composer.copy(textPrompt = value))
    }
    fun onRequestAudioRepliesChanged(value: Boolean) {
        if (!value) continuousListenJob?.cancel()
        _uiState.update {
            it.copy(
                requestAudioReplies = value,
                continuousConversation = if (value) it.continuousConversation else false,
            )
        }
    }
    fun onAutoplayReplyAudioChanged(value: Boolean) {
        if (!value) continuousListenJob?.cancel()
        _uiState.update {
            it.copy(
                autoplayReplyAudio = value,
                continuousConversation = if (value) it.continuousConversation else false,
            )
        }
    }
    fun onContinuousConversationChanged(value: Boolean) {
        if (!value) continuousListenJob?.cancel()
        _uiState.update { it.copy(continuousConversation = value) }
    }
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
                            connection = buildConnectionUi(settings, ConnectionState.Connected, null),
                            route = RouteUiState(
                                currentSession = status.currentSession,
                                selectedTarget = status.defaultTarget.orEmpty(),
                                availableTargets = status.availableTargets,
                                updating = false,
                            ),
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
                                isBusy = false,
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
                                connection = buildConnectionUi(fallbackSettings, ConnectionState.Connected, null),
                                route = RouteUiState(
                                    currentSession = status.currentSession,
                                    selectedTarget = status.defaultTarget.orEmpty(),
                                    availableTargets = status.availableTargets,
                                    updating = false,
                                ),
                            )
                        }
                        addDiagnostic("connection", "Switched to reachable profile.")
                    } else {
                        val message = buildConnectionFailureMessage(error.message ?: "Status request failed")
                        _uiState.update {
                            it.copy(
                                isBusy = false,
                                error = message,
                                speakEnabled = false,
                                speakProvider = null,
                                connectionState = message.toConnectionState(),
                                connection = buildConnectionUi(settings, message.toConnectionState(), message),
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
            _uiState.update {
                it.copy(
                    isBusy = true,
                    error = null,
                    turnPhase = TurnPhase.Waiting,
                    route = it.route.copy(updating = true),
                )
            }
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
                            route = it.route.copy(updating = false),
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
            _uiState.update {
                it.copy(
                    isBusy = true,
                    error = null,
                    transcript = "",
                    turnPhase = TurnPhase.Waiting,
                    composer = it.composer.copy(phase = TurnPhase.Waiting),
                )
            }
            sendTextTurn(settings, text, activeTarget())
                .onSuccess { turn ->
                    val recentTurn = buildRecentTurn(
                        source = TurnSource.TEXT,
                        transcript = turn.transcript,
                        replyText = turn.replyText,
                        hasAudio = turn.audioUrl != null,
                        audioUrl = turn.audioUrl,
                        status = TurnHistoryStatus.COMPLETE,
                    )
                    val nextTurns = appendTurnHistory(recentTurn.toHistoryItem()).map { it.toUiState() }
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            replyText = turn.replyText,
                            transcript = turn.transcript,
                            textPrompt = "",
                            audioUrl = turn.audioUrl,
                            recentTurns = nextTurns,
                            statusSummary = "Text turn complete.",
                            turnPhase = TurnPhase.Complete,
                            composer = it.composer.copy(textPrompt = "", phase = TurnPhase.Complete),
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
                            composer = it.composer.copy(phase = TurnPhase.Failed),
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
                        composer = it.composer.copy(phase = TurnPhase.Recording, recorderActive = true),
                    )
                }
                addDiagnostic("recording", "Recording started.")
            }
            .onFailure { error ->
                val message = error.message ?: "Failed to start recording"
                _uiState.update {
                    it.copy(
                        error = message,
                        turnPhase = TurnPhase.Failed,
                        composer = it.composer.copy(phase = TurnPhase.Failed, recorderActive = false),
                    )
                }
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
                    composer = it.composer.copy(phase = TurnPhase.Uploading, recorderActive = false),
                )
            }
            runCatching { recorder.stop() }
                .onSuccess { audio ->
                    _uiState.update { it.copy(turnPhase = TurnPhase.Waiting) }
                    sendVoiceTurn(settings, audio, target)
                        .onSuccess { turn ->
                            val recentTurn = buildRecentTurn(
                                source = TurnSource.VOICE,
                                transcript = turn.transcript,
                                replyText = turn.replyText,
                                hasAudio = turn.audioUrl != null,
                                audioUrl = turn.audioUrl,
                                status = TurnHistoryStatus.COMPLETE,
                            )
                            val nextTurns = appendTurnHistory(recentTurn.toHistoryItem()).map { it.toUiState() }
                            _uiState.update {
                                it.copy(
                                    isBusy = false,
                                    transcript = turn.transcript,
                                    replyText = turn.replyText,
                                            audioUrl = turn.audioUrl,
                                            recentTurns = nextTurns,
                                            statusSummary = "Voice turn complete.",
                                            turnPhase = TurnPhase.Complete,
                                            composer = it.composer.copy(phase = TurnPhase.Complete, recorderActive = false),
                                            connectionState = ConnectionState.Connected,
                                        )
                            }
                            addDiagnostic("turn", "Voice turn completed.")
                            maybeAutoplay(turn.audioUrl, rearmAfterPlayback = true)
                        }
                        .onFailure { error ->
                            val message = error.message ?: "Voice turn failed"
                            _uiState.update {
                                it.copy(
                                    isBusy = false,
                                    error = message,
                                    turnPhase = TurnPhase.Failed,
                                    composer = it.composer.copy(phase = TurnPhase.Failed, recorderActive = false),
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
                            composer = it.composer.copy(phase = TurnPhase.Failed, recorderActive = false),
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
        continuousListenJob?.cancel()
        player.stop()
        _uiState.update { it.copy(playbackState = PlaybackState.Idle) }
        addDiagnostic("playback", "Playback stopped.")
    }

    private fun maybeAutoplay(audioUrl: String?, force: Boolean = false, rearmAfterPlayback: Boolean = false) {
        if (audioUrl.isNullOrBlank()) return
        val state = uiState.value
        if (!force && !state.autoplayReplyAudio) return
        if (force) continuousListenJob?.cancel()
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
                if (rearmAfterPlayback) scheduleContinuousListen()
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
        connectionMode = uiState.value.connectionMode,
        selectedMachineId = uiState.value.selectedMachineId,
        machineProfiles = uiState.value.machineProfiles,
        machineProfileName = uiState.value.machineProfileName,
        workspacePath = uiState.value.workspacePath.trim(),
        requestAudioReplies = uiState.value.requestAudioReplies,
        autoplayReplyAudio = uiState.value.autoplayReplyAudio,
        continuousConversation = uiState.value.continuousConversation,
    )

    private fun activeTarget(): String? = uiState.value.targetName.trim().takeIf { it.isNotEmpty() }

    private fun scheduleContinuousListen() {
        continuousListenJob?.cancel()
        if (!uiState.value.canAutoListenAfterReply) return
        continuousListenJob = viewModelScope.launch {
            delay(CONTINUOUS_LISTEN_DELAY_MS)
            val state = uiState.value
            if (!state.canAutoListenAfterReply) return@launch
            addDiagnostic("conversation", "Listening for the next turn.")
            startRecording()
        }
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
        val severity = message.toDiagnosticSeverity()
        val event = DiagnosticEvent(
            id = System.currentTimeMillis(),
            createdAtMillis = System.currentTimeMillis(),
            area = area,
            severity = severity,
            message = PrivacyRedactor.redact(message).take(180),
        )
        val persisted = appendDiagnostic(event).map { it.toUiState() }
        _uiState.update {
            it.copy(diagnostics = persisted)
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

    private fun String.toDiagnosticMessage(): String = PrivacyRedactor.redact(this).take(180)

    private fun String.toDiagnosticSeverity(): DiagnosticSeverity {
        val lower = lowercase()
        return when {
            "failed" in lower || "unauthorized" in lower || "denied" in lower || "error" in lower -> DiagnosticSeverity.ERROR
            "offline" in lower || "busy" in lower || "timeout" in lower || "retry" in lower -> DiagnosticSeverity.WARNING
            else -> DiagnosticSeverity.INFO
        }
    }

    private fun buildRecentTurn(
        source: TurnSource,
        transcript: String,
        replyText: String,
        hasAudio: Boolean,
        audioUrl: String?,
        status: TurnHistoryStatus,
    ): RecentTurnUiState {
        val state = uiState.value
        val routeLabel = state.targetName.ifBlank { state.currentSession ?: "Current session" }
        return RecentTurnUiState(
            id = System.currentTimeMillis(),
            createdAtMillis = System.currentTimeMillis(),
            source = source.label,
            routeLabel = routeLabel,
            transcript = PrivacyRedactor.redact(transcript.ifBlank { "No transcript returned." }),
            replyText = PrivacyRedactor.redact(replyText.ifBlank { "No reply text returned." }),
            hasAudio = hasAudio,
            audioUrl = audioUrl?.let(PrivacyRedactor::redact),
            status = status,
        )
    }

    private fun buildConnectionUi(
        settings: AppSettings,
        state: ConnectionState,
        validationMessage: String?,
    ): ConnectionUiState {
        val selectedMachine = settings.machineProfiles.firstOrNull { it.id == settings.selectedMachineId }
        return ConnectionUiState(
            state = state,
            selectedMachineName = selectedMachine?.name ?: "Manual connection",
            baseUrl = settings.baseUrl,
            tokenSaved = settings.token.isNotBlank(),
            validationMessage = validationMessage,
        )
    }

    private fun TurnHistoryItem.toUiState(): RecentTurnUiState =
        RecentTurnUiState(
            id = id,
            createdAtMillis = createdAtMillis,
            source = source.label,
            routeLabel = routeLabel,
            transcript = transcript,
            replyText = replyText,
            hasAudio = hasAudio,
            audioUrl = audioUrl,
            status = status,
        )

    private fun RecentTurnUiState.toHistoryItem(): TurnHistoryItem =
        TurnHistoryItem(
            id = id,
            createdAtMillis = createdAtMillis,
            source = TurnSource.entries.firstOrNull { it.label == source } ?: TurnSource.TEXT,
            routeLabel = routeLabel,
            transcript = transcript,
            replyText = replyText,
            hasAudio = hasAudio,
            audioUrl = audioUrl,
            status = status,
        )

    private fun DiagnosticEvent.toUiState(): DiagnosticEventUiState =
        DiagnosticEventUiState(
            id = id,
            createdAtMillis = createdAtMillis,
            area = area,
            severity = severity,
            message = message,
        )

    override fun onCleared() {
        continuousListenJob?.cancel()
        recorder.cancel()
        player.stop()
        super.onCleared()
    }

    private companion object {
        const val CONTINUOUS_LISTEN_DELAY_MS = 450L
    }
}
