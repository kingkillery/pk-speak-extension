package com.pkkidking.pispeak.presentation.audio

import com.pkkidking.pispeak.presentation.common.PlaybackState

data class AudioUiState(
    val speakProvider: String? = null,
    val speakEnabled: Boolean = false,
    val requestAudioReplies: Boolean = true,
    val autoplayReplyAudio: Boolean = true,
    val continuousConversation: Boolean = false,
    val currentAudioUrl: String? = null,
    val playbackState: PlaybackState = PlaybackState.Idle,
    val isRecording: Boolean = false,
    val error: String? = null,
) {
    val canUseHandsFreeReplies: Boolean
        get() = requestAudioReplies && speakEnabled && autoplayReplyAudio

    val canAutoListenAfterReply: Boolean
        get() = continuousConversation &&
            canUseHandsFreeReplies &&
            !isRecording &&
            playbackState == PlaybackState.Idle

    fun replyModeLabel(): String = when {
        !requestAudioReplies -> "Text replies"
        requestAudioReplies && !speakEnabled -> "Speech off"
        !autoplayReplyAudio -> "Tap to play"
        continuousConversation -> "Loop on"
        else -> "Hands-free"
    }

    fun replyModeHint(): String = when {
        !requestAudioReplies -> "Audio replies are disabled in Settings."
        requestAudioReplies && !speakEnabled -> "Spoken replies are requested, but the gateway reports /speak is off."
        !autoplayReplyAudio -> "Replies can speak, but autoplay is off."
        continuousConversation -> "After a spoken voice reply finishes, Pi Speak starts listening again."
        else -> "Replies will play automatically when audio is returned."
    }
}
