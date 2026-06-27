package com.example

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
import com.example.api.GatewaySessionException
import com.example.api.VoiceAgentClient
import com.example.audio.AudioHelper
import com.example.audio.TtsHelper
import com.example.data.AppPreferences
import com.example.data.ChatMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * E-ink cockpit for the Onyx Boox Palma.
 *
 * Why this exists as its own activity instead of a Compose branch on MainActivity:
 *   1. The standard `StudioTabContent` composable owns its runtime state via local closures
 *      (sendTextAction, stopAndSendAction, recordTriggerAction, stopCurrentTurn) entangled with
 *      LCD-tuned styling -- infinite-transition pulse, CircularProgressIndicator, 80ms waveform
 *      canvas, animateScrollToItem. None of those survive an EPD refresh without ghosting.
 *   2. So this activity deliberately re-implements the UX around the SAME `StudioRuntimeState`
 *      holder and the SAME `TurnController` turn-lifecycle functions that the standard build
 *      will eventually share (those helpers already preserve every invariant from
 *      MainActivity.StudioTabContent -- generation guard, finally guard, three-layer cancel,
 *      voice gates, auto-speak precedence).
 *
 * Design contract:
 *   - PURE BLACK/WHITE PALETTE. No accent colors at all (EPD dithering + Boox user
 *     contrast/tint settings can collapse them). Every status signal is paired with
 *     TEXT ("OK"/"WAIT"/"!"), a SHAPE glyph ([+]/[*]/[ ]/[!]), or a BORDER WEIGHT (1dp
 *     vs 2dp). Status text is plain text in a fixed position; no flash of tinted
 *     surfaces.
 *   - ZERO ANIMATIONS. No infinite transitions, no pulse, no canvas draws at frame rate. The
 *     linear progress indicator is determinate (advances on state changes), not indeterminate.
 *   - LARGE TOUCH TARGETS. Palma is 824x1648 at 300 dpi; minimum 56.dp hit target.
 *   - READ-ONLY OH-MY-PI LANE VIEW. The Hub peek surfaces the gateway session dashboard,
 *     which already merges background lanes from `~/.omp/agent/sessions/` followed by `*.jsonl`. We do NOT
 *     expose a "start lane" or "send to lane" button -- the gateway has no endpoint that
 *     routes a turn to a specific background lane today, so those controls would be lies.
 *     If we add that later, we add it where the gateway supports it, not here.
 */
class BooxMainActivity : ComponentActivity() {

    private lateinit var prefs: AppPreferences
    private lateinit var client: VoiceAgentClient
    private lateinit var audioHelper: AudioHelper
    private lateinit var ttsHelper: TtsHelper

    private val requestMicPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* permission result is read lazily next time Talk is pressed */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = AppPreferences(this)
        client = VoiceAgentClient(this, prefs)
        audioHelper = AudioHelper(this)
        ttsHelper = TtsHelper(this)

        // QR onboarding deep link: pi-speak://setup?host=...&token=...&name=...
        handleDeepLink(intent)

        setContent {
            BooxRoot(prefs, client, audioHelper, ttsHelper) {
                handleDeepLink(it)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        audioHelper.stopRecording()
        audioHelper.stopPlayback()
        ttsHelper.stop()
    }

    private fun handleDeepLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (data.scheme != "pi-speak" || data.host != "setup") return
        val host = data.getQueryParameter("host")
        val token = data.getQueryParameter("token")
        val name = data.getQueryParameter("name")
        if (host.isNullOrBlank() || token.isNullOrBlank()) return
        // Build a base URL: prefer explicit scheme if present, otherwise http://host:8787.
        val scheme = data.getQueryParameter("scheme") ?: "http"
        val port = data.getQueryParameter("port") ?: "8787"
        val baseUrl = "$scheme://$host:$port"
        prefs.targetIpAddress = baseUrl
        prefs.remoteToken = token
        if (!name.isNullOrBlank()) prefs.codexSessionName = name
    }

    internal fun ensureMicPermission(onGranted: () -> Unit) {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) onGranted() else requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
    }
}

// ─── Palette ────────────────────────────────────────────────────────────────
// One ink, one paper, two chrome greys for borders. NO accent color: Boox dithering
// + user contrast/tint settings can collapse accent colors into the same gray as
// everything else on a 16-grayscale EPD panel. Every status cue is paired with TEXT
// ("OK"/"WAIT"/"!"), a SHAPE glyph ([+]/[*]/[ ]/[!]), or a BORDER WEIGHT (1dp vs 2dp)
// so the signal survives color loss.
private val Ink = Color(0xFF111111)
private val Paper = Color(0xFFFFFFFF)
private val Chrome = Color(0xFFB8B8B8)
private val SoftChrome = Color(0xFFE2E2E2)

// ─── Root ───────────────────────────────────────────────────────────────────
@Composable
private fun BooxRoot(
    prefs: AppPreferences,
    client: VoiceAgentClient,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    onNewIntent: (Intent) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val studioKey = remember { prefs.conversationKey() }
    val state = remember {
        StudioRuntimeState(
            conversationKey = studioKey,
            chatMessages = prefs.getChatMessages(studioKey)
        )
    }

    // Hub visibility is part of cockpit UX (peek the gateway dashboard including oh-my-pi
    // background lanes). It does NOT add a "send to lane" button -- read-only by design.
    var showHub by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var forceCheckTrigger by remember { mutableIntStateOf(0) }
    var unreachableSinceMs by remember { mutableStateOf<Long?>(null) }

    // Continuous connection loop mirroring MainActivity.kt: polls ping/auto-connect
    // every 5s so the UI dynamically adapts when the reverse tunnel is enabled.
    // Restarts immediately when settings change (forceCheckTrigger increments).
    LaunchedEffect(forceCheckTrigger) {
        while (true) {
            val startTime = System.currentTimeMillis()
            val healthy = withContext(Dispatchers.IO) { client.pingHealth() }
            val latency = System.currentTimeMillis() - startTime
            if (healthy) {
                unreachableSinceMs = null
                state.isGatewayConnected = true
                state.isReconnecting = false
                state.connectionLatencyMs = latency
                state.connectionStatusText = "Connected"
                state.connectionBannerText = ""
            } else {
                val firstFailureMs = unreachableSinceMs ?: System.currentTimeMillis()
                unreachableSinceMs = firstFailureMs
                state.isGatewayConnected = false
                state.isReconnecting = true
                state.connectionStatusText = "Reconnecting..."
                val result = withContext(Dispatchers.IO) { client.tryAutoConnect(forceVerify = true) }
                if (result.connected) {
                    unreachableSinceMs = null
                    state.isGatewayConnected = true
                    state.isReconnecting = false
                    state.connectionStatusText = "Connected"
                    state.connectionBannerText = ""
                } else {
                    val elapsedMs = System.currentTimeMillis() - firstFailureMs
                    // If we discovered a local gateway but connection was rejected (e.g. token blank/unauthorized),
                    // stop showing the active reconnection progress bar and update the status to reflect pairing.
                    state.isReconnecting = !result.discovered && (elapsedMs <= 10_000L)
                    state.connectionStatusText = when {
                        result.discovered -> "Pairing required"
                        state.isReconnecting -> "Searching for gateway..."
                        else -> "Gateway unreachable"
                    }
                    state.connectionBannerText = result.message.ifBlank { "Gateway is unreachable. Searching for a Pi Speak server." }
                    if (result.discovered && result.baseUrl.isNotBlank()) {
                        prefs.targetIpAddress = result.baseUrl
                    }
                }
            }
            delay(5_000)
        }
    }
    // suppress unused-variable warning
    @Suppress("UNUSED_EXPRESSION") forceCheckTrigger

    // Poll the gateway session dashboard every 10s while the Hub is visible. 10s matches
    // the standard app's refresh cadence; EPD users can tolerate this without ghosting
    // because nothing animates while Hub is collapsed.
    var hubState by remember { mutableStateOf<BooxHubUiState>(BooxHubUiState.Idle) }
    LaunchedEffect(showHub) {
        if (!showHub) return@LaunchedEffect
        hubState = BooxHubUiState.Loading
        while (showHub) {
            hubState = runCatching { client.getSessionDashboard() }
                .fold(
                    onSuccess = { BooxHubUiState.Loaded(it) },
                    onFailure = { mapGatewayError(it) }
                )
            delay(10_000)
        }
    }

    val activity = context as? BooxMainActivity

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Paper)
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {

            // ─── Header ──────────────────────────────────────────────
            BooxHeader(
                state = state,
                prefs = prefs,
                onToggleHub = { showHub = !showHub; showSettings = false },
                onToggleSettings = { showSettings = !showSettings; showHub = false },
            )

            Spacer(modifier = Modifier.height(8.dp))

            // ─── Connection / progress banner ──────────────────────
            if (state.connectionBannerText.isNotBlank() || state.isReconnecting || state.isProcessing) {
                StatusBanner(state = state)
                Spacer(modifier = Modifier.height(8.dp))
            }

            // ─── Pane ───────────────────────────────────────────────
            when {
                showHub -> {
                    Box(modifier = Modifier.weight(1f)) {
                        HubPane(state = hubState)
                    }
                }
                showSettings -> {
                    Box(modifier = Modifier.weight(1f)) {
                        SettingsPane(
                            prefs = prefs,
                            onSave = { forceCheckTrigger += 1 },
                            onClose = { showSettings = false }
                        )
                    }
                }
                else -> {
                    BooxCockpit(
                        state = state,
                        prefs = prefs,
                        client = client,
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        scope = scope,
                        context = activity!!,
                        onRequestMic = {
                            // First, ask for RECORD_AUDIO. When granted, TalkButton.onPress
                            // will start recording. If the user already pressed Talk before
                            // permission was granted, they'll press it again -- that's fine.
                            activity?.ensureMicPermission { /* TalkButton.onPress arms recording */ }
                        },
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }
    }
}

// ─── Header ────────────────────────────────────────────────────────────────
@Composable
private fun BooxHeader(
    state: StudioRuntimeState,
    prefs: AppPreferences,
    onToggleHub: () -> Unit,
    onToggleSettings: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Chrome, RoundedCornerShape(4.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "pi-speak · e-ink",
                color = Ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            val host = prefs.targetIpAddress.ifBlank { "(no gateway)" }
            val session = prefs.codexSessionName.ifBlank { "default" }
            Text(
                text = "$host · $session",
                color = Ink,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // Status is paired with a [OK]/[WAIT]/[!!] glyph + the headline text. The
            // text itself reads "Connected"/"Searching for gateway..."/"Gateway unreachable"
            // so it carries meaning even if every color renders identically on EPD.
            val statusPrefix = when {
                state.isGatewayConnected -> "[OK] "
                state.isReconnecting -> "[WAIT] "
                else -> "[!!] "
            }
            val statusBorderWeight = if (state.isGatewayConnected) 1.dp else 2.dp
            Text(
                text = statusPrefix + state.connectionStatusText,
                color = Ink,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.border(statusBorderWeight, Ink, RoundedCornerShape(2.dp))
                    .padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
        Spacer(modifier = Modifier.width(8.dp))
        OutlinedButton(
            onClick = onToggleHub,
            border = BorderStroke(1.dp, Ink),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text("HUB", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        }
        Spacer(modifier = Modifier.width(8.dp))
        OutlinedButton(
            onClick = onToggleSettings,
            border = BorderStroke(1.dp, Ink),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text("CFG", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        }
    }
}

// ─── Status banner (determinate — only renders when something is happening) ─
@Composable
private fun StatusBanner(state: StudioRuntimeState) {
    val text = state.connectionBannerText.ifBlank {
        when {
            state.isProcessing && state.progressText.isNotBlank() -> state.progressText
            state.isProcessing -> "Working..."
            state.isReconnecting -> "Searching for gateway..."
            else -> ""
        }
    }
    if (text.isBlank()) return
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Paper,
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, Chrome)
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Text(
                text = text,
                color = Ink,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
            if (state.isProcessing || state.isReconnecting) {
                Spacer(modifier = Modifier.height(6.dp))
                // Determinate progress: width tied to whether we're processing OR reconnecting.
                // No indeterminate animation -- EPD can't draw the bar pulse without ghosting.
                LinearProgressIndicator(
                    progress = { if (state.isProcessing || state.isReconnecting) 0.5f else 0f },
                    modifier = Modifier.fillMaxWidth().height(2.dp),
                    color = Ink,
                    trackColor = SoftChrome,
                )
            }
        }
    }
}

// ─── Cockpit ───────────────────────────────────────────────────────────────
@Composable
private fun BooxCockpit(
    state: StudioRuntimeState,
    prefs: AppPreferences,
    client: VoiceAgentClient,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    scope: kotlinx.coroutines.CoroutineScope,
    context: android.content.Context,
    onRequestMic: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    // Auto-scroll only when new content actually arrives (state.chatMessages.size changes).
    // NO smoothScroller, NO animateScrollToItem -- snap-to-bottom keeps EPD clean.
    LaunchedEffect(state.chatMessages.size, state.isProcessing) {
        if (state.chatMessages.isNotEmpty()) {
            listState.scrollToItem(state.chatMessages.size - 1)
        }
    }

    Column(modifier = modifier.fillMaxSize()) {

        // ─── Chat log ─────────────────────────────────────────────
        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .border(1.dp, Chrome, RoundedCornerShape(4.dp))
                .padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(state.chatMessages, key = { it.id }) { msg -> BooxChatBubble(msg) }
            if (state.chatMessages.isEmpty()) {
                item {
                    Text(
                        text = "Ready. Hold TALK to dictate, or type below.",
                        color = Color(0xFF666666),
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            if (state.isProcessing && state.latestReply.isBlank()) {
                item {
                    Text(
                        text = "...",
                        color = Ink,
                        fontSize = 14.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // ─── Latest reply (visible block so user can re-read without scrolling) ─
        if (state.latestReply.isNotBlank() && !state.isProcessing) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Paper,
                shape = RoundedCornerShape(4.dp),
                border = BorderStroke(1.dp, Ink)
            ) {
                Text(
                    text = state.latestReply,
                    color = Ink,
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(10.dp),
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
        }

        // ─── Text input ───────────────────────────────────────────
        BooxTextInput(
            value = state.textInputState,
            enabled = !state.isProcessing && !state.isRecording,
            onValueChange = { state.textInputState = it },
            onSend = {
                val prompt = state.textInputState
                if (prompt.isNotBlank()) {
                    sendTextTurn(
                        promptText = prompt,
                        state = state,
                        scope = scope,
                        context = context,
                        client = client,
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        prefs = prefs,
                    )
                }
            }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // ─── Action row: TALK (push-to-talk) / STOP / AUTO-SPEAK ──
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Local recording-start timestamp. Stays in the Boox composable rather than
            // on StudioRuntimeState so we don't widen the shared runtime state's surface.
            var recordingStartedAtMs by remember { mutableLongStateOf(0L) }
            TalkButton(
                isRecording = state.isRecording,
                isProcessing = state.isProcessing,
                onPress = {
                    // Caller has already armed the mic permission via onRequestMic.
                    // We start recording immediately; if permission isn't granted yet
                    // AudioHelper.startRecording returns null and state.isRecording stays false.
                    if (!state.isProcessing && !state.isRecording) {
                        recordingStartedAtMs = startVoiceRecording(state, audioHelper, ttsHelper)
                    }
                },
                onRelease = {
                    val startedAt = recordingStartedAtMs
                    if (startedAt > 0L && state.isRecording) {
                        stopAndSendVoiceTurn(
                            recordingStartedAtMs = startedAt,
                            state = state,
                            scope = scope,
                            client = client,
                            audioHelper = audioHelper,
                            ttsHelper = ttsHelper,
                            prefs = prefs,
                        )
                        recordingStartedAtMs = 0L
                    }
                },
                modifier = Modifier.weight(1f).heightIn(min = 64.dp),
            )

            StopButton(
                enabled = state.isProcessing,
                onClick = {
                    stopCurrentTurn(state, scope, client, audioHelper, ttsHelper, prefs)
                },
                modifier = Modifier.weight(1f).heightIn(min = 64.dp),
            )
        }

        // ─── Auto-speak toggle (checkbox-style button) ────────────
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = { prefs.autoSpeakEnabled = !prefs.autoSpeakEnabled },
                border = BorderStroke(1.dp, if (prefs.autoSpeakEnabled) Ink else Chrome),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = if (prefs.autoSpeakEnabled) "[x] AUTO-SPEAK" else "[ ] AUTO-SPEAK",
                    color = Ink,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(modifier = Modifier.width(8.dp))
            OutlinedButton(
                onClick = {
                    // Cancel any in-flight TTS / playback -- cheap way to interrupt a long reply
                    ttsHelper.stop()
                    audioHelper.stopPlayback()
                    state.playingMessageId = null
                },
                border = BorderStroke(1.dp, Chrome),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = "QUIET",
                    color = Ink,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(modifier = Modifier.weight(1f))
            Text(
                text = "v${BuildConfigEink.einkVersion}",
                color = Color(0xFF888888),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

// ─── Chat bubble (read-only render of a single ChatMessage) ────────────────
@Composable
private fun BooxChatBubble(msg: ChatMessage) {
    val (label, labelColor) = when (msg.role) {
        "user" -> "YOU" to Ink
        "assistant" -> "AGENT" to Ink
        "system" -> "! SYSTEM" to Ink
        "progress" -> "PROGRESS" to Color(0xFF555555)
        else -> msg.role.uppercase(Locale.US) to Ink
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Paper,
        shape = RoundedCornerShape(2.dp),
        border = BorderStroke(1.dp, SoftChrome)
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = label,
                    color = labelColor,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = formatTime(msg.timestampMs),
                    color = Color(0xFF888888),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            if (msg.text.isNotBlank()) {
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = msg.text,
                    color = Ink,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

private fun formatTime(ms: Long): String {
    if (ms <= 0L) return ""
    val sdf = SimpleDateFormat("HH:mm", Locale.US)
    return sdf.format(Date(ms))
}

// ─── Text input (no animation, multi-line, send button inline) ────────────
@Composable
private fun BooxTextInput(
    value: String,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Paper,
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, if (enabled) Ink else Chrome)
    ) {
        Row(
            modifier = Modifier.padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    textStyle = TextStyle(
                        color = if (enabled) Ink else Color(0xFF999999),
                        fontSize = 14.sp,
                        fontFamily = FontFamily.Monospace,
                    ),
                    cursorBrush = SolidColor(Ink),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (value.isEmpty()) {
                    Text(
                        text = "type a prompt...",
                        color = Color(0xFFAAAAAA),
                        fontSize = 14.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            Spacer(modifier = Modifier.width(8.dp))
            Button(
                onClick = onSend,
                enabled = enabled && value.isNotBlank(),
                shape = RoundedCornerShape(4.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Ink,
                    contentColor = Paper,
                    disabledContainerColor = Color(0xFFCCCCCC),
                    disabledContentColor = Color(0xFF777777),
                ),
                contentPadding = PaddingValues(horizontal = 18.dp, vertical = 10.dp),
            ) {
                Text(
                    text = "SEND",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

// ─── Talk button: hold to record, release to send ──────────────────────────
@Composable
private fun TalkButton(
    isRecording: Boolean,
    isProcessing: Boolean,
    onPress: () -> Unit,
    onRelease: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val container = when {
        isRecording -> Ink
        isProcessing -> Color(0xFFCCCCCC)
        else -> Paper
    }
    val content = if (isRecording) Paper else Ink
    Surface(
        modifier = modifier
            .then(
                if (!isProcessing) {
                    Modifier.pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) {
                                val down = awaitPointerEvent()
                                if (down.changes.any { it.pressed }) {
                                    onPress()
                                    var released = false
                                    while (!released) {
                                        val move = awaitPointerEvent()
                                        val anyPressed = move.changes.any { it.pressed }
                                        if (!anyPressed) {
                                            onRelease()
                                            released = true
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else Modifier
            )
            .border(1.dp, Ink, RoundedCornerShape(4.dp)),
        color = container,
        shape = RoundedCornerShape(4.dp),
    ) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text = when {
                    isRecording -> "● RECORDING — RELEASE TO SEND"
                    isProcessing -> "BUSY"
                    else -> "HOLD TO TALK"
                },
                color = content,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

// ─── Stop button ───────────────────────────────────────────────────────────
@Composable
private fun StopButton(
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        border = BorderStroke(if (enabled) 2.dp else 1.dp, if (enabled) Ink else Chrome),
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(
            text = if (enabled) "! STOP" else "STOP",
            color = if (enabled) Ink else Color(0xFFAAAAAA),
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

// ─── Hub pane: read-only gateway session dashboard including oh-my-pi lanes ─
private sealed class BooxHubUiState {
    data object Idle : BooxHubUiState()
    data object Loading : BooxHubUiState()
    data class Loaded(val dashboard: GatewaySessionDashboard) : BooxHubUiState()
    data object Empty : BooxHubUiState()
    data object Unauthorized : BooxHubUiState()
    data object Unsupported : BooxHubUiState()
    data object Network : BooxHubUiState()
    data object Malformed : BooxHubUiState()
    data class Error(val message: String) : BooxHubUiState()
}

private fun mapGatewayError(e: Throwable): BooxHubUiState = when (e) {
    is GatewaySessionException -> when (e.kind) {
        com.example.api.GatewaySessionErrorKind.Unauthorized -> BooxHubUiState.Unauthorized
        com.example.api.GatewaySessionErrorKind.Unsupported -> BooxHubUiState.Unsupported
        com.example.api.GatewaySessionErrorKind.Network -> BooxHubUiState.Network
        com.example.api.GatewaySessionErrorKind.Malformed -> BooxHubUiState.Malformed
        com.example.api.GatewaySessionErrorKind.Unknown -> BooxHubUiState.Error(e.message ?: "Unknown error")
    }
    else -> BooxHubUiState.Error(e.message ?: "Unknown error")
}

@Composable
private fun HubPane(state: BooxHubUiState) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .border(1.dp, Chrome, RoundedCornerShape(4.dp))
            .padding(8.dp)
    ) {
        Text(
            text = "GATEWAY SESSIONS (read-only)",
            color = Ink,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = "oh-my-pi background lanes appear under 'agent'. No control buttons: the gateway does not route turns to a specific lane today.",
            color = Color(0xFF555555),
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.height(8.dp))

        when (state) {
            BooxHubUiState.Idle, BooxHubUiState.Loading -> {
                Text(
                    text = "Loading...",
                    color = Ink,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            BooxHubUiState.Empty -> {
                Text(
                    text = "No sessions reported by gateway.",
                    color = Color(0xFF555555),
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            BooxHubUiState.Unauthorized -> {
                Text(
                    text = "! Gateway requires a token (set it in CFG).",
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            BooxHubUiState.Unsupported -> {
                Text(
                    text = "! Gateway does not expose /v1/sessions.",
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            BooxHubUiState.Network -> {
                Text(
                    text = "! Gateway unreachable. Tap HUB again to retry.",
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            BooxHubUiState.Malformed -> {
                Text(
                    text = "! Gateway returned unreadable data.",
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            is BooxHubUiState.Error -> {
                Text(
                    text = "! " + state.message,
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            is BooxHubUiState.Loaded -> {
                HubLoadedContent(state.dashboard)
            }
        }
    }
}

@Composable
private fun HubLoadedContent(dashboard: GatewaySessionDashboard) {
    val byKind = remember(dashboard) { groupSessionsByKind(dashboard.sessions) }
    val isOhMyPiGroupEmpty = byKind["oh-my-pi"].isNullOrEmpty()
    if (dashboard.sessions.isEmpty()) {
        Text(
            text = "No sessions reported by gateway.",
            color = Color(0xFF555555),
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
        )
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Surface oh-my-pi (background agent) lanes FIRST so the cockpit's headline feature
        // is the first thing the user sees. Read-only -- no "drive lane" button.
        val order = listOf("oh-my-pi", "codex", "remote", "other")
        for (kind in order) {
            val entries = byKind[kind].orEmpty()
            if (entries.isEmpty()) continue
            item(key = "header-$kind") {
                Text(
                    text = kindLabel(kind),
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
            items(entries, key = { it.sessionPath ?: it.name ?: it.path ?: it.hashCode().toString() }) { entry ->
                HubSessionRow(entry, dashboard)
            }
        }
        if (isOhMyPiGroupEmpty) {
            item(key = "omp-empty") {
                Text(
                    text = "No oh-my-pi background lanes running. Start one on the host (oh-my-pi 'agent mode') and it will appear here.",
                    color = Color(0xFF555555),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

@Composable
private fun HubSessionRow(entry: GatewaySessionEntry, dashboard: GatewaySessionDashboard) {
    // Each status gets BOTH a glyph ([+]/[*]/[~]/[ ]/[!]) and a label, plus a border
    // weight change so it survives EPD color loss. Text alone is unambiguous.
    val (statusGlyph, statusLabel, statusBorderWeight) = when {
        entry.isCurrentIn(dashboard) -> Triple("[+]", "current", 2.dp)
        entry.isReadyIn(dashboard) -> Triple("[+]", "ready", 2.dp)
        entry.activity.equals("busy", ignoreCase = true) -> Triple("[*]", "running", 1.dp)
        entry.activity.equals("idle", ignoreCase = true) -> Triple("[~]", "idle", 1.dp)
        entry.activity.isNullOrBlank() -> Triple("[ ]", "—", 1.dp)
        else -> Triple("[!]", entry.activity, 1.dp)
    }
    @Suppress("UNUSED_VARIABLE") val _unused = Ink
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Paper,
        shape = RoundedCornerShape(2.dp),
        border = BorderStroke(1.dp, SoftChrome)
    ) {
        Column(modifier = Modifier.padding(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = entry.name.ifBlank { "(unnamed)" },
                    color = Ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "$statusGlyph $statusLabel",
                    color = Ink,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.border(statusBorderWeight, Ink, RoundedCornerShape(2.dp))
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
            val subtitle = buildString {
                entry.model?.takeIf { it.isNotBlank() }?.let { append(it); if (!entry.role.isNullOrBlank()) append(" · ") }
                entry.role?.takeIf { it.isNotBlank() }?.let { append(it) }
                if (isNotEmpty()) append(" · ")
                append(entry.displayCwd)
            }
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    color = Color(0xFF555555),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (entry.subagents.isNotEmpty()) {
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = "subagents: ${entry.subagents.joinToString(", ") { it.name.ifBlank { it.id } }}",
                    color = Color(0xFF555555),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun kindLabel(kind: String): String = when (kind) {
    "oh-my-pi" -> "AGENT (oh-my-pi background lanes)"
    "codex" -> "CODEX"
    "remote" -> "REMOTE"
    else -> "OTHER"
}

private fun groupSessionsByKind(sessions: List<GatewaySessionEntry>): Map<String, List<GatewaySessionEntry>> {
    val out = mutableMapOf<String, MutableList<GatewaySessionEntry>>()
    for (entry in sessions) {
        val key = when {
            entry.source.equals("oh-my-pi", ignoreCase = true) -> "oh-my-pi"
            entry.kind.equals("background", ignoreCase = true) -> "oh-my-pi"
            entry.provider.equals("codex", ignoreCase = true) -> "codex"
            entry.provider.equals("remote", ignoreCase = true) -> "remote"
            else -> "other"
        }
        out.getOrPut(key) { mutableListOf() }.add(entry)
    }
    return out
}

// ─── Settings pane (minimal — the things a Palma user actually needs) ─────
@Composable
private fun SettingsPane(prefs: AppPreferences, onSave: () -> Unit, onClose: () -> Unit) {
    var gateway by remember { mutableStateOf(prefs.targetIpAddress) }
    var token by remember { mutableStateOf(prefs.remoteToken) }
    var session by remember { mutableStateOf(prefs.codexSessionName) }
    var agent by remember { mutableStateOf(prefs.activeAgent) }
    var showProgress by remember { mutableStateOf(prefs.showTurnProgress) }
    var speakProgress by remember { mutableStateOf(prefs.speakTurnProgress) }
    var savedHint by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .border(1.dp, Chrome, RoundedCornerShape(4.dp))
            .padding(8.dp)
    ) {
        Text(
            text = "SETTINGS",
            color = Ink,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.height(8.dp))

        SettingsRow("Gateway URL", gateway) { gateway = it; savedHint = false }
        SettingsRow("Token", token) { token = it; savedHint = false }
        SettingsRow("Session name", session) { session = it; savedHint = false }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = {
                    prefs.targetIpAddress = gateway.trim()
                    prefs.remoteToken = token.trim()
                    prefs.codexSessionName = session.trim()
                    prefs.activeAgent = agent.trim()
                    prefs.showTurnProgress = showProgress
                    prefs.speakTurnProgress = speakProgress
                    savedHint = true
                    onSave()
                },
                shape = RoundedCornerShape(4.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Text("SAVE", fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            }
            Spacer(modifier = Modifier.width(8.dp))
            OutlinedButton(
                onClick = onClose,
                border = BorderStroke(1.dp, Ink),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            ) {
                Text("BACK", fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, color = Ink)
            }
            Spacer(modifier = Modifier.weight(1f))
            if (savedHint) {
                Text("[OK] Saved.", color = Ink, fontSize = 11.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun SettingsRow(label: String, value: String, onChange: (String) -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(
            text = label,
            color = Color(0xFF555555),
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
        )
        BasicTextField(
            value = value,
            onValueChange = onChange,
            textStyle = TextStyle(color = Ink, fontSize = 13.sp, fontFamily = FontFamily.Monospace),
            cursorBrush = SolidColor(Ink),
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, Chrome, RoundedCornerShape(2.dp))
                .padding(6.dp),
        )
    }
}

@Composable
private fun ToggleRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        OutlinedButton(
            onClick = { onChange(!value) },
            border = BorderStroke(1.dp, if (value) Ink else Chrome),
            shape = RoundedCornerShape(2.dp),
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
        ) {
            Text(
                text = if (value) "[x]" else "[ ]",
                color = Ink,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(text = label, color = Ink, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    }
}

// ─── Version stamp pulled from BuildConfig.IS_EINK so the eink flavor stamps itself ─
private object BuildConfigEink {
    val einkVersion: String = if (BuildConfig.IS_EINK) "boox" else "standard"
}
