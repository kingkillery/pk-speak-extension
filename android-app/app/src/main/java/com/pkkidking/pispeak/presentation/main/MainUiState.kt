package com.pkkidking.pispeak.presentation.main

import com.pkkidking.pispeak.BuildConfig

data class MainUiState(
    val baseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val token: String = "",
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
    val isBusy: Boolean = false,
    val isRecording: Boolean = false,
    val error: String? = null,
)
