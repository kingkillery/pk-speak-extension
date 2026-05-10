package com.pkkidking.pispeak.presentation.common

import com.pkkidking.pispeak.domain.model.DiagnosticSeverity
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
