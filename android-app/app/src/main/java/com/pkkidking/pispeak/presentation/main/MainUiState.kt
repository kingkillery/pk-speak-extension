package com.pkkidking.pispeak.presentation.main

import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.domain.model.TurnHistoryStatus

data class RecentTurnUiState(
    val id: Long,
    val createdAtMillis: Long,
    val source: String,
    val routeLabel: String,
    val transcript: String,
    val replyText: String,
    val hasAudio: Boolean,
    val audioUrl: String?,
    val status: TurnHistoryStatus,
)

data class DiagnosticEventUiState(
    val id: Long,
    val createdAtMillis: Long,
    val area: String,
    val severity: DiagnosticSeverity,
    val message: String,
)

data class ConnectionUiState(
    val state: ConnectionState = ConnectionState.Unknown,
    val selectedMachineName: String = "Manual connection",
    val baseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val tokenSaved: Boolean = false,
    val validationMessage: String? = null,
)

data class RouteUiState(
    val currentSession: String? = null,
    val selectedTarget: String = "",
    val availableTargets: List<String> = emptyList(),
    val updating: Boolean = false,
)

data class TurnComposerUiState(
    val textPrompt: String = "",
    val phase: TurnPhase = TurnPhase.Idle,
    val recorderActive: Boolean = false,
)

enum class ConnectionState {
    Unknown,
    Connected,
    Unauthorized,
    Offline,
    Misconfigured,
}

enum class TurnPhase {
    Idle,
    Recording,
    Uploading,
    Waiting,
    Complete,
    Failed,
}

enum class PlaybackState {
    Idle,
    Loading,
    Playing,
    Failed,
}

data class MainUiState(
    val baseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val token: String = "",
    val connectionMode: ConnectionMode = ConnectionMode.MANUAL,
    val workspacePath: String = "",
    val machineProfiles: List<MachineProfile> = emptyList(),
    val selectedMachineId: String? = null,
    val machineProfileName: String = "",
    val speakProvider: String? = null,
    val speakEnabled: Boolean = false,
    val requestAudioReplies: Boolean = true,
    val autoplayReplyAudio: Boolean = true,
    val continuousConversation: Boolean = false,
    val statusSummary: String = "Ready.",
    val targetName: String = "",
    val currentSession: String? = null,
    val availableTargets: List<String> = emptyList(),
    val textPrompt: String = "",
    val transcript: String = "",
    val replyText: String = "",
    val audioUrl: String? = null,
    val recentTurns: List<RecentTurnUiState> = emptyList(),
    val diagnostics: List<DiagnosticEventUiState> = emptyList(),
    val connectionState: ConnectionState = ConnectionState.Unknown,
    val turnPhase: TurnPhase = TurnPhase.Idle,
    val playbackState: PlaybackState = PlaybackState.Idle,
    val connection: ConnectionUiState = ConnectionUiState(),
    val route: RouteUiState = RouteUiState(),
    val composer: TurnComposerUiState = TurnComposerUiState(),
    val isBusy: Boolean = false,
    val isRecording: Boolean = false,
    val error: String? = null,
) {
    val needsSetup: Boolean
        get() = baseUrl.isBlank() || token.isBlank()

    val canUseHandsFreeReplies: Boolean
        get() = !needsSetup && requestAudioReplies && speakEnabled && autoplayReplyAudio

    val canAutoListenAfterReply: Boolean
        get() = continuousConversation &&
            canUseHandsFreeReplies &&
            !isBusy &&
            !isRecording &&
            turnPhase == TurnPhase.Complete &&
            error == null

    fun replyModeLabel(): String = when {
        needsSetup -> "Setup needed"
        !requestAudioReplies -> "Text replies"
        requestAudioReplies && !speakEnabled -> "Speech off"
        !autoplayReplyAudio -> "Tap to play"
        continuousConversation -> "Loop on"
        else -> "Hands-free"
    }

    fun replyModeHint(): String = when {
        needsSetup -> "Connect this phone before sending voice or text turns."
        !requestAudioReplies -> "Audio replies are disabled in Settings."
        requestAudioReplies && !speakEnabled -> "Spoken replies are requested, but the gateway reports /speak is off."
        !autoplayReplyAudio -> "Replies can speak, but autoplay is off."
        continuousConversation -> "After a spoken voice reply finishes, Pi Speak starts listening again."
        else -> "Replies will play automatically when audio is returned."
    }

    fun nextTurnHint(): String = when {
        needsSetup -> "Open Settings or use a setup link to connect."
        isRecording -> "Speak naturally. Tap again to send this turn."
        turnPhase == TurnPhase.Uploading -> "Uploading your voice turn."
        turnPhase == TurnPhase.Waiting || isBusy -> "Waiting for the agent. You can keep your hands off the screen."
        turnPhase == TurnPhase.Failed -> "Something failed. Fix the issue and try the same turn again."
        continuousConversation && canUseHandsFreeReplies -> "Tap to talk. After the spoken reply, listening resumes."
        canUseHandsFreeReplies -> "Tap to talk. The reply should play out loud."
        requestAudioReplies && !speakEnabled -> "Tap to talk, but expect text until /speak is enabled."
        else -> "Tap to talk or type a longer instruction."
    }
}
