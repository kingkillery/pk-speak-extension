package com.pkkidking.pispeak.presentation.audio

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pkkidking.pispeak.core.AppAudioPlayer
import com.pkkidking.pispeak.domain.model.DiagnosticEvent
import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
import com.pkkidking.pispeak.domain.model.PrivacyRedactor
import com.pkkidking.pispeak.domain.usecase.AppendDiagnosticUseCase
import com.pkkidking.pispeak.domain.usecase.LoadSettingsUseCase
import com.pkkidking.pispeak.domain.usecase.ResolveAudioUrlUseCase
import com.pkkidking.pispeak.domain.usecase.SaveSettingsUseCase
import com.pkkidking.pispeak.presentation.common.PlaybackState
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@HiltViewModel
class AudioViewModel @Inject constructor(
    private val loadSettings: LoadSettingsUseCase,
    private val saveSettings: SaveSettingsUseCase,
    private val resolveAudioUrl: ResolveAudioUrlUseCase,
    private val player: AppAudioPlayer,
    private val appendDiagnostic: AppendDiagnosticUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AudioUiState())
    val uiState: StateFlow<AudioUiState> = _uiState.asStateFlow()

    private val _events = MutableSharedFlow<AudioEvent>()
    val events: SharedFlow<AudioEvent> = _events.asSharedFlow()

    private var continuousListenJob: Job? = null

    init {
        val settings = loadSettings()
        _uiState.value = AudioUiState(
            requestAudioReplies = settings.requestAudioReplies,
            autoplayReplyAudio = settings.autoplayReplyAudio,
            continuousConversation = settings.continuousConversation,
        )
    }

    fun onRequestAudioRepliesChanged(value: Boolean) {
        _uiState.update { it.copy(requestAudioReplies = value) }
        val current = loadSettings()
        saveSettings(current.copy(requestAudioReplies = value))
    }

    fun onAutoplayReplyAudioChanged(value: Boolean) {
        if (!value) continuousListenJob?.cancel()
        _uiState.update { it.copy(autoplayReplyAudio = value) }
        val current = loadSettings()
        saveSettings(current.copy(autoplayReplyAudio = value))
    }

    fun onContinuousConversationChanged(value: Boolean) {
        if (!value) continuousListenJob?.cancel()
        _uiState.update { it.copy(continuousConversation = value) }
        val current = loadSettings()
        saveSettings(current.copy(continuousConversation = value))
    }

    fun maybeAutoplay(
        audioUrl: String?,
        baseUrl: String,
        token: String,
        force: Boolean = false,
        rearmAfterPlayback: Boolean = false,
    ) {
        if (audioUrl.isNullOrBlank()) return
        val state = uiState.value
        if (!force && !state.autoplayReplyAudio) return
        if (force) continuousListenJob?.cancel()
        val resolved = resolveAudioUrl(baseUrl, audioUrl)
        val headers = token.takeIf { it.isNotBlank() }?.let { mapOf("Authorization" to "Bearer $it") }.orEmpty()
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

    fun playReplyAudio(audioUrl: String?, baseUrl: String, token: String) {
        maybeAutoplay(audioUrl, baseUrl, token, force = true)
    }

    fun stopReplyAudio() {
        continuousListenJob?.cancel()
        player.stop()
        _uiState.update { it.copy(playbackState = PlaybackState.Idle) }
        addDiagnostic("playback", "Playback stopped.")
    }

    fun clearError() = _uiState.update { it.copy(error = null) }

    private fun scheduleContinuousListen() {
        continuousListenJob?.cancel()
        val state = uiState.value
        if (!state.continuousConversation || !state.autoplayReplyAudio || !state.requestAudioReplies) return
        continuousListenJob = viewModelScope.launch {
            delay(CONTINUOUS_LISTEN_DELAY_MS)
            val current = uiState.value
            if (!current.continuousConversation || !current.autoplayReplyAudio || !current.requestAudioReplies) return@launch
            addDiagnostic("conversation", "Listening for the next turn.")
            _events.emit(AudioEvent.RequestStartRecording)
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

    override fun onCleared() {
        continuousListenJob?.cancel()
        player.stop()
        super.onCleared()
    }

    private companion object {
        const val CONTINUOUS_LISTEN_DELAY_MS = 450L
    }
}

sealed class AudioEvent {
    data object RequestStartRecording : AudioEvent()
}
