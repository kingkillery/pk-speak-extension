package com.pkkidking.pispeak.domain.model

data class AppSettings(
    val baseUrl: String,
    val token: String,
    val requestAudioReplies: Boolean,
    val autoplayReplyAudio: Boolean,
)

data class RemoteStatusSummary(
    val remoteEnabled: Boolean,
    val remotePort: Int?,
    val speakEnabled: Boolean,
    val speakProvider: String?,
    val monoRunning: Boolean,
    val phoneEnabled: Boolean,
) {
    fun summaryText(): String = buildString {
        append("Remote ")
        append(if (remoteEnabled) "on" else "off")
        if (remotePort != null) append(" at port $remotePort")
        append(". Speak ")
        append(if (speakEnabled) (speakProvider ?: "on") else "off")
        append(", mono ")
        append(if (monoRunning) "on" else "off")
        append(", phone ")
        append(if (phoneEnabled) "on" else "off")
        append('.')
    }
}

data class TurnResult(
    val replyText: String,
    val transcript: String,
    val audioUrl: String?,
)

data class RecordedAudio(
    val filePath: String,
    val mimeType: String,
)
