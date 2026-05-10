package com.pkkidking.pispeak.presentation.diagnostics

import com.pkkidking.pispeak.presentation.common.DiagnosticEventUiState

data class DiagnosticsUiState(
    val events: List<DiagnosticEventUiState> = emptyList(),
)
