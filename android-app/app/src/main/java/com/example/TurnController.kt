package com.example

import android.content.Context
import com.example.api.ConnectionReason
import com.example.api.VoiceAgentClient
import com.example.audio.AudioHelper
import com.example.audio.TtsHelper
import com.example.data.AppPreferences
import com.example.data.ChatMessage
import com.example.data.RecordedSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * Turn lifecycle for the e-ink (Boox) build.
 *
 * This is a faithful, standalone reimplementation of the local closures that live inside
 * MainActivity.StudioTabContent (sendTextAction / recordTriggerAction / stopAndSendAction /
 * stopCurrentTurn). Those closures capture composition-local state and are entangled with the
 * standard phone UI, so they cannot be reused directly. To avoid drift this code keeps the
 * SAME StudioRuntimeState holder the standard app uses and preserves every invariant:
 *
 *  - GENERATION GUARD: bump state.turnGeneration before launching, capture myTurnGeneration,
 *    and re-check `myTurnGeneration != state.turnGeneration` after EVERY suspend await. A missed
 *    guard would let a cancelled/superseded turn write its reply.
 *  - FINALLY GUARD: only clear isProcessing / activeTurnJob when the generation still matches,
 *    so a newer turn started after cancellation is never clobbered.
 *  - THREE-LAYER CANCEL: generation bump + client.cancelActiveTurnCall() + activeTurnJob.cancel()
 *    + POST /v1/turn/cancel, with the completion callback guarded by turnGeneration.
 *  - VOICE GATES: 1200ms minimum capture; recorded WAV must exist and be >= 12_000 bytes.
 *  - AUTO-SPEAK PRECEDENCE: a synthesized MP3 (elevenlabs_reply.mp3) wins; local Android TTS
 *    fires only when there is no MP3 AND prefs.autoSpeakEnabled AND latestReply is non-empty.
 *
 * If the e-ink UI proves out and this needs to be shared with the standard build, promote these
 * functions into the main source set then -- not speculatively now.
 */

private const val MINIMUM_VOICE_CAPTURE_MS = 1200L
private const val MIN_VALID_WAV_BYTES = 12_000L
private const val REPLY_AUDIO_FILE = "elevenlabs_reply.mp3"
private const val RECORD_FILE = "turn.wav"

internal fun persistChat(state: StudioRuntimeState, prefs: AppPreferences, messages: List<ChatMessage>) {
    val capped = messages.takeLast(50)
    state.chatMessages = capped
    prefs.saveChatMessages(state.conversationKey, capped)
}

internal fun appendChat(
    state: StudioRuntimeState,
    prefs: AppPreferences,
    role: String,
    text: String,
    progress: List<String> = emptyList(),
    audioPath: String? = null,
) {
    val trimmed = text.trim()
    if (trimmed.isEmpty() && progress.isEmpty()) return
    val message = ChatMessage(
        id = UUID.randomUUID().toString(),
        role = role,
        text = trimmed,
        timestampMs = System.currentTimeMillis(),
        baseUrl = prefs.targetIpAddress,
        workspacePath = prefs.workspacePath,
        targetSession = prefs.codexSessionName,
        progress = progress,
        audioPath = audioPath,
    )
    persistChat(state, prefs, state.chatMessages + message)
}

internal fun setProgress(state: StudioRuntimeState, prefs: AppPreferences, message: String) {
    if (prefs.showTurnProgress) state.progressText = message
}

/** Mirrors MainActivity.handleGatewayConnectionError: surface the failure and kick off a reconnect. */
internal fun handleGatewayConnectionError(
    state: StudioRuntimeState,
    scope: CoroutineScope,
    client: VoiceAgentClient,
    prefs: AppPreferences,
    message: String,
) {
    val cleanMessage = message.lineSequence().firstOrNull()?.ifBlank { null }
        ?: "Gateway is unreachable. Searching for a Pi Speak server."
    state.isGatewayConnected = false
    state.isReconnecting = true
    state.connectionStatusText = "Reconnecting..."
    state.connectionBannerText = cleanMessage
    setProgress(state, prefs, "Gateway unreachable. Searching for a Pi Speak server.")
    scope.launch {
        val reconnectGeneration = state.pairingGeneration
        val reconnect = withContext(Dispatchers.IO) { client.tryAutoConnect(forceVerify = true) }
        if (state.pairingGeneration != reconnectGeneration) return@launch
        state.connectionHealth = reconnect.reason
        state.isGatewayConnected = reconnect.connected
        val setupRequired = reconnect.reason == ConnectionReason.PairingRequired ||
            reconnect.reason == ConnectionReason.TokenRejected
        state.isReconnecting = false
        state.connectionStatusText = when {
            reconnect.connected -> "Connected"
            setupRequired -> "Setup required"
            else -> "Gateway unreachable"
        }
        if (reconnect.connected) {
            state.connectionBannerText = ""
            state.realtimeAuthFailure = false
        } else {
            state.connectionBannerText = reconnect.message.ifBlank {
                cleanMessage
            }
        }
    }
}

/** Send a text turn. No-op if the prompt is blank or another turn is in flight. */
fun sendTextTurn(
    promptText: String,
    state: StudioRuntimeState,
    scope: CoroutineScope,
    context: Context,
    client: VoiceAgentClient,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
) {
    if (promptText.isBlank() || state.isProcessing) return
    state.textInputState = ""
    state.turnGeneration += 1
    val myTurnGeneration = state.turnGeneration
    state.stopStatusText = ""
    val job = scope.launch {
        state.isProcessing = true
        state.transcription = promptText
        ttsHelper.stop()
        audioHelper.stopPlayback()
        state.playingMessageId = null
        setProgress(state, prefs, "Sending text to gateway.")
        appendChat(state, prefs, "user", promptText)
        try {
            val result = client.sendTextTurnDetailed(promptText)
            if (myTurnGeneration != state.turnGeneration) return@launch
            ttsHelper.stop()
            if (result.connectionError) {
                state.latestReply = ""
                handleGatewayConnectionError(state, scope, client, prefs, result.replyText)
                return@launch
            }
            state.transcription = result.transcript
            val finalProgressText = result.progress.joinToString("\n")
            state.progressText = finalProgressText
            state.latestReply = result.replyText
            val replyVoiceFile = File(context.cacheDir, REPLY_AUDIO_FILE)
            val path = if (replyVoiceFile.exists()) replyVoiceFile.absolutePath else null
            if (result.progress.isNotEmpty()) {
                appendChat(state, prefs, "progress", finalProgressText, result.progress)
            }
            appendChat(state, prefs, "assistant", result.replyText, result.progress, path)
            prefs.addRecordedSession(
                RecordedSession(
                    id = UUID.randomUUID().toString(),
                    timestamp = System.currentTimeMillis(),
                    durationSeconds = 1,
                    recordingPath = "",
                    transcriptionText = result.transcript,
                    replyText = result.replyText,
                    replyAudioPath = path,
                    voiceAgent = prefs.activeAgent,
                )
            )
            if (path != null) {
                audioHelper.startPlayback(path)
            } else if (prefs.autoSpeakEnabled && state.latestReply.isNotEmpty()) {
                ttsHelper.speak(state.latestReply)
            }
        } catch (e: CancellationException) {
            if (myTurnGeneration == state.turnGeneration) {
                state.stopStatusText = "Local request cancelled."
                setProgress(state, prefs, "Local request cancelled.")
            }
        } catch (e: Exception) {
            if (myTurnGeneration == state.turnGeneration) {
                state.latestReply = "System error contacting local node: ${e.message}"
            }
        } finally {
            if (myTurnGeneration == state.turnGeneration) {
                state.activeTurnJob = null
                state.isProcessing = false
            }
        }
    }
    state.activeTurnJob = job
}

/**
 * Begin push-to-talk recording. Returns the start timestamp (feed it back into
 * [stopAndSendVoiceTurn]). Caller must ensure RECORD_AUDIO is granted and guard
 * `!state.isRecording && !state.isProcessing` before calling.
 */
fun startVoiceRecording(
    state: StudioRuntimeState,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
): Long {
    ttsHelper.stop()
    audioHelper.stopPlayback()
    state.playingMessageId = null
    state.isRecording = true
    val startedAt = System.currentTimeMillis()
    state.currentRecordPath = audioHelper.startRecording(RECORD_FILE)
    return startedAt
}

/** Stop the in-progress recording and send it as a voice turn. */
fun stopAndSendVoiceTurn(
    recordingStartedAtMs: Long,
    state: StudioRuntimeState,
    scope: CoroutineScope,
    client: VoiceAgentClient,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
) {
    if (!state.isRecording) return
    state.isRecording = false
    state.turnGeneration += 1
    val myTurnGeneration = state.turnGeneration
    state.stopStatusText = ""
    val job = scope.launch {
        state.isProcessing = true
        var progressJob: Job? = null
        try {
            // stopRecording joins the WAV writer thread (up to 1.5s) — keep it off main.
            // On cancellation mid-delay the recorder must still be shut down, or the
            // WAV writer thread keeps the mic open until the next recording starts.
            val stoppedCleanly = try {
                val elapsedMs = System.currentTimeMillis() - recordingStartedAtMs
                if (elapsedMs in 0 until MINIMUM_VOICE_CAPTURE_MS) {
                    delay(MINIMUM_VOICE_CAPTURE_MS - elapsedMs)
                }
                withContext(Dispatchers.IO) { audioHelper.stopRecording() }
            } catch (e: CancellationException) {
                withContext(NonCancellable + Dispatchers.IO) { audioHelper.stopRecording() }
                throw e
            }
            val file = audioHelper.getRecordedFile(RECORD_FILE)
            if (stoppedCleanly && file.exists() && file.length() >= MIN_VALID_WAV_BYTES) {
                setProgress(state, prefs, "Uploading voice to gateway.")
                progressJob = scope.launch {
                    val messages = listOf(
                        "Transcribing voice.",
                        "Sending transcript to coding agent.",
                        "Waiting for coding agent response.",
                        "Preparing spoken reply.",
                    )
                    var idx = 0
                    while (state.isProcessing) {
                        if (myTurnGeneration != state.turnGeneration) break
                        val msg = messages[idx % messages.size]
                        setProgress(state, prefs, msg)
                        if (prefs.speakTurnProgress) ttsHelper.speak(msg)
                        idx += 1
                        delay(7000)
                    }
                }
                val result = client.sendVoiceTurnDetailed(file, state.transcription)
                if (myTurnGeneration != state.turnGeneration) return@launch
                progressJob?.cancel()
                ttsHelper.stop()
                if (result.connectionError) {
                    state.transcription = result.transcript
                    state.latestReply = ""
                    handleGatewayConnectionError(state, scope, client, prefs, result.replyText)
                    return@launch
                }
                state.transcription = result.transcript
                val finalProgressText = result.progress.joinToString("\n")
                state.progressText = finalProgressText
                state.latestReply = result.replyText
                val replyVoiceFile = File(file.parentFile, REPLY_AUDIO_FILE)
                val path = if (replyVoiceFile.exists()) replyVoiceFile.absolutePath else null
                appendChat(state, prefs, "user", result.transcript)
                if (result.progress.isNotEmpty()) {
                    appendChat(state, prefs, "progress", finalProgressText, result.progress)
                }
                appendChat(state, prefs, "assistant", result.replyText, result.progress, path)
                prefs.addRecordedSession(
                    RecordedSession(
                        id = UUID.randomUUID().toString(),
                        timestamp = System.currentTimeMillis(),
                        durationSeconds = 4,
                        recordingPath = file.absolutePath,
                        transcriptionText = result.transcript,
                        replyText = result.replyText,
                        replyAudioPath = path,
                        voiceAgent = prefs.activeAgent,
                    )
                )
                if (path != null) {
                    audioHelper.startPlayback(path)
                } else if (prefs.autoSpeakEnabled && state.latestReply.isNotEmpty()) {
                    ttsHelper.speak(state.latestReply)
                }
            } else {
                if (myTurnGeneration == state.turnGeneration) {
                    state.transcription = "Failed to record voice correctly."
                    state.latestReply =
                        "The audio clip was too short. Hold the Talk button a moment longer."
                    appendChat(state, prefs, "system", state.latestReply)
                }
            }
        } catch (e: CancellationException) {
            if (myTurnGeneration == state.turnGeneration) {
                state.stopStatusText = "Local request cancelled."
                setProgress(state, prefs, "Local request cancelled.")
            }
        } catch (e: Exception) {
            if (myTurnGeneration == state.turnGeneration) {
                state.latestReply = "System error contacting voice node: ${e.message}"
            }
        } finally {
            progressJob?.cancel()
            if (myTurnGeneration == state.turnGeneration) {
                state.activeTurnJob = null
                state.isProcessing = false
            }
        }
    }
    state.activeTurnJob = job
}

/** Three-layer cancel of the in-flight turn (local generation/job + OkHttp call + gateway POST). */
fun stopCurrentTurn(
    state: StudioRuntimeState,
    scope: CoroutineScope,
    client: VoiceAgentClient,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
) {
    val stoppedTurnGeneration = state.turnGeneration + 1
    state.turnGeneration = stoppedTurnGeneration
    client.cancelActiveTurnCall()
    state.activeTurnJob?.cancel()
    state.activeTurnJob = null
    state.stopStatusText = "Stopping..."
    state.isProcessing = true
    setProgress(state, prefs, "Stopping local request...")
    state.latestReply = "Stopping..."
    ttsHelper.stop()
    audioHelper.stopPlayback()
    state.playingMessageId = null
    scope.launch {
        val message = client.cancelTurn()
        if (state.turnGeneration == stoppedTurnGeneration) {
            val stoppedMessage = if (message.startsWith("Stop request failed")) {
                "Agent did not acknowledge cancellation. $message"
            } else {
                "Cancelled. $message"
            }
            state.stopStatusText = stoppedMessage
            setProgress(state, prefs, stoppedMessage)
            state.latestReply = stoppedMessage
            appendChat(state, prefs, "system", stoppedMessage)
            state.isProcessing = false
        }
    }
}
