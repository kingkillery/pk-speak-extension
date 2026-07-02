package com.example

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.audio.AudioHelper
import com.example.audio.StreamingPcmPlayer
import com.example.audio.TtsHelper
import com.example.data.AppPreferences
import com.example.data.ChatMessage
import com.example.ui.theme.Accent
import com.example.ui.theme.AccentSoft
import com.example.ui.theme.Canvas
import com.example.ui.theme.Error
import com.example.ui.theme.Ink
import com.example.ui.theme.InkMuted
import com.example.ui.theme.Line
import com.example.ui.theme.SelectedFill
import com.example.ui.theme.Success
import com.example.ui.theme.SurfaceMuted
import com.example.ui.theme.SurfacePaper
import com.example.ui.theme.SurfaceSubtle
import com.example.ui.theme.Warn
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.PermissionState
import com.google.accompanist.permissions.isGranted

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun StudioCockpitLayout(
    state: StudioRuntimeState,
    prefs: AppPreferences,
    listState: LazyListState,
    recordingScale: Float,
    permissionState: PermissionState,
    liveSessionRef: MutableState<RealtimeVoiceSession?>,
    livePlayerRef: MutableState<StreamingPcmPlayer?>,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    haptic: HapticFeedback,
    onClearConversation: () -> Unit,
    onStopCurrentTurn: () -> Unit,
    onStartLiveSession: () -> Unit,
    onStopLiveSession: () -> Unit,
    onRecordTrigger: () -> Unit,
    onStopAndSend: () -> Unit,
    onSendText: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        StudioStatusStrip(state = state, onClearConversation = onClearConversation)
        StudioConversationPanel(
            state = state,
            prefs = prefs,
            listState = listState,
            liveSessionRef = liveSessionRef,
            audioHelper = audioHelper,
            ttsHelper = ttsHelper,
            haptic = haptic,
            onStopCurrentTurn = onStopCurrentTurn,
            onClearConversation = onClearConversation,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(top = 8.dp, bottom = 10.dp),
        )
        StudioComposer(
            state = state,
            prefs = prefs,
            recordingScale = recordingScale,
            permissionState = permissionState,
            liveSessionRef = liveSessionRef,
            livePlayerRef = livePlayerRef,
            haptic = haptic,
            onStartLiveSession = onStartLiveSession,
            onStopLiveSession = onStopLiveSession,
            onRecordTrigger = onRecordTrigger,
            onStopAndSend = onStopAndSend,
            onSendText = onSendText,
        )
    }
}

@Composable
private fun StudioStatusStrip(state: StudioRuntimeState, onClearConversation: () -> Unit) {
    val text = when {
        state.isRealtimeActive -> if (state.isRealtimeConnected) "Live connected" else "Live connecting"
        state.isRecording -> "Recording"
        state.stopStatusText == "Stopping..." -> "Stopping turn"
        state.isProcessing -> "Agent working"
        else -> "Ready"
    }
    val color = when {
        state.isRealtimeActive -> if (state.isRealtimeConnected) Success else Warn
        state.isRecording -> Accent
        state.isProcessing -> Warn
        else -> InkMuted
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            color = color,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 8.dp),
        )
        if (state.chatMessages.isNotEmpty()) {
            TextButton(
                onClick = onClearConversation,
                enabled = !state.isProcessing,
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
            ) {
                Text("Clear", color = InkMuted, fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun StudioConversationPanel(
    state: StudioRuntimeState,
    prefs: AppPreferences,
    listState: LazyListState,
    liveSessionRef: MutableState<RealtimeVoiceSession?>,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    haptic: HapticFeedback,
    onStopCurrentTurn: () -> Unit,
    onClearConversation: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        color = SurfacePaper,
        shape = RoundedCornerShape(24.dp),
        border = BorderStroke(1.dp, Line),
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.pendingTerminalApprovals.isNotEmpty()) {
                items(state.pendingTerminalApprovals, key = { it.approvalId }) { approval ->
                    TerminalApprovalCard(
                        approval = approval,
                        onApprove = {
                            liveSessionRef.value?.approveTerminal(approval.approvalId)
                            state.pendingTerminalApprovals.removeAll { it.approvalId == approval.approvalId }
                        },
                        onReject = {
                            liveSessionRef.value?.rejectTerminal(approval.approvalId)
                            state.pendingTerminalApprovals.removeAll { it.approvalId == approval.approvalId }
                        },
                    )
                }
            }
            if (state.chatMessages.isNotEmpty()) {
                item { ConversationLogHeader(onClearConversation, enabled = !state.isProcessing) }
                items(state.chatMessages, key = { it.id }) { message ->
                    StudioChatMessage(
                        message = message,
                        activeAgent = prefs.activeAgent,
                        playingMessageId = state.playingMessageId,
                        onPlayingMessageChange = { state.playingMessageId = it },
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        haptic = haptic,
                    )
                }
            }
            if (state.transcription.isNotEmpty()) {
                item { TranscriptStream(state.transcription) }
            }
            if (state.isProcessing) {
                item { TurnProgress(state.progressText, prefs.showTurnProgress, state.stopStatusText, onStopCurrentTurn) }
            }
            if (state.transcription.isEmpty() && state.latestReply.isEmpty() && state.chatMessages.isEmpty() && !state.isProcessing) {
                item { StudioIdleState(prefs.transmissionMode, prefs.codexSessionName, state.connectionStatusText, modifier = Modifier.fillParentMaxSize()) }
            }
        }
    }
}

@Composable
private fun ConversationLogHeader(onClearConversation: () -> Unit, enabled: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "Conversation log",
            color = Accent,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp,
        )
        TextButton(onClick = onClearConversation, enabled = enabled, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
            Text("Clear", color = InkMuted, fontSize = 10.sp)
        }
    }
}

@Composable
private fun StudioChatMessage(
    message: ChatMessage,
    activeAgent: String,
    playingMessageId: String?,
    onPlayingMessageChange: (String?) -> Unit,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    haptic: HapticFeedback,
) {
    val isUser = message.role == "user"
    val isProgress = message.role == "progress"
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = if (isUser) Alignment.End else Alignment.Start) {
        Text(
            text = when (message.role) {
                "user" -> "You"
                "assistant" -> activeAgent.uppercase()
                "progress" -> "Progress"
                else -> "System"
            },
            color = when (message.role) {
                "user" -> Accent
                "assistant" -> Success
                "progress" -> InkMuted
                else -> Error
            },
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Spacer(modifier = Modifier.height(3.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth(if (isUser) 0.86f else 1f)
                .background(if (isUser) AccentSoft else SurfaceSubtle, RoundedCornerShape(8.dp))
                .border(1.dp, Line, RoundedCornerShape(8.dp))
                .padding(10.dp),
        ) {
            Column {
                Text(
                    text = message.text,
                    color = if (isProgress) InkMuted else Ink,
                    fontSize = if (isProgress) 11.sp else 13.sp,
                    lineHeight = if (isProgress) 16.sp else 19.sp,
                    fontFamily = if (message.role == "assistant") FontFamily.Monospace else FontFamily.Default,
                )
                if (!isProgress) {
                    Spacer(modifier = Modifier.height(6.dp))
                    MessageActions(message, playingMessageId == message.id, onPlayingMessageChange, audioHelper, ttsHelper, haptic)
                }
            }
        }
    }
}

@Composable
private fun MessageActions(
    message: ChatMessage,
    isPlaying: Boolean,
    onPlayingMessageChange: (String?) -> Unit,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    haptic: HapticFeedback,
) {
    val clipboardManager = LocalClipboardManager.current
    val context = LocalContext.current
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = "Copy",
            color = InkMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clickable {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                clipboardManager.setText(AnnotatedString(message.text))
                android.widget.Toast.makeText(context, "Copied to clipboard", android.widget.Toast.LENGTH_SHORT).show()
            },
        )
        Spacer(modifier = Modifier.width(16.dp))
        Text(
            text = if (isPlaying) "Stop" else "Play",
            color = if (isPlaying) Accent else InkMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clickable {
                if (isPlaying) {
                    audioHelper.stopPlayback()
                    ttsHelper.stop()
                    onPlayingMessageChange(null)
                } else {
                    audioHelper.stopPlayback()
                    ttsHelper.stop()
                    onPlayingMessageChange(message.id)
                    val audioPath = message.audioPath
                    if (!audioPath.isNullOrBlank() && java.io.File(audioPath).exists()) {
                        audioHelper.startPlayback(audioPath) { onPlayingMessageChange(null) }
                    } else {
                        ttsHelper.speak(message.text) { onPlayingMessageChange(null) }
                    }
                }
            },
        )
    }
}

@Composable
private fun TranscriptStream(text: String) {
    Column {
        Text("Transcript stream", color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp)
        Spacer(modifier = Modifier.height(4.dp))
        Text("$text...", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun TurnProgress(progressText: String, showTurnProgress: Boolean, stopStatusText: String, onStopCurrentTurn: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator(color = Accent, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
        if (showTurnProgress && progressText.isNotBlank()) {
            Spacer(modifier = Modifier.height(10.dp))
            Text(progressText, color = Ink, fontSize = 12.sp, lineHeight = 17.sp, textAlign = TextAlign.Center)
        }
        Spacer(modifier = Modifier.height(12.dp))
        OutlinedButton(
            onClick = onStopCurrentTurn,
            enabled = stopStatusText != "Stopping...",
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Error),
            border = BorderStroke(1.dp, Accent),
            shape = RoundedCornerShape(8.dp),
        ) {
            Text(if (stopStatusText == "Stopping...") "Stopping..." else "Stop turn", fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
internal fun StudioIdleState(
    transmissionMode: String,
    targetSession: String,
    gatewayStatus: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(horizontal = 8.dp),
        horizontalAlignment = Alignment.Start,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Agent cockpit ready", color = Ink, style = MaterialTheme.typography.headlineMedium)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Talk, type, or send a command. Pi Speak will route the turn to the selected coding session and keep the reply here.",
            color = InkMuted,
            style = MaterialTheme.typography.bodyMedium,
            lineHeight = 22.sp,
        )
        Spacer(modifier = Modifier.height(18.dp))
        IdleHintRow("Gateway", gatewayStatus.ifBlank { "Checking" })
        IdleHintRow("Target", targetSession.ifBlank { "Default session" })
        IdleHintRow("Voice", if (transmissionMode == "PTT") "Hold Talk to record, release to send" else "Tap Talk to start or stop recording")
        Spacer(modifier = Modifier.height(18.dp))
        Surface(color = AccentSoft, shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, Line)) {
            Text(
                text = "Try /sess status, /model, or ask for the next code change.",
                color = Ink,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                modifier = Modifier.padding(14.dp),
            )
        }
    }
}

@Composable
private fun IdleHintRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
        Text(label, color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(72.dp))
        Text(value, color = Ink, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
    }
}

@OptIn(ExperimentalPermissionsApi::class)
@Composable
private fun StudioComposer(
    state: StudioRuntimeState,
    prefs: AppPreferences,
    recordingScale: Float,
    permissionState: PermissionState,
    liveSessionRef: MutableState<RealtimeVoiceSession?>,
    livePlayerRef: MutableState<StreamingPcmPlayer?>,
    haptic: HapticFeedback,
    onStartLiveSession: () -> Unit,
    onStopLiveSession: () -> Unit,
    onRecordTrigger: () -> Unit,
    onStopAndSend: () -> Unit,
    onSendText: () -> Unit,
) {
    val quickCommands = listOf("/sess status", "/sess slots", "/skills", "/model", "/remote status", "/speak status")
    val canSend = state.textInputState.trim().isNotEmpty() && !state.isProcessing
    LazyRow(
        modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items(quickCommands) { cmd ->
            Surface(
                color = SelectedFill,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.clickable {
                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    state.textInputState = cmd
                },
            ) {
                Text(cmd, color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
    }
    Surface(
        modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
        color = SurfacePaper,
        shape = RoundedCornerShape(26.dp),
        border = BorderStroke(1.dp, Line),
        shadowElevation = 2.dp,
    ) {
        Column(modifier = Modifier.padding(start = 18.dp, end = 12.dp, top = 14.dp, bottom = 10.dp)) {
            BasicTextField(
                value = state.textInputState,
                onValueChange = { state.textInputState = it },
                enabled = !state.isProcessing,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = Ink),
                cursorBrush = SolidColor(Accent),
                modifier = Modifier.fillMaxWidth().heightIn(min = 28.dp, max = 140.dp),
                decorationBox = { inner ->
                    if (state.textInputState.isEmpty()) Text("Message Pi Speak…", color = InkMuted, style = MaterialTheme.typography.bodyLarge)
                    inner()
                },
            )
            Spacer(modifier = Modifier.height(10.dp))
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(16.dp))
                        .border(BorderStroke(1.dp, Line), RoundedCornerShape(16.dp))
                        .clickable(enabled = !state.isProcessing) {
                            if (!state.textInputState.startsWith("/")) state.textInputState = "/" + state.textInputState
                        }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("</>", color = InkMuted, fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Code", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                }
                StudioComposerActions(
                    state = state,
                    prefs = prefs,
                    recordingScale = recordingScale,
                    permissionState = permissionState,
                    liveSessionRef = liveSessionRef,
                    livePlayerRef = livePlayerRef,
                    canSend = canSend,
                    onStartLiveSession = onStartLiveSession,
                    onStopLiveSession = onStopLiveSession,
                    onRecordTrigger = onRecordTrigger,
                    onStopAndSend = onStopAndSend,
                    onSendText = onSendText,
                )
            }
        }
    }
}

@OptIn(ExperimentalPermissionsApi::class)
@Composable
private fun StudioComposerActions(
    state: StudioRuntimeState,
    prefs: AppPreferences,
    recordingScale: Float,
    permissionState: PermissionState,
    liveSessionRef: MutableState<RealtimeVoiceSession?>,
    livePlayerRef: MutableState<StreamingPcmPlayer?>,
    canSend: Boolean,
    onStartLiveSession: () -> Unit,
    onStopLiveSession: () -> Unit,
    onRecordTrigger: () -> Unit,
    onStopAndSend: () -> Unit,
    onSendText: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (state.isRealtimeActive) {
            StudioPillButton("Interrupt", Color.White, Accent) {
                liveSessionRef.value?.sendInterrupt()
                livePlayerRef.value?.stop()
                livePlayerRef.value?.start()
            }
            StudioPillButton("Live On", Color.White, Success, onStopLiveSession)
        } else {
            StudioPillButton("Live Off", Ink, Canvas) {
                if (!permissionState.status.isGranted) permissionState.launchPermissionRequest() else onStartLiveSession()
            }
            Box(
                modifier = Modifier
                    .height(44.dp)
                    .widthIn(min = 72.dp)
                    .scale(if (state.isRecording) recordingScale else 1f)
                    .clip(CircleShape)
                    .background(if (state.isRecording) Accent else Canvas)
                    .border(BorderStroke(1.dp, Line), CircleShape)
                    .pointerInput(prefs.transmissionMode, permissionState.status.isGranted, state.isProcessing) {
                        detectTapGestures(
                            onPress = {
                                if (state.isProcessing) return@detectTapGestures
                                if (!permissionState.status.isGranted) {
                                    permissionState.launchPermissionRequest()
                                    return@detectTapGestures
                                }
                                if (prefs.transmissionMode == "PTT") {
                                    onRecordTrigger()
                                    tryAwaitRelease()
                                    onStopAndSend()
                                }
                            },
                            onTap = {
                                if (state.isProcessing) return@detectTapGestures
                                if (!permissionState.status.isGranted) {
                                    permissionState.launchPermissionRequest()
                                } else if (prefs.transmissionMode == "TOGGLE") {
                                    if (state.isRecording) onStopAndSend() else onRecordTrigger()
                                }
                            },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(if (state.isRecording) "Stop" else "Talk", color = if (state.isRecording) Color.White else Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(if (canSend) Accent else SurfaceMuted)
                .clickable(enabled = canSend) { onSendText() },
            contentAlignment = Alignment.Center,
        ) {
            Text("↑", color = if (canSend) SurfacePaper else InkMuted, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun StudioPillButton(text: String, textColor: Color, backgroundColor: Color, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .height(44.dp)
            .widthIn(min = 72.dp)
            .clip(CircleShape)
            .background(backgroundColor)
            .border(BorderStroke(1.dp, Line), CircleShape)
            .clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = textColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp))
    }
}
