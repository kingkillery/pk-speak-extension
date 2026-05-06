package com.pkkidking.pispeak.presentation.main

import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.MachineProfile

data class RecentTurnUiState(
    val id: Long,
    val source: String,
    val routeLabel: String,
    val transcript: String,
    val replyText: String,
    val hasAudio: Boolean,
)

data class DiagnosticEventUiState(
    val id: Long,
    val area: String,
    val message: String,
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
    val workspacePath: String = "",
    val machineProfiles: List<MachineProfile> = emptyList(),
    val selectedMachineId: String? = null,
    val machineProfileName: String = "",
    val speakProvider: String? = null,
    val speakEnabled: Boolean = false,
    val requestAudioReplies: Boolean = true,
    val autoplayReplyAudio: Boolean = true,
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
    val isBusy: Boolean = false,
    val isRecording: Boolean = false,
    val error: String? = null,
)
