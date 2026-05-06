package com.pkkidking.pispeak.presentation.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.core.AppAudioPlayer
import com.pkkidking.pispeak.core.AppAudioRecorder
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.ConnectionProfileId
import com.pkkidking.pispeak.domain.model.ConnectionSettings
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
        _uiState.update { state ->
            state.copy(
                activeProfileId = settings.activeProfileId,
                windowsBaseUrl = settings.windowsConnection.baseUrl,
                windowsToken = settings.windowsConnection.token,
                macBaseUrl = settings.macConnection.baseUrl,
                macToken = settings.macConnection.token,
                requestAudioReplies = settings.requestAudioReplies,
                autoplayReplyAudio = settings.autoplayReplyAudio,
            )
        }
        refreshStatus()
    }

    fun applyBootstrap(baseUrl: String?, token: String?) {
        if (baseUrl.isNullOrBlank() && token.isNullOrBlank()) return
        updateActiveConnection { current ->
            current.copy(
                baseUrl = baseUrl?.trim().takeUnless { it.isNullOrBlank() } ?: current.baseUrl,
                token = token?.trim().takeUnless { it.isNullOrBlank() } ?: current.token,
            )
        }
        saveSettings(currentSettings())
        refreshStatus()
    }

    fun onActiveProfileChanged(profileId: String) {
        val nextProfile = ConnectionProfileId.fromKey(profileId)
        _uiState.update { state ->
            state.copy(activeProfileId = nextProfile.key)
        }
        saveSettings(currentSettings())
        refreshStatus()
    }

    fun onBaseUrlChanged(value: String) = updateActiveConnection { it.copy(baseUrl = value) }
    fun onTokenChanged(value: String) = updateActiveConnection { it.copy(token = value) }
    fun onTargetChanged(value: String) = _uiState.update { it.copy(targetName = value) }
    fun onTextPromptChanged(value: String) = _uiState.update { it.copy(textPrompt = value) }
    fun onRequestAudioRepliesChanged(value: Boolean) = _uiState.update { it.copy(requestAudioReplies = value) }
    fun onAutoplayReplyAudioChanged(value: Boolean) = _uiState.update { it.copy(autoplayReplyAudio = value) }
    fun clearError() = _uiState.update { it.copy(error = null) }
    fun onMicrophonePermissionDenied() {
        _uiState.update {
            it.copy(
                error = "Microphone access is required for voice turns. Enable it in Android settings and try again.",
                isRecording = false,
            )
        }
    }

    fun saveCurrentSettings() {
        val settings = currentSettings()
        val error = settings.activeConnection().validate(allowInsecureLoopback = BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update { it.copy(error = error, isBusy = false) }
            return
        }
        saveSettings(settings)
        _uiState.update { it.copy(statusSummary = "Settings saved.", error = null) }
        refreshStatus()
    }

    fun refreshStatus() {
        val settings = currentSettings()
        val error = settings.activeConnection().validate(allowInsecureLoopback = BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update { it.copy(error = error, isBusy = false) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, error = null) }
            getStatus(settings)
                .onSuccess { status ->
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            statusSummary = status.summaryText(),
                            targetName = status.defaultTarget.orEmpty(),
                            currentSession = status.currentSession,
                            availableTargets = status.availableTargets,
                        )
                    }
                }
                .onFailure { error ->
                    _uiState.update { it.copy(isBusy = false, error = error.message ?: "Status request failed") }
                }
        }
    }

    fun applyRouteTarget() {
        val settings = currentSettings()
        val error = settings.activeConnection().validate(allowInsecureLoopback = BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update { it.copy(error = error, isBusy = false) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, error = null) }
            updateRouteTarget(settings, uiState.value.targetName)
                .onSuccess { refreshStatus() }
                .onFailure { error ->
                    _uiState.update { it.copy(isBusy = false, error = error.message ?: "Failed to update route target") }
                }
        }
    }

    fun submitTextTurn() {
        val text = uiState.value.textPrompt.trim()
        if (text.isEmpty()) {
            _uiState.update { it.copy(error = "Enter text before sending.") }
            return
        }
        val settings = currentSettings()
        val error = settings.activeConnection().validate(allowInsecureLoopback = BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update { it.copy(error = error, isBusy = false) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, error = null, transcript = "") }
            sendTextTurn(settings, text)
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
        val settings = currentSettings()
        val error = settings.activeConnection().validate(allowInsecureLoopback = BuildConfig.DEBUG)
        if (error != null) {
            _uiState.update { it.copy(error = error, isBusy = false) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isBusy = true, isRecording = false, error = null, statusSummary = "Uploading voice turn…") }
            runCatching { recorder.stop() }
                .onSuccess { audio ->
                    sendVoiceTurn(settings, audio)
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
        val resolved = resolveAudioUrl(state.baseUrl, audioUrl)
        val headers = state.token.takeIf { it.isNotBlank() }?.let { mapOf("Authorization" to "Bearer $it") }.orEmpty()
        player.play(
            url = resolved,
            headers = headers,
            onError = { message -> _uiState.update { it.copy(error = message) } },
        )
    }

    private fun currentSettings(): AppSettings = AppSettings(
        activeProfileId = uiState.value.activeProfileId,
        windowsConnection = ConnectionSettings(
            baseUrl = uiState.value.windowsBaseUrl.trim(),
            token = uiState.value.windowsToken.trim(),
        ),
        macConnection = ConnectionSettings(
            baseUrl = uiState.value.macBaseUrl.trim(),
            token = uiState.value.macToken.trim(),
        ),
        requestAudioReplies = uiState.value.requestAudioReplies,
        autoplayReplyAudio = uiState.value.autoplayReplyAudio,
    )

    private fun updateActiveConnection(transform: (ConnectionSettings) -> ConnectionSettings) {
        _uiState.update { state ->
            when (state.activeProfile) {
                ConnectionProfileId.MAC -> {
                    val updated = transform(ConnectionSettings(state.macBaseUrl, state.macToken))
                    state.copy(macBaseUrl = updated.baseUrl, macToken = updated.token)
                }
                ConnectionProfileId.WINDOWS -> {
                    val updated = transform(ConnectionSettings(state.windowsBaseUrl, state.windowsToken))
                    state.copy(windowsBaseUrl = updated.baseUrl, windowsToken = updated.token)
                }
            }
        }
    }

    override fun onCleared() {
        recorder.cancel()
        player.stop()
        super.onCleared()
    }
}
