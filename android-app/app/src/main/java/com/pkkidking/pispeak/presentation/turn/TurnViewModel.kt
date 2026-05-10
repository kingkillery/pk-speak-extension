package com.pkkidking.pispeak.presentation.turn

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pkkidking.pispeak.core.AppAudioRecorder
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.DiagnosticEvent
import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
import com.pkkidking.pispeak.domain.model.PrivacyRedactor
import com.pkkidking.pispeak.domain.model.TurnHistoryItem
import com.pkkidking.pispeak.domain.model.TurnHistoryStatus
import com.pkkidking.pispeak.domain.model.TurnResult
import com.pkkidking.pispeak.domain.model.TurnSource
import com.pkkidking.pispeak.domain.model.validate
import com.pkkidking.pispeak.domain.usecase.AppendDiagnosticUseCase
import com.pkkidking.pispeak.domain.usecase.AppendTurnHistoryUseCase
import com.pkkidking.pispeak.domain.usecase.LoadSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.LoadTurnHistoryUseCase
import com.pkkidking.pispeak.domain.usecase.SendTextTurnUseCase
import com.pkkidking.pispeak.domain.usecase.SendVoiceTurnUseCase
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.RecentTurnUiState
import com.pkkidking.pispeak.presentation.common.TurnPhase
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
class TurnViewModel @Inject constructor(
    private val loadSettings: LoadSettingsUseCase,
    private val loadTurnHistory: LoadTurnHistoryUseCase,
    private val appendTurnHistory: AppendTurnHistoryUseCase,
    private val appendDiagnostic: AppendDiagnosticUseCase,
    private val sendTextTurn: SendTextTurnUseCase,
    private val sendVoiceTurn: SendVoiceTurnUseCase,
    private val recorder: AppAudioRecorder,
) : ViewModel() {

    private val _uiState = MutableStateFlow(TurnUiState())
    val uiState: StateFlow<TurnUiState> = _uiState.asStateFlow()

    private val _turnCompleted = MutableSharedFlow<TurnCompletedEvent>(extraBufferCapacity = 1)
    val turnCompleted: SharedFlow<TurnCompletedEvent> = _turnCompleted.asSharedFlow()

    init {
        val recentTurns = loadTurnHistory().map { it.toUiState() }
        _uiState.update { it.copy(recentTurns = recentTurns) }
    }

    fun onTextPromptChanged(value: String) = _uiState.update { it.copy(textPrompt = value) }

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
                    isLoading = true,
                    error = null,
                    transcript = "",
                    turnPhase = TurnPhase.Waiting,
                    latestAudioUrl = null,
                )
            }
            sendTextTurn(settings, text, activeTarget(settings))
                .onSuccess { turn ->
                    val recentTurn = buildRecentTurn(
                        source = TurnSource.TEXT,
                        transcript = turn.transcript,
                        replyText = turn.replyText,
                        hasAudio = turn.audioUrl != null,
                        audioUrl = turn.audioUrl,
                        status = TurnHistoryStatus.COMPLETE,
                        settings = settings,
                    )
                    val nextTurns = appendTurnHistory(recentTurn.toHistoryItem()).map { it.toUiState() }
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            replyText = turn.replyText,
                            transcript = turn.transcript,
                            textPrompt = "",
                            latestAudioUrl = turn.audioUrl,
                            recentTurns = nextTurns,
                            turnPhase = TurnPhase.Complete,
                        )
                    }
                    addDiagnostic("turn", "Text turn completed.")
                    _turnCompleted.emit(TurnCompletedEvent(turn, TurnSource.TEXT))
                }
                .onFailure { error ->
                    val message = error.message ?: "Text turn failed"
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            error = message,
                            turnPhase = TurnPhase.Failed,
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
                        error = null,
                        turnPhase = TurnPhase.Recording,
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
                    )
                }
                addDiagnostic("recording", message.toDiagnosticMessage())
            }
    }

    fun stopRecordingAndSend() {
        val settings = validatedSettings() ?: run {
            recorder.cancel()
            _uiState.update { it.copy(isRecording = false, isLoading = false) }
            return
        }
        val target = activeTarget(settings)
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = true,
                    isRecording = false,
                    error = null,
                    turnPhase = TurnPhase.Uploading,
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
                                settings = settings,
                            )
                            val nextTurns = appendTurnHistory(recentTurn.toHistoryItem()).map { it.toUiState() }
                            _uiState.update {
                                it.copy(
                                    isLoading = false,
                                    transcript = turn.transcript,
                                    replyText = turn.replyText,
                                    latestAudioUrl = turn.audioUrl,
                                    recentTurns = nextTurns,
                                    turnPhase = TurnPhase.Complete,
                                )
                            }
                            addDiagnostic("turn", "Voice turn completed.")
                            _turnCompleted.emit(TurnCompletedEvent(turn, TurnSource.VOICE))
                        }
                        .onFailure { error ->
                            val message = error.message ?: "Voice turn failed"
                            _uiState.update {
                                it.copy(
                                    isLoading = false,
                                    error = message,
                                    turnPhase = TurnPhase.Failed,
                                )
                            }
                            addDiagnostic("turn", message.toDiagnosticMessage())
                        }
                }
                .onFailure { error ->
                    val message = error.message ?: "Failed to stop recording"
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            error = message,
                            turnPhase = TurnPhase.Failed,
                        )
                    }
                    addDiagnostic("recording", message.toDiagnosticMessage())
                }
        }
    }

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

    fun clearError() = _uiState.update { it.copy(error = null) }

    private fun validatedSettings(): AppSettings? {
        val settings = loadSettings()
        val error = settings.validate(allowInsecureLoopback = com.pkkidking.pispeak.BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update {
                it.copy(
                    error = error,
                    isLoading = false,
                )
            }
            return null
        }
        return settings
    }

    private fun activeTarget(settings: AppSettings): String? =
        settings.workspacePath.trim().takeIf { it.isNotEmpty() }
            ?: settings.machineProfiles.firstOrNull { it.id == settings.selectedMachineId }?.workspacePath?.trim()?.takeIf { it.isNotEmpty() }

    private fun buildRecentTurn(
        source: TurnSource,
        transcript: String,
        replyText: String,
        hasAudio: Boolean,
        audioUrl: String?,
        status: TurnHistoryStatus,
        settings: AppSettings,
    ): RecentTurnUiState {
        val routeLabel = settings.workspacePath.trim().takeIf { it.isNotEmpty() }
            ?: settings.machineProfiles.firstOrNull { it.id == settings.selectedMachineId }?.name
            ?: "Current session"
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

    private fun addDiagnostic(area: String, message: String) {
        val severity = message.toDiagnosticSeverity()
        val event = DiagnosticEvent(
            id = System.currentTimeMillis(),
            createdAtMillis = System.currentTimeMillis(),
            area = area,
            severity = severity,
            message = PrivacyRedactor.redact(message).take(180),
        )
        appendDiagnostic(event)
    }

    private fun String.toDiagnosticSeverity(): DiagnosticSeverity {
        val lower = lowercase()
        return when {
            "failed" in lower || "unauthorized" in lower || "denied" in lower || "error" in lower -> DiagnosticSeverity.ERROR
            "offline" in lower || "busy" in lower || "timeout" in lower || "retry" in lower -> DiagnosticSeverity.WARNING
            else -> DiagnosticSeverity.INFO
        }
    }

    private fun String.toDiagnosticMessage(): String = PrivacyRedactor.redact(this).take(180)

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

    override fun onCleared() {
        recorder.cancel()
        super.onCleared()
    }
}
