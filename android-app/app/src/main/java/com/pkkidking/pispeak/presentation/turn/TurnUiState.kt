package com.pkkidking.pispeak.presentation.turn

import com.pkkidking.pispeak.presentation.common.RecentTurnUiState
import com.pkkidking.pispeak.presentation.common.TurnPhase

data class TurnUiState(
    val textPrompt: String = "",
    val transcript: String = "",
    val replyText: String = "",
    val turnPhase: TurnPhase = TurnPhase.Idle,
    val recentTurns: List<RecentTurnUiState> = emptyList(),
    val isLoading: Boolean = false,
    val isRecording: Boolean = false,
    val error: String? = null,
    val latestAudioUrl: String? = null,
)
