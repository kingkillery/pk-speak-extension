package com.pkkidking.pispeak.presentation.main

import com.pkkidking.pispeak.presentation.audio.AudioUiState
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.TurnPhase
import com.pkkidking.pispeak.presentation.connection.ConnectionUiState
import com.pkkidking.pispeak.presentation.turn.TurnUiState

data class ConversationScreenState(
    val connection: ConnectionUiState,
    val turn: TurnUiState,
    val audio: AudioUiState,
)

val ConversationScreenState.needsSetup: Boolean
    get() = connection.needsSetup

val ConversationScreenState.isBusy: Boolean
    get() = connection.isLoading || turn.isLoading

val ConversationScreenState.error: String?
    get() = connection.error ?: turn.error ?: audio.error

val ConversationScreenState.audioUrl: String?
    get() = turn.latestAudioUrl

val ConversationScreenState.canUseHandsFreeReplies: Boolean
    get() = !connection.needsSetup && audio.requestAudioReplies && connection.speakEnabled && audio.autoplayReplyAudio

val ConversationScreenState.canAutoListenAfterReply: Boolean
    get() = audio.continuousConversation &&
        canUseHandsFreeReplies &&
        !isBusy &&
        !turn.isRecording &&
        turn.turnPhase == TurnPhase.Complete &&
        error == null

fun ConversationScreenState.replyModeLabel(): String = when {
    connection.needsSetup -> "Setup needed"
    !audio.requestAudioReplies -> "Text replies"
    audio.requestAudioReplies && !connection.speakEnabled -> "Speech off"
    !audio.autoplayReplyAudio -> "Tap to play"
    audio.continuousConversation -> "Loop on"
    else -> "Hands-free"
}

fun ConversationScreenState.replyModeHint(): String = when {
    connection.needsSetup -> "Connect this phone before sending voice or text turns."
    !audio.requestAudioReplies -> "Audio replies are disabled in Settings."
    audio.requestAudioReplies && !connection.speakEnabled -> "Spoken replies are requested, but the gateway reports /speak is off."
    !audio.autoplayReplyAudio -> "Replies can speak, but autoplay is off."
    audio.continuousConversation -> "After a spoken voice reply finishes, Pi Speak starts listening again."
    else -> "Replies will play automatically when audio is returned."
}

fun ConversationScreenState.nextTurnHint(): String = when {
    connection.needsSetup -> "Open Settings or use a setup link to connect."
    turn.isRecording -> "Speak naturally. Tap again to send this turn."
    turn.turnPhase == TurnPhase.Uploading -> "Uploading your voice turn."
    turn.turnPhase == TurnPhase.Waiting || isBusy -> "Waiting for the agent. You can keep your hands off the screen."
    turn.turnPhase == TurnPhase.Failed -> "Something failed. Fix the issue and try the same turn again."
    audio.continuousConversation && canUseHandsFreeReplies -> "Tap to talk. After the spoken reply, listening resumes."
    canUseHandsFreeReplies -> "Tap to talk. The reply should play out loud."
    audio.requestAudioReplies && !connection.speakEnabled -> "Tap to talk, but expect text until /speak is enabled."
    else -> "Tap to talk or type a longer instruction."
}
