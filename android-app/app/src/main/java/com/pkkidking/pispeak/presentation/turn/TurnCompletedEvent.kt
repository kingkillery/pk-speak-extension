package com.pkkidking.pispeak.presentation.turn

import com.pkkidking.pispeak.domain.model.TurnResult
import com.pkkidking.pispeak.domain.model.TurnSource

data class TurnCompletedEvent(
    val result: TurnResult,
    val source: TurnSource,
)
