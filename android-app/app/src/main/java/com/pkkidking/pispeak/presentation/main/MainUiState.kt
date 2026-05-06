package com.pkkidking.pispeak.presentation.main

import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.ConnectionProfileId
import com.pkkidking.pispeak.domain.model.ConnectionSettings

data class MainUiState(
    val activeProfileId: String = ConnectionProfileId.WINDOWS.key,
    val windowsBaseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val windowsToken: String = "",
    val macBaseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val macToken: String = "",
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
) {
    val activeProfile: ConnectionProfileId
        get() = ConnectionProfileId.fromKey(activeProfileId)

    val baseUrl: String
        get() = activeConnection().baseUrl

    val token: String
        get() = activeConnection().token

    val activeProfileLabel: String
        get() = activeProfile.label

    private fun activeConnection(): ConnectionSettings = when (activeProfile) {
        ConnectionProfileId.MAC -> ConnectionSettings(macBaseUrl, macToken)
        ConnectionProfileId.WINDOWS -> ConnectionSettings(windowsBaseUrl, windowsToken)
    }
}
