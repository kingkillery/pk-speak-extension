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
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
import com.example.ui.theme.SuccessSoft
import com.example.ui.theme.SurfaceMuted
import com.example.ui.theme.SurfacePaper
import com.example.ui.theme.SurfaceSubtle
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
    onInterruptLiveAudio: () -> Unit,
    onReplayInterruptedAudio: () -> Unit,
    onStopAndSend: () -> Unit,
    onSendText: () -> Unit,
) {
    // Edge-to-edge chat column (Claude Code mobile style): the conversation is
    // the screen, with only a compact composer docked below it.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .imePadding(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
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
                .weight(1f),
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
            onInterruptLiveAudio = onInterruptLiveAudio,
            onReplayInterruptedAudio = onReplayInterruptedAudio,
            onStopAndSend = onStopAndSend,
            onSendText = onSendText,
        )
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
    // Messages sit directly on the canvas — no card, no border, no inner gutter —
    // so the full screen width carries conversation content.
    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (state.pendingTerminalApprovals.isNotEmpty()) {
            items(state.pendingTerminalApprovals, key = { it.approvalId }) { approval ->
                TerminalApprovalCard(
                    approval = approval,
                    // Only clear the prompt once the decision actually reached the live
                    // session; with no session the disconnect paths clear the list instead.
                    onApprove = {
                        liveSessionRef.value?.let { session ->
                            session.approveTerminal(approval.approvalId)
                            state.pendingTerminalApprovals.removeAll { it.approvalId == approval.approvalId }
                        }
                    },
                    onReject = {
                        liveSessionRef.value?.let { session ->
                            session.rejectTerminal(approval.approvalId)
                            state.pendingTerminalApprovals.removeAll { it.approvalId == approval.approvalId }
                        }
                    },
                )
            }
        }
        if (state.chatMessages.isNotEmpty()) {
            item { ConversationLogHeader(onClearConversation, enabled = !state.isProcessing) }
            items(state.chatMessages, key = { it.id }) { message ->
                StudioChatMessage(
                    message = message,
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
        // latestReply is not rendered in this panel, so it must not suppress the
        // idle state — otherwise a reply with an empty chat leaves the screen blank.
        if (state.transcription.isEmpty() && state.chatMessages.isEmpty() && !state.isProcessing) {
            item { StudioIdleState(prefs.transmissionMode, prefs.codexSessionName, state.connectionStatusText, modifier = Modifier.fillParentMaxSize()) }
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
    playingMessageId: String?,
    onPlayingMessageChange: (String?) -> Unit,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    haptic: HapticFeedback,
) {
    // Claude Code mobile message anatomy: user turns are compact right-aligned
    // bubbles; assistant turns are plain full-width text on the canvas; progress
    // and system lines are quiet metadata. No role labels, borders, or panels.
    when (message.role) {
        "user" -> {
            Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
                Box(
                    modifier = Modifier
                        .widthIn(max = 300.dp)
                        .background(AccentSoft, RoundedCornerShape(18.dp))
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                ) {
                    Text(
                        text = message.text,
                        color = Ink,
                        fontSize = 15.sp,
                        lineHeight = 21.sp,
                    )
                }
            }
        }
        "assistant" -> {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = message.text,
                    color = Ink,
                    fontSize = 15.sp,
                    lineHeight = 22.sp,
                )
                Spacer(modifier = Modifier.height(4.dp))
                MessageActions(message, playingMessageId == message.id, onPlayingMessageChange, audioHelper, ttsHelper, haptic)
            }
        }
        "progress" -> {
            Text(
                text = message.text,
                color = InkMuted,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        else -> {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                Box(
                    modifier = Modifier
                        .padding(top = 6.dp)
                        .size(5.dp)
                        .clip(CircleShape)
                        .background(InkMuted)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = message.text,
                    color = InkMuted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    modifier = Modifier.weight(1f),
                )
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
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start, verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = "Copy",
            color = InkMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clickable(role = Role.Button, onClickLabel = "Copy message") {
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
            modifier = Modifier.clickable(
                role = Role.Button,
                onClickLabel = if (isPlaying) "Stop playback" else "Play message aloud",
            ) {
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
    // Inline working row, Claude-style: spinner + status on the left, a quiet
    // Stop affordance on the right. No centered block eating vertical space.
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(color = Accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(10.dp))
            Text("Working…", color = InkMuted, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            TextButton(
                onClick = onStopCurrentTurn,
                enabled = stopStatusText != "Stopping...",
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
            ) {
                Text(
                    if (stopStatusText == "Stopping...") "Stopping…" else "Stop",
                    color = Error,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        if (showTurnProgress && progressText.isNotBlank()) {
            Text(
                progressText,
                color = InkMuted,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                modifier = Modifier.padding(start = 26.dp, top = 2.dp),
            )
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
    val voiceHint = if (transmissionMode == "PTT") "Hold to talk" else "Tap to talk"
    Column(
        modifier = modifier
            .padding(start = 14.dp, end = 14.dp, top = 48.dp)
            .fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top,
    ) {
        ConnectionGlyph(gatewayStatus = gatewayStatus)
        Spacer(modifier = Modifier.height(14.dp))
        Text(
            text = "Connected to your computer",
            color = Ink,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = "Speak or send a command to the selected coding session.",
            color = InkMuted,
            style = MaterialTheme.typography.bodySmall,
            lineHeight = 19.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp),
        )
        Spacer(modifier = Modifier.height(18.dp))
        Surface(
            color = SurfaceSubtle,
            shape = RoundedCornerShape(24.dp),
            border = BorderStroke(1.dp, Line),
            modifier = Modifier.fillMaxWidth(0.88f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 18.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                IdleHintRow("Gateway", gatewayStatus.ifBlank { "Checking" })
                IdleHintRow("Target", targetSession.ifBlank { "Default session" })
                IdleHintRow("Voice", voiceHint)
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Line))
                Text(
                    text = "Try /sess status or ask for the next code change.",
                    color = InkMuted,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}


@Composable
private fun ConnectionGlyph(gatewayStatus: String) {
    val connected = gatewayStatus.equals("Connected", ignoreCase = true)
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(82.dp)) {
        Box(
            modifier = Modifier
                .size(82.dp)
                .clip(CircleShape)
                .background(SurfaceSubtle)
                .border(BorderStroke(1.dp, Line), CircleShape),
        )
        Box(
            modifier = Modifier
                .size(50.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(SurfacePaper)
                .border(BorderStroke(1.dp, Line), RoundedCornerShape(16.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text("⌘", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Medium)
        }
        Surface(
            color = if (connected) SuccessSoft else SurfaceMuted,
            shape = CircleShape,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 3.dp, bottom = 3.dp)
                .size(18.dp),
        ) {}
}
}

@Composable
private fun IdleHintRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.width(70.dp))
        Text(value, color = Ink, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
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
    onInterruptLiveAudio: () -> Unit,
    onReplayInterruptedAudio: () -> Unit,
    onStopAndSend: () -> Unit,
    onSendText: () -> Unit,
) {
    val quickCommands = listOf("/sess status", "/sess slots", "/skills", "/model", "/remote status", "/speak status")
    val canSend = state.textInputState.trim().isNotEmpty() && !state.isProcessing
    val sendQuickCommand = { command: String ->
        if (!state.isProcessing) {
            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            state.textInputState = command
            onSendText()
        }
    }
    LazyRow(
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items(quickCommands) { cmd ->
            Surface(
                color = SelectedFill,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.clickable(
                    enabled = !state.isProcessing,
                    role = Role.Button,
                    onClickLabel = "Send $cmd",
                ) { sendQuickCommand(cmd) },
            ) {
                Text(cmd, color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp))
            }
        }
    }
    Surface(
        modifier = Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 8.dp),
        color = SurfacePaper,
        shape = RoundedCornerShape(24.dp),
        border = BorderStroke(1.dp, Line),
        shadowElevation = 2.dp,
    ) {
        Column(modifier = Modifier.padding(start = 16.dp, end = 10.dp, top = 10.dp, bottom = 8.dp)) {
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
            Spacer(modifier = Modifier.height(6.dp))
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(16.dp))
                        .border(BorderStroke(1.dp, Line), RoundedCornerShape(16.dp))
                        .clickable(
                            enabled = !state.isProcessing,
                            role = Role.Button,
                            onClickLabel = "Prefix message with a slash command",
                        ) {
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
                    onInterruptLiveAudio = onInterruptLiveAudio,
                    onReplayInterruptedAudio = onReplayInterruptedAudio,
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
    onInterruptLiveAudio: () -> Unit,
    onReplayInterruptedAudio: () -> Unit,
    onSendText: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (state.isRealtimeActive) {
            StudioPillButton("Interrupt", Color.White, Accent, onInterruptLiveAudio)
            if (state.hasInterruptedLiveAudio) {
                StudioPillButton("Replay", Ink, SelectedFill, onReplayInterruptedAudio)
            }
        } else {
            StudioPillButton("Live Off", Ink, Canvas) {
                if (!permissionState.status.isGranted) permissionState.launchPermissionRequest() else onStartLiveSession()
            }
            val talkDescription = if (prefs.transmissionMode == "PTT") "Hold to talk" else "Tap to start or stop talking"
            Box(
                modifier = Modifier
                    .height(44.dp)
                    .widthIn(min = 72.dp)
                    .scale(if (state.isRecording) recordingScale else 1f)
                    .clip(CircleShape)
                    .background(if (state.isRecording) Accent else Canvas)
                    .border(BorderStroke(1.dp, Line), CircleShape)
                    .semantics {
                        role = Role.Button
                        contentDescription = talkDescription
                        stateDescription = if (state.isRecording) "Recording" else "Not recording"
                        // TalkBack cannot drive the raw press-and-hold gesture below, so expose
                        // an explicit activation that toggles recording in both PTT and TOGGLE
                        // modes (tap to start, tap again to stop and send).
                        onClick(label = if (state.isRecording) "Stop recording and send" else "Start recording") {
                            if (state.isProcessing) return@onClick false
                            if (!permissionState.status.isGranted) {
                                permissionState.launchPermissionRequest()
                                return@onClick true
                            }
                            if (state.isRecording) onStopAndSend() else onRecordTrigger()
                            true
                        }
                    }
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
                .clickable(enabled = canSend, role = Role.Button) { onSendText() }
                .semantics { contentDescription = "Send message" },
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
            .semantics { contentDescription = text }
            .clickable(role = Role.Button) { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = textColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp))
    }
}
