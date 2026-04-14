package com.pkkidking.pispeak.presentation.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pkkidking.pispeak.core.AppAudioPlayer
import com.pkkidking.pispeak.core.AppAudioRecorder
import com.pkkidking.pispeak.data.repo.PiSpeakRepositoryImpl
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.usecase.GetStatusUseCase
import com.pkkidking.pispeak.domain.usecase.LoadSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.SaveSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.SendTextTurnUseCase
import com.pkkidking.pispeak.domain.usecase.SendVoiceTurnUseCase
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
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
    private val sendTextTurn: SendTextTurnUseCase,
    private val sendVoiceTurn: SendVoiceTurnUseCase,
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
                requestAudioReplies = settings.requestAudioReplies,
                autoplayReplyAudio = settings.autoplayReplyAudio,
            )
        }
        refreshStatus()
    }

    fun onBaseUrlChanged(value: String) = _uiState.update { it.copy(baseUrl = value) }
    fun onTokenChanged(value: String) = _uiState.update { it.copy(token = value) }
    fun onTextPromptChanged(value: String) = _uiState.update { it.copy(textPrompt = value) }
    fun onRequestAudioRepliesChanged(value: Boolean) = _uiState.update { it.copy(requestAudioReplies = value) }
    fun onAutoplayReplyAudioChanged(value: Boolean) = _uiState.update { it.copy(autoplayReplyAudio = value) }
    fun clearError() = _uiState.update { it.copy(error = null) }

    fun saveCurrentSettings() {
        saveSettings(currentSettings())
        _uiState.update { it.copy(statusSummary = "Settings saved.", error = null) }
        refreshStatus()
    }

    fun refreshStatus() {
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, error = null) }
            getStatus(currentSettings())
                .onSuccess { status ->
                    _uiState.update { it.copy(isBusy = false, statusSummary = status.summaryText()) }
                }
                .onFailure { error ->
                    _uiState.update { it.copy(isBusy = false, error = error.message ?: "Status request failed") }
                }
        }
    }

    fun submitTextTurn() {
        val text = uiState.value.textPrompt.trim()
        if (text.isEmpty()) {
            _uiState.update { it.copy(error = "Enter text before sending.") }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, error = null, transcript = "") }
            sendTextTurn(currentSettings(), text)
                .onSuccess { turn ->
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            replyText = turn.replyText,
                            transcript = turn.transcript,
                            textPrompt = "",
                            audioUrl = turn.audioUrl,
                            statusSummary = "Text turn complete.",
                        )
                    }
                    maybeAutoplay(turn.audioUrl)
                }
                .onFailure { error ->
                    _uiState.update { it.copy(isBusy = false, error = error.message ?: "Text turn failed") }
                }
        }
    }

    fun startRecording() {
        runCatching { recorder.start() }
            .onSuccess {
                _uiState.update { it.copy(isRecording = true, statusSummary = "Recording… tap again to send.", error = null) }
            }
            .onFailure { error ->
                _uiState.update { it.copy(error = error.message ?: "Failed to start recording") }
            }
    }

    fun stopRecordingAndSend() {
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, isRecording = false, error = null, statusSummary = "Uploading voice turn…") }
            runCatching { recorder.stop() }
                .onSuccess { audio ->
                    sendVoiceTurn(currentSettings(), audio)
                        .onSuccess { turn ->
                            _uiState.update {
                                it.copy(
                                    isBusy = false,
                                    transcript = turn.transcript,
                                    replyText = turn.replyText,
                                    audioUrl = turn.audioUrl,
                                    statusSummary = "Voice turn complete.",
                                )
                            }
                            maybeAutoplay(turn.audioUrl)
                        }
                        .onFailure { error ->
                            _uiState.update { it.copy(isBusy = false, error = error.message ?: "Voice turn failed") }
                        }
                }
                .onFailure { error ->
                    _uiState.update { it.copy(isBusy = false, error = error.message ?: "Failed to stop recording") }
                }
        }
    }

    fun playReplyAudio() {
        maybeAutoplay(uiState.value.audioUrl, force = true)
    }

    private fun maybeAutoplay(audioUrl: String?, force: Boolean = false) {
        if (audioUrl.isNullOrBlank()) return
        val state = uiState.value
        if (!force && !state.autoplayReplyAudio) return
        val resolved = PiSpeakRepositoryImpl.resolveAudioUrl(state.baseUrl, state.token, audioUrl)
        player.play(
            url = resolved,
            onError = { message -> _uiState.update { it.copy(error = message) } },
        )
    }

    private fun currentSettings(): AppSettings = AppSettings(
        baseUrl = uiState.value.baseUrl.trim(),
        token = uiState.value.token.trim(),
        requestAudioReplies = uiState.value.requestAudioReplies,
        autoplayReplyAudio = uiState.value.autoplayReplyAudio,
    )

    override fun onCleared() {
        recorder.cancel()
        player.stop()
        super.onCleared()
    }
}
