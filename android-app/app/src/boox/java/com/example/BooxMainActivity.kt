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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import com.example.RealtimeVoiceSession
import com.example.RealtimeVoiceSessionListener
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
import com.example.api.GatewaySessionException
import com.example.api.VoiceAgentClient
import com.example.audio.AudioHelper
import com.example.audio.InterruptedPcmFreezeDisposition
import com.example.audio.LiveAudioInterruptCoordinator
import com.example.audio.StreamingPcmPlayer
import com.example.audio.StreamingPcmRecorder
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
 *   - ACTIONABLE OH-MY-PI LANE VIEW. The Hub peek surfaces the gateway session dashboard,
 *     which already merges background lanes from `~/.omp/agent/sessions/` followed by `*.jsonl`,
 *     plus a task launcher and, per lane, a chat composer and a two-step archive control backed
 *     by `/v1/herdr/agent/:id/{chat,kill}`. Deliberately no live-streaming transcript here: EPD
 *     ghosting comes from frequent partial redraws, so lane detail refreshes on the same 10s
 *     poll as the rest of the Hub peek instead of tailing an SSE feed line-by-line.
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
        val setup = parseSetupDeepLink(intent?.data) ?: return
        applySetupDeepLink(prefs, setup)
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
private val EpdInkMuted = Color(0xFF555555)
private val EpdInkQuiet = Color(0xFF777777)
private val EpdInkDisabled = Color(0xFFAAAAAA)
private val EpdChromeDisabled = Color(0xFFCCCCCC)
private val EpdChromeSelected = Color(0xFFE8E8E8)

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

    // Hub visibility is part of cockpit UX: the gateway dashboard including oh-my-pk background
    // lanes, a task launcher, and per-lane chat/archive controls (see HubPane).
    var showHub by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var forceCheckTrigger by remember { mutableIntStateOf(0) }
    var unreachableSinceMs by remember { mutableStateOf<Long?>(null) }

    // Continuous connection loop mirroring MainActivity.kt: polls ping/auto-connect
    // every 5s so the UI dynamically adapts when the reverse tunnel is enabled.
    // Restarts immediately when settings change (forceCheckTrigger increments).
    LaunchedEffect(forceCheckTrigger) {
        // Debounce: opening the Hub starts polling the heavy /v1/sessions dashboard, which can
        // briefly stall the single-threaded gateway so the very next 1.5s/3s /health ping times
        // out. A SINGLE missed ping must NOT flip the global connection state to reconnecting --
        // we keep showing the last-good "Connected" state until we miss at least twice in a row.
        var consecutiveFailures = 0
        while (true) {
            val startTime = System.currentTimeMillis()
            val healthy = withContext(Dispatchers.IO) { client.pingHealth() }
            val latency = System.currentTimeMillis() - startTime
            if (healthy) {
                consecutiveFailures = 0
                unreachableSinceMs = null
                state.isGatewayConnected = true
                state.isReconnecting = false
                state.connectionLatencyMs = latency
                state.connectionStatusText = "Connected"
                state.connectionBannerText = ""
            } else {
                consecutiveFailures += 1
                val firstFailureMs = unreachableSinceMs ?: System.currentTimeMillis()
                unreachableSinceMs = firstFailureMs
                // First miss: hold the last-good state (likely just a dashboard-induced stall).
                if (consecutiveFailures < 2) {
                    delay(5_000)
                    continue
                }
                state.isGatewayConnected = false
                state.isReconnecting = true
                state.connectionStatusText = "Reconnecting..."
                val result = withContext(Dispatchers.IO) { client.tryAutoConnect(forceVerify = true) }
                if (result.connected) {
                    consecutiveFailures = 0
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
                        HubPane(
                            state = hubState,
                            client = client,
                            prefs = prefs,
                            scope = scope,
                        )
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
    onToggleHub: () -> Unit,
    onToggleSettings: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "Pi Speak",
                color = Ink,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(modifier = Modifier.height(2.dp))
            val statusPrefix = when {
                state.isGatewayConnected -> "OK"
                state.isReconnecting -> "WAIT"
                else -> "ERROR"
            }
            Text(
                text = "$statusPrefix ${state.connectionStatusText}",
                color = Ink,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(modifier = Modifier.width(8.dp))
        OutlinedButton(
            onClick = onToggleHub,
            modifier = Modifier.heightIn(min = 56.dp),
            border = BorderStroke(1.dp, Chrome),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text("Hub", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(modifier = Modifier.width(6.dp))
        OutlinedButton(
            onClick = onToggleSettings,
            modifier = Modifier.heightIn(min = 56.dp),
            border = BorderStroke(1.dp, Chrome),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
        ) {
            Text("Settings", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Bold)
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

// ─── Session selector (working dir + recent omp sessions in that dir) ─────────
@Composable
private fun SessionSelector(
    expanded: Boolean,
    onToggle: () -> Unit,
    projects: List<String>,
    selectedProject: String,
    onSelectProject: (String) -> Unit,
    recentSessions: List<GatewaySessionEntry>,
    selectedSessionName: String,
    onSelectSession: (GatewaySessionEntry) -> Unit,
    status: String,
) {
    val stripLabel = buildString {
        append(if (selectedProject.isNotBlank()) selectedProject else "no project")
        if (selectedSessionName.isNotBlank()) { append(" / "); append(selectedSessionName) }
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Paper,
        shape = RoundedCornerShape(3.dp),
        border = BorderStroke(1.dp, if (expanded) Ink else SoftChrome),
    ) {
        Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
            // ── Collapsed strip: single tap-target showing current selection ──
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .clickable(onClick = onToggle)
                    .semantics {
                        contentDescription = if (expanded) {
                            "Collapse session selector. Current selection: $stripLabel"
                        } else {
                            "Open session selector. Current selection: $stripLabel"
                        }
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Session",
                    color = Ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = stripLabel,
                    color = if (selectedSessionName.isNotBlank()) Ink else EpdInkQuiet,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = if (expanded) "−" else "+",
                    color = Ink,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                )
            }

            if (expanded) {
                Spacer(modifier = Modifier.height(6.dp))

                // ── Working directory row ─────────────────────────────────────
                Text(
                    text = "WORKING DIR",
                    color = Ink,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(modifier = Modifier.height(4.dp))
                if (projects.isEmpty()) {
                    Text(
                        text = "Loading projects...",
                        color = EpdInkQuiet,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                } else {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(projects, key = { it }) { name ->
                            val sel = name == selectedProject
                            Surface(
                                modifier = Modifier
                                    .heightIn(min = 56.dp)
                                    .clickable { onSelectProject(name) },
                                color = if (sel) Ink else Paper,
                                shape = RoundedCornerShape(3.dp),
                                border = BorderStroke(if (sel) 2.dp else 1.dp, if (sel) Ink else SoftChrome),
                            ) {
                                Text(
                                    text = name,
                                    color = if (sel) Paper else Ink,
                                    fontSize = 11.sp,
                                    fontFamily = FontFamily.Monospace,
                                    fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                )
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                // ── Recent sessions (last 24h by lastActivity) ────────────────
                Text(
                    text = "RECENT SESSIONS  (last 24h)",
                    color = Ink,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(modifier = Modifier.height(4.dp))
                if (recentSessions.isEmpty()) {
                    Text(
                        text = if (selectedProject.isBlank()) "Select a project above."
                               else "No sessions used in the last 24h for $selectedProject.",
                        color = EpdInkQuiet,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        recentSessions.take(8).forEach { entry ->
                            val sel = entry.name == selectedSessionName
                            val ago = entry.lastActivity?.let { formatAgo(it) } ?: "?"
                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 56.dp)
                                    .clickable { onSelectSession(entry) },
                                color = if (sel) EpdChromeSelected else Paper,
                                shape = RoundedCornerShape(2.dp),
                                border = BorderStroke(if (sel) 2.dp else 1.dp, if (sel) Ink else SoftChrome),
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = if (sel) "[*]" else "[ ]",
                                        color = Ink,
                                        fontSize = 10.sp,
                                        fontFamily = FontFamily.Monospace,
                                        modifier = Modifier.padding(end = 6.dp),
                                    )
                                    Text(
                                        text = entry.name.ifBlank { "(unnamed)" },
                                        color = Ink,
                                        fontSize = 11.sp,
                                        fontFamily = FontFamily.Monospace,
                                        fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(
                                        text = ago,
                                        color = EpdInkMuted,
                                        fontSize = 10.sp,
                                        fontFamily = FontFamily.Monospace,
                                    )
                                }
                            }
                        }
                    }
                }

                if (status.isNotBlank()) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = status,
                        color = Ink,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

private fun formatAgo(timestampMs: Long): String {
    val diff = System.currentTimeMillis() - timestampMs
    val mins = diff / 60_000
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "${mins}m ago"
        mins < 1440 -> "${mins / 60}h ago"
        else -> "${mins / 1440}d ago"
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
    LaunchedEffect(state.chatMessages.size, state.isProcessing) {
        if (state.chatMessages.isNotEmpty()) {
            listState.scrollToItem(state.chatMessages.size - 1)
        }
    }

    // ─── Session selector state ───────────────────────────────────────────────
    var selectorExpanded by remember { mutableStateOf(false) }
    var projectsBase by remember { mutableStateOf("") }
    var projects by remember { mutableStateOf<List<String>>(emptyList()) }
    var selectedProject by remember { mutableStateOf(prefs.workspacePath.substringAfterLast("/").substringAfterLast("\\")) }
    var recentSessions by remember { mutableStateOf<List<GatewaySessionEntry>>(emptyList()) }
    var selectedSessionName by remember { mutableStateOf("") }
    var selectorStatus by remember { mutableStateOf("") }

    LaunchedEffect(selectorExpanded) {
        if (!selectorExpanded) return@LaunchedEffect
        val (base, list) = withContext(kotlinx.coroutines.Dispatchers.IO) { client.listProjects() }
        projectsBase = base
        projects = list
        if (selectedProject.isBlank() && list.isNotEmpty()) selectedProject = list.first()
    }

    val cutoffMs = 24L * 60 * 60 * 1000
    LaunchedEffect(selectorExpanded, selectedProject, projectsBase) {
        if (!selectorExpanded || selectedProject.isBlank()) return@LaunchedEffect
        val dashboard = runCatching {
            withContext(kotlinx.coroutines.Dispatchers.IO) { client.getSessionDashboard() }
        }.getOrNull() ?: return@LaunchedEffect
        val now = System.currentTimeMillis()
        val targetCwd = if (projectsBase.isNotBlank()) "$projectsBase/$selectedProject" else selectedProject
        recentSessions = dashboard.sessions.filter { entry ->
            val last = entry.lastActivity ?: return@filter false
            val cwdMatch = listOf(entry.cwd, entry.workingDirectory)
                .filterNotNull()
                .any { c -> c.replace("\\", "/").contains(selectedProject, ignoreCase = true) }
            cwdMatch && (now - last) <= cutoffMs
        }.sortedByDescending { it.lastActivity }
    }

    // ─── Live mode state ─────────────────────────────────────────────────────
    var liveSessionActive by remember { mutableStateOf(false) }
    val liveSessionRef = remember { mutableStateOf<RealtimeVoiceSession?>(null) }
    val liveRecorderRef = remember { mutableStateOf<StreamingPcmRecorder?>(null) }
    val livePlayerRef = remember { mutableStateOf<StreamingPcmPlayer?>(null) }
    var hasInterruptedLiveAudio by remember { mutableStateOf(false) }
    val replayingInterruptedAudio = remember {
        java.util.concurrent.atomic.AtomicReference<StreamingPcmPlayer?>(null)
    }
    val liveInterruptCoordinatorRef = remember {
        java.util.concurrent.atomic.AtomicReference<LiveAudioInterruptCoordinator?>(null)
    }
    var approvalDialogState by remember { mutableStateOf<Triple<String, String, String>?>(null) }
    val liveTranscriptBufferRef = remember { mutableStateOf<RealtimeTranscriptBuffer?>(null) }
    val approvalRejectionGuard = remember { TerminalApprovalRejectionGuard() }

    // Ensure resources are released if the cockpit leaves the composition.
    DisposableEffect(Unit) {
        onDispose {
            val disposedPlayer = livePlayerRef.value
            liveRecorderRef.value?.stop()
            liveSessionRef.value?.disconnect()
            disposedPlayer?.close()
            replayingInterruptedAudio.compareAndSet(disposedPlayer, null)
            liveInterruptCoordinatorRef.getAndSet(null)?.reset()
            liveTranscriptBufferRef.value?.close()
            hasInterruptedLiveAudio = false
        }
    }

    fun freezeLiveAudioForInterrupt(
        session: RealtimeVoiceSession,
        player: StreamingPcmPlayer,
        coordinator: LiveAudioInterruptCoordinator,
    ): InterruptedPcmFreezeDisposition {
        val disposition = player.freezeInterruptedAudio()
        if (disposition == InterruptedPcmFreezeDisposition.CAPTURED) {
            scope.launch {
                if (
                    liveSessionRef.value === session &&
                    livePlayerRef.value === player &&
                    liveInterruptCoordinatorRef.get() === coordinator
                ) {
                    hasInterruptedLiveAudio = true
                }
            }
        }
        return disposition
    }

    fun interruptLiveAudio() {
        val session = liveSessionRef.value ?: return
        val player = livePlayerRef.value ?: return
        val coordinator = liveInterruptCoordinatorRef.get() ?: return
        val disposition = freezeLiveAudioForInterrupt(session, player, coordinator)
        if (
            liveSessionRef.value === session &&
            livePlayerRef.value === player &&
            liveInterruptCoordinatorRef.get() === coordinator &&
            coordinator.shouldSendLocalInterrupt(disposition)
        ) {
            session.sendInterrupt()
        }
        player.stop()
        player.start()
    }
    fun rejectApproval(approvalId: String) {
        if (approvalRejectionGuard.rejectOnce(approvalId) { liveSessionRef.value?.rejectTerminal(it) ?: false }) {
            appendChat(state, prefs, "system", "[live] Command rejected by user.")
        }
        approvalDialogState = null
    }

    // ─── Realtime terminal-command approval dialog ────────────────────────────
    approvalDialogState?.let { (approvalId, command, reason) ->
        AlertDialog(
            onDismissRequest = { rejectApproval(approvalId) },
            title = {
                Text(
                    text = "APPROVE COMMAND?",
                    color = Ink,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            },
            text = {
                Column {
                    Text(
                        text = command,
                        color = Ink,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                    if (reason.isNotBlank()) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = reason,
                            color = EpdInkMuted,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        approvalRejectionGuard.clear(approvalId)
                        liveSessionRef.value?.approveTerminal(approvalId)
                        approvalDialogState = null
                    },
                    modifier = Modifier.heightIn(min = 56.dp),
                ) {
                    Text(
                        text = "APPROVE",
                        color = Ink,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { rejectApproval(approvalId) },
                    modifier = Modifier.heightIn(min = 56.dp),
                ) {
                    Text(
                        text = "REJECT",
                        color = Ink,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            },
            containerColor = Paper,
            tonalElevation = 0.dp,
        )
    }

    Column(modifier = modifier.fillMaxSize()) {

        // ─── Chat log ─────────────────────────────────────────────
        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .border(1.dp, Chrome, RoundedCornerShape(4.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(state.chatMessages, key = { it.id }) { msg -> BooxChatBubble(msg) }
            if (state.chatMessages.isEmpty()) {
                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 32.dp),
                    ) {
                        Text(
                            text = "Ready when you are",
                            color = Ink,
                            fontSize = 18.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Choose a session, then type a prompt or hold Talk.",
                            color = EpdInkMuted,
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                        )
                    }
                }
            }
            if (state.isProcessing && state.latestReply.isBlank()) {
                item {
                    Text(
                        text = "[WORK] Agent is responding",
                        color = Ink,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(6.dp))

        // ─── Session selector strip ───────────────────────────────────────────
        SessionSelector(
            expanded = selectorExpanded,
            onToggle = { selectorExpanded = !selectorExpanded },
            projects = projects,
            selectedProject = selectedProject,
            onSelectProject = { name ->
                selectedProject = name
                val fullPath = if (projectsBase.isNotBlank()) "$projectsBase/$name" else name
                prefs.workspacePath = fullPath
            },
            recentSessions = recentSessions,
            selectedSessionName = selectedSessionName,
            onSelectSession = { entry ->
                val path = entry.canonicalSessionPath ?: return@SessionSelector
                scope.launch {
                    val msg = client.selectOmpSession(path)
                    selectedSessionName = entry.name
                    selectorStatus = msg
                    selectorExpanded = false
                }
            },
            status = selectorStatus,
        )

        Spacer(modifier = Modifier.height(6.dp))


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

        // ─── Voice actions: Talk leads; Live and Stop stay secondary ─────────
        Row(
            modifier = Modifier.fillMaxWidth().height(64.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Local recording-start timestamp and auto-stop job for the 90s cap.
            var recordingStartedAtMs by remember { mutableLongStateOf(0L) }
            var maxRecordingJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
            // HOLD TO TALK is disabled when live mode is active.
            TalkButton(
                isRecording = state.isRecording,
                isProcessing = state.isProcessing || liveSessionActive,
                onPress = {
                    if (!state.isProcessing && !state.isRecording && !liveSessionActive) {
                        val micGranted = androidx.core.content.ContextCompat.checkSelfPermission(
                            context, Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED
                        if (!micGranted) {
                            appendChat(state, prefs, "system",
                                "Microphone permission is required. Tap again to grant it, or enable it in Settings → Apps → Pi Speak → Permissions.")
                            onRequestMic()
                        } else {
                            recordingStartedAtMs = startVoiceRecording(state, audioHelper, ttsHelper)
                            maxRecordingJob = scope.launch {
                                delay(90_000L)
                                if (state.isRecording) {
                                    appendChat(state, prefs, "system",
                                        "Recording auto-stopped after 90 seconds.")
                                    val startedAt = recordingStartedAtMs
                                    if (startedAt > 0L) {
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
                                }
                            }
                        }
                    }
                },
                onRelease = {
                    maxRecordingJob?.cancel()
                    maxRecordingJob = null
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
                modifier = Modifier.weight(1.7f),
            )

            // LIVE toggle: starts / stops a full-duplex Gemini realtime voice session.
            LiveButton(
                isActive = liveSessionActive,
                onClick = {
                    if (liveSessionActive) {
                        val stoppedPlayer = livePlayerRef.value
                        liveRecorderRef.value?.stop()
                        liveSessionRef.value?.disconnect()
                        stoppedPlayer?.close()
                        replayingInterruptedAudio.compareAndSet(stoppedPlayer, null)
                        liveInterruptCoordinatorRef.getAndSet(null)?.reset()
                        liveSessionRef.value = null
                        liveRecorderRef.value = null
                        livePlayerRef.value = null
                        liveSessionActive = false
                        hasInterruptedLiveAudio = false
                        liveTranscriptBufferRef.value?.close()
                    } else {
                        // Toggle ON — check mic permission then start.
                        val micGranted = ContextCompat.checkSelfPermission(
                            context, Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED
                        if (!micGranted) {
                            appendChat(state, prefs, "system",
                                "Microphone permission is required for Live mode. Tap LIVE again after granting it.")
                            onRequestMic()
                        } else {
                            val interruptCoordinator = LiveAudioInterruptCoordinator()
                            val player = StreamingPcmPlayer()
                            val recorder = StreamingPcmRecorder(context)
                            val transcriptBuffer = RealtimeTranscriptBuffer()
                            val livePreferences = context.getSharedPreferences(
                                "pi_speak_prefs",
                                android.content.Context.MODE_PRIVATE,
                            )
                            liveTranscriptBufferRef.value = transcriptBuffer
                            lateinit var session: RealtimeVoiceSession
                            session = RealtimeVoiceSession(
                                prefs = prefs,
                                listener = object : RealtimeVoiceSessionListener {
                                    override fun onConnected(sessionId: String) {
                                        if (liveSessionRef.value !== session) return
                                        // Prepare playback and start streaming mic audio.
                                        player.start()
                                        recorder.start { seqId, pcm ->
                                            val replaying = replayingInterruptedAudio.get() != null
                                            val isCurrentSession = liveSessionRef.value === session
                                            if (!replaying && isCurrentSession) {
                                                session.sendAudioChunk(seqId, pcm)
                                            }
                                            if (
                                                !replaying &&
                                                isCurrentSession &&
                                                player.isPlaying &&
                                                livePreferences.getBoolean("vad_enabled", true) &&
                                                pcmPeakAmplitude(pcm) >
                                                    livePreferences.getFloat("vad_threshold", 1500f).toInt()
                                            ) {
                                                interruptLiveAudio()
                                            }
                                        }
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            appendChat(
                                                state,
                                                prefs,
                                                "system",
                                                "[live] Connected: $sessionId",
                                            )
                                        }
                                    }

                                    override fun onAudioChunk(seqId: Int, pcm: ByteArray) {
                                        if (liveSessionRef.value !== session) return
                                        if (interruptCoordinator.beginAssistantTurn()) {
                                            player.beginAssistantAudioSegment()
                                        }
                                        player.write(seqId, pcm)
                                    }

                                    override fun onTranscript(text: String, role: String) {
                                        if (liveSessionRef.value !== session || role == "user") return
                                        if (interruptCoordinator.beginAssistantTurn()) {
                                            player.beginAssistantAudioSegment()
                                        }
                                        transcriptBuffer.append(text)
                                    }

                                    override fun onTranscriptComplete(role: String) {
                                        if (liveSessionRef.value !== session || role == "user") return
                                        val completedText = transcriptBuffer.drain()
                                        val completedAudio = player.completeAssistantAudioSegment()
                                        interruptCoordinator.completeAssistantTurn()
                                        scope.launch(Dispatchers.IO) {
                                            player.discardCompletedAudioSegmentAfterPlayback(completedAudio)
                                        }
                                        if (completedText.isNotBlank()) {
                                            scope.launch {
                                                if (liveSessionRef.value !== session) return@launch
                                                appendChat(state, prefs, "assistant", completedText)
                                            }
                                        }
                                    }

                                    override fun onInterrupt() {
                                        if (liveSessionRef.value !== session) return
                                        freezeLiveAudioForInterrupt(
                                            session,
                                            player,
                                            interruptCoordinator,
                                        )
                                        interruptCoordinator.receiveInterrupt()
                                        player.stop()
                                        player.start()
                                        transcriptBuffer.discardCurrentTurn()
                                    }

                                    override fun onToolStart(name: String) {
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            appendChat(state, prefs, "system", "[tool] $name")
                                        }
                                    }

                                    override fun onToolComplete(name: String, output: String) {
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            appendChat(
                                                state,
                                                prefs,
                                                "system",
                                                "[tool done] $name: ${output.take(200)}",
                                            )
                                        }
                                    }

                                    override fun onApprovalRequired(
                                        approvalId: String,
                                        command: String,
                                        reason: String,
                                        cwd: String,
                                        timeoutMs: Int,
                                    ) {
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            approvalDialogState = Triple(approvalId, command, reason)
                                        }
                                    }

                                    override fun onApprovalResolved(approvalId: String) {
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            approvalRejectionGuard.clear(approvalId)
                                            if (approvalDialogState?.first == approvalId) {
                                                approvalDialogState = null
                                            }
                                        }
                                    }

                                    override fun onCameraCapture(callId: String, reason: String) {
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            appendChat(state, prefs, "system", "[camera] ${reason.ifBlank { "Capturing frame…" }}")
                                            if (!com.example.audio.CameraSnapshot.hasPermission(context)) {
                                                try {
                                                    (context as? android.app.Activity)?.requestPermissions(
                                                        arrayOf(android.Manifest.permission.CAMERA),
                                                        0xCA,
                                                    )
                                                } catch (_: Exception) { }
                                                session.sendCameraFrame(callId, "image/jpeg", "", "Camera permission required for Live snapshot")
                                                appendChat(state, prefs, "system", "[camera] Grant CAMERA permission and ask again")
                                                return@launch
                                            }
                                            val owner = context as? androidx.lifecycle.LifecycleOwner
                                            val frame = if (owner != null) {
                                                try {
                                                    com.example.audio.CameraSnapshot.captureJpegBase64(context, owner)
                                                } catch (_: Exception) {
                                                    null
                                                }
                                            } else null
                                            if (frame == null) {
                                                session.sendCameraFrame(callId, "image/jpeg", "", "Camera capture failed or permission denied")
                                                appendChat(state, prefs, "system", "[camera] Capture failed")
                                            } else {
                                                session.sendCameraFrame(callId, frame.mimeType, frame.base64, reason)
                                                appendChat(state, prefs, "system", "[camera] Frame sent")
                                            }
                                        }
                                    }

                                    override fun onAudioFormat(rate: Int) {
                                        if (liveSessionRef.value !== session) return
                                        player.setSampleRate(rate)
                                        if (player.isPlaying) {
                                            player.stop()
                                            player.start()
                                        }
                                    }

                                    override fun onError(message: String, httpCode: Int?) {
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            appendChat(state, prefs, "system",
                                                "[live error] $message")
                                            recorder.stop()
                                            player.close()
                                            replayingInterruptedAudio.compareAndSet(player, null)
                                            liveInterruptCoordinatorRef.compareAndSet(interruptCoordinator, null)
                                            interruptCoordinator.reset()
                                            liveSessionRef.value = null
                                            liveRecorderRef.value = null
                                            livePlayerRef.value = null
                                            liveSessionActive = false
                                            hasInterruptedLiveAudio = false
                                            transcriptBuffer.close()
                                        }
                                    }

                                    override fun onDisconnected() {
                                        scope.launch {
                                            if (liveSessionRef.value !== session) return@launch
                                            if (liveSessionActive) {
                                                appendChat(state, prefs, "system",
                                                    "[live] Disconnected.")
                                            }
                                            recorder.stop()
                                            player.close()
                                            replayingInterruptedAudio.compareAndSet(player, null)
                                            liveInterruptCoordinatorRef.compareAndSet(interruptCoordinator, null)
                                            interruptCoordinator.reset()
                                            liveSessionRef.value = null
                                            liveRecorderRef.value = null
                                            livePlayerRef.value = null
                                            liveSessionActive = false
                                            hasInterruptedLiveAudio = false
                                            transcriptBuffer.close()
                                        }
                                    }
                                }
                            )
                            liveSessionRef.value = session
                            liveRecorderRef.value = recorder
                            livePlayerRef.value = player
                            liveInterruptCoordinatorRef.set(interruptCoordinator)
                            liveSessionActive = true
                            session.connect()
                        }
                    }
                },
                modifier = Modifier.weight(0.75f),
            )

            if (hasInterruptedLiveAudio) {
                ReplayButton(
                    onClick = {
                        val session = liveSessionRef.value ?: return@ReplayButton
                        val player = livePlayerRef.value ?: return@ReplayButton
                        val coordinator = liveInterruptCoordinatorRef.get() ?: return@ReplayButton
                        if (!replayingInterruptedAudio.compareAndSet(null, player)) return@ReplayButton
                        scope.launch {
                            try {
                                val replayed = withContext(Dispatchers.IO) {
                                    player.replayInterruptedAudio()
                                }
                                if (
                                    !replayed &&
                                    liveSessionRef.value === session &&
                                    livePlayerRef.value === player &&
                                    liveInterruptCoordinatorRef.get() === coordinator &&
                                    !player.hasRetainedInterruptedAudio()
                                ) {
                                    hasInterruptedLiveAudio = false
                                }
                            } finally {
                                replayingInterruptedAudio.compareAndSet(player, null)
                            }
                        }
                    },
                    modifier = Modifier.weight(0.75f),
                )
            }

            // STOP: cancels an in-flight HTTP turn OR interrupts Gemini mid-speech in live mode.
            StopButton(
                enabled = state.isProcessing || liveSessionActive,
                onClick = {
                    if (liveSessionActive) {
                        interruptLiveAudio()
                    } else {
                        stopCurrentTurn(state, scope, client, audioHelper, ttsHelper, prefs)
                    }
                },
                modifier = Modifier.weight(0.75f),
            )
        }

        // ─── Speak-replies toggle: controls audio output for both text and voice turns ─
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = { prefs.autoSpeakEnabled = !prefs.autoSpeakEnabled },
                modifier = Modifier.heightIn(min = 56.dp),
                border = BorderStroke(1.dp, if (prefs.autoSpeakEnabled) Ink else Chrome),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = if (prefs.autoSpeakEnabled) "Speak on" else "Speak off",
                    color = Ink,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.SansSerif,
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
                modifier = Modifier.heightIn(min = 56.dp),
                border = BorderStroke(1.dp, Chrome),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = "Quiet",
                    color = Ink,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.SansSerif,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ─── Chat bubble (read-only render of a single ChatMessage) ────────────────
@Composable
private fun BooxChatBubble(msg: ChatMessage) {
    val label = when (msg.role) {
        "user" -> "You"
        "assistant" -> "Agent"
        "system" -> "System"
        "progress" -> "Status"
        else -> msg.role.replaceFirstChar { it.titlecase(Locale.US) }
    }
    val messageSurface = if (msg.role == "user") SoftChrome else Paper
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = messageSurface,
        shape = RoundedCornerShape(3.dp),
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = label,
                    color = if (msg.role == "progress") EpdInkMuted else Ink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = formatTime(msg.timestampMs),
                    color = EpdInkQuiet,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            if (msg.text.isNotBlank()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = msg.text,
                    color = Ink,
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
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
        modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp),
        color = Paper,
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, if (enabled) Ink else Chrome)
    ) {
        Row(
            modifier = Modifier.padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(modifier = Modifier.weight(1f).heightIn(min = 56.dp)) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    textStyle = TextStyle(
                        color = if (enabled) Ink else EpdInkDisabled,
                        fontSize = 15.sp,
                        lineHeight = 21.sp,
                    ),
                    cursorBrush = SolidColor(Ink),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 14.dp)
                        .semantics { contentDescription = "Prompt" },
                )
                if (value.isEmpty()) {
                    Text(
                        text = "Ask Pi Speak…",
                        color = EpdInkDisabled,
                        fontSize = 15.sp,
                        modifier = Modifier.padding(vertical = 14.dp),
                    )
                }
            }
            Spacer(modifier = Modifier.width(8.dp))
            Button(
                onClick = onSend,
                enabled = enabled && value.isNotBlank(),
                modifier = Modifier.heightIn(min = 56.dp),
                shape = RoundedCornerShape(4.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Ink,
                    contentColor = Paper,
                    disabledContainerColor = EpdChromeDisabled,
                    disabledContentColor = EpdInkQuiet,
                ),
                contentPadding = PaddingValues(horizontal = 18.dp, vertical = 10.dp),
            ) {
                Text(
                    text = "Send",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
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
        isProcessing -> EpdChromeDisabled
        else -> Paper
    }
    val content = if (isRecording) Paper else Ink
    val description = when {
        isRecording -> "Recording. Release to send."
        isProcessing -> "Talk unavailable while working."
        else -> "Hold to talk. Release to send."
    }
    Surface(
        modifier = modifier
            .semantics { contentDescription = description }
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
            .border(if (isRecording) 2.dp else 1.dp, Ink, RoundedCornerShape(4.dp)),
        color = container,
        shape = RoundedCornerShape(4.dp),
    ) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text = when {
                    isRecording -> "[REC] Release to send"
                    isProcessing -> "Working"
                    else -> "Hold to talk"
                },
                color = content,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
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
        modifier = modifier.heightIn(min = 56.dp),
        border = BorderStroke(if (enabled) 2.dp else 1.dp, if (enabled) Ink else Chrome),
        shape = RoundedCornerShape(4.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = Paper,
            contentColor = Ink,
            disabledContainerColor = EpdChromeDisabled,
            disabledContentColor = EpdInkMuted,
        ),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
    ) {
        Text(
            text = if (enabled) "! Stop" else "Stop",
            color = if (enabled) Ink else EpdInkDisabled,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun ReplayButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 56.dp),
        border = BorderStroke(2.dp, Ink),
        shape = RoundedCornerShape(4.dp),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Paper, contentColor = Ink),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
    ) {
        Text("Replay", fontSize = 13.sp, fontWeight = FontWeight.Bold)
    }
}

// ─── Live button: toggles full-duplex Gemini realtime voice session ────────
@Composable
private fun LiveButton(
    isActive: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val container = if (isActive) Ink else Paper
    val content = if (isActive) Paper else Ink
    val borderWeight = if (isActive) 2.dp else 1.dp
    Surface(
        modifier = modifier
            .heightIn(min = 56.dp)
            .border(borderWeight, Ink, RoundedCornerShape(4.dp))
            .clickable(onClick = onClick)
            .semantics {
                contentDescription = if (isActive) "Live voice active. Tap to disconnect." else "Start live voice."
            },
        color = container,
        shape = RoundedCornerShape(4.dp),
    ) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text = if (isActive) "[ON] Live" else "Live",
                color = content,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

// ─── Hub pane: gateway session dashboard including oh-my-pk lanes, plus task launch, chat, and archive ─
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
private fun HubPane(
    state: BooxHubUiState,
    client: VoiceAgentClient,
    prefs: AppPreferences,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    var launchStatus by remember { mutableStateOf("") }
    var launching by remember { mutableStateOf(false) }
    var launchingColab by remember { mutableStateOf(false) }
    var joiningCollab by remember { mutableStateOf(false) }
    var selectedOmpSessionPath by remember { mutableStateOf<String?>(null) }
    var showTaskLauncher by remember { mutableStateOf(false) }
    val context = LocalContext.current

    LaunchedEffect(Unit) {
        selectedOmpSessionPath = client.getSelectedOmpSession()
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .border(1.dp, Chrome, RoundedCornerShape(4.dp))
            .padding(8.dp)
    ) {
        Text(
            text = "OMPK AGENT HUB",
            color = Ink,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = "Persistent oh-my-pk sessions on the host. " +
                "Tap ROUTE TURNS HERE to direct voice/text turns into a lane, or expand a lane " +
                "for a direct chat composer and an archive control. " +
                "LAUNCH TASK starts a new background session with a prompt of your choice.",
            color = EpdInkMuted,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.height(8.dp))

        // ─── Launch task (EPD-friendly: bordered, monospace, no animation) ─────
        OutlinedButton(
            onClick = { showTaskLauncher = true },
            modifier = Modifier.heightIn(min = 56.dp),
            border = BorderStroke(2.dp, Ink),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = "+ LAUNCH TASK",
                color = Ink,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(modifier = Modifier.height(6.dp))

        // ─── Launch OMPK Hub (EPD-friendly: bordered, monospace, no animation) ─
        OutlinedButton(
            onClick = {
                if (launching) return@OutlinedButton
                launching = true
                launchStatus = "Launching OMPK hub..."
                // Launching the hub also routes turns to it.
                prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
                scope.launch {
                    launchStatus = client.launchOmpHub()
                    launching = false
                }
            },
            modifier = Modifier.heightIn(min = 56.dp),
            border = BorderStroke(1.dp, Ink),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = if (launching) "LAUNCHING..." else "LAUNCH OMPK HUB",
                color = Ink,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(modifier = Modifier.height(6.dp))
        OutlinedButton(
            onClick = {
                if (launchingColab) return@OutlinedButton
                launchingColab = true
                launchStatus = "Launching Colab..."
                scope.launch {
                    launchStatus = client.launchColabWorkspace(prefs.workspacePath)
                    launchingColab = false
                }
            },
            modifier = Modifier.heightIn(min = 56.dp),
            border = BorderStroke(1.dp, Ink),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = if (launchingColab) "LAUNCHING..." else "LAUNCH COLAB",
                color = Ink,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(modifier = Modifier.height(6.dp))

        // ─── Join Collab (opens the live OMP collab session in a browser) ─────
        OutlinedButton(
            onClick = {
                if (joiningCollab) return@OutlinedButton
                joiningCollab = true
                launchStatus = "Checking collab..."
                scope.launch {
                    val c = client.getCollabLink()
                    if (c.active && !c.webLink.isNullOrBlank()) {
                        try {
                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(c.webLink)).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            context.startActivity(intent)
                            launchStatus = "Opening collab in browser..."
                        } catch (e: Exception) {
                            launchStatus = "Couldn't open collab link: ${e.message}"
                        }
                    } else {
                        launchStatus = "No active collab. Run /collab in the omp hub on the host."
                    }
                    joiningCollab = false
                }
            },
            modifier = Modifier.heightIn(min = 56.dp),
            border = BorderStroke(1.dp, Ink),
            shape = RoundedCornerShape(4.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = if (joiningCollab) "JOINING..." else "JOIN COLLAB",
                color = Ink,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        if (launchStatus.isNotBlank()) {
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = launchStatus,
                color = Ink,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
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
                    color = EpdInkMuted,
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
                HubLoadedContent(
                    dashboard = state.dashboard,
                    client = client,
                    scope = scope,
                    selectedOmpSessionPath = selectedOmpSessionPath,
                    onSelectSession = { path ->
                        scope.launch {
                            val msg = client.selectOmpSession(path)
                            selectedOmpSessionPath = path
                            launchStatus = msg
                        }
                    },
                    onStatus = { launchStatus = it },
                )
            }
        }
    }

    if (showTaskLauncher) {
        BooxLaunchTaskDialog(
            client = client,
            prefs = prefs,
            onDismiss = { showTaskLauncher = false },
            onLaunched = { message ->
                launchStatus = message
                showTaskLauncher = false
            },
        )
    }
}

// ─── Task launcher dialog (EPD-friendly: pure B/W, no transition animation) ─
@Composable
private fun BooxLaunchTaskDialog(
    client: VoiceAgentClient,
    prefs: AppPreferences,
    onDismiss: () -> Unit,
    onLaunched: (String) -> Unit,
) {
    var cwd by remember { mutableStateOf(prefs.workspacePath) }
    var prompt by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var launching by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = { if (!launching) onDismiss() },
        title = {
            Text("LAUNCH TASK", color = Ink, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        },
        text = {
            Column {
                BasicTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    enabled = !launching,
                    textStyle = TextStyle(color = Ink, fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                    cursorBrush = SolidColor(Ink),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
                        .border(1.dp, Chrome, RoundedCornerShape(3.dp)).padding(8.dp),
                )
                Text("^ working dir", color = EpdInkQuiet, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                Spacer(modifier = Modifier.height(8.dp))
                BasicTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    enabled = !launching,
                    textStyle = TextStyle(color = Ink, fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                    cursorBrush = SolidColor(Ink),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp)
                        .border(1.dp, Chrome, RoundedCornerShape(3.dp)).padding(8.dp),
                )
                Text("^ prompt", color = EpdInkQuiet, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                Spacer(modifier = Modifier.height(8.dp))
                BasicTextField(
                    value = model,
                    onValueChange = { model = it },
                    enabled = !launching,
                    textStyle = TextStyle(color = Ink, fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                    cursorBrush = SolidColor(Ink),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
                        .border(1.dp, Chrome, RoundedCornerShape(3.dp)).padding(8.dp),
                )
                Text("^ model (optional)", color = EpdInkQuiet, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    if (!launching) {
                        launching = true
                        scope.launch {
                            val message = client.launchSession(
                                cwd = cwd.trim().ifBlank { null },
                                prompt = prompt.trim().ifBlank { null },
                                model = model.trim().ifBlank { null },
                            )
                            launching = false
                            onLaunched(message)
                        }
                    }
                },
                modifier = Modifier.heightIn(min = 56.dp),
            ) {
                Text(
                    if (launching) "LAUNCHING..." else "LAUNCH",
                    color = Ink,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
        },
        dismissButton = {
            TextButton(
                onClick = { if (!launching) onDismiss() },
                modifier = Modifier.heightIn(min = 56.dp),
            ) {
                Text("CANCEL", color = EpdInkMuted, fontFamily = FontFamily.Monospace)
            }
        },
        containerColor = Paper,
    )
}

@Composable
private fun HubLoadedContent(
    dashboard: GatewaySessionDashboard,
    client: VoiceAgentClient,
    scope: kotlinx.coroutines.CoroutineScope,
    selectedOmpSessionPath: String?,
    onSelectSession: (String) -> Unit,
    onStatus: (String) -> Unit,
) {
    val byKind = remember(dashboard) { groupSessionsByKind(dashboard.sessions) }
    val isOhMyPkGroupEmpty = byKind["oh-my-pk"].isNullOrEmpty()
    if (dashboard.sessions.isEmpty()) {
        Text(
            text = "No sessions reported by gateway.",
            color = EpdInkMuted,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
        )
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // This is the OMPK Agent Hub: surface ONLY oh-my-pk background agent lanes. codex/remote/
        // other gateway sessions are intentionally hidden here.
        val order = listOf("oh-my-pk")
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
                val entryPath = entry.canonicalSessionPath ?: entry.sessionPath ?: entry.path
                HubSessionRow(
                    entry = entry,
                    dashboard = dashboard,
                    client = client,
                    scope = scope,
                    isSelected = entryPath != null && entryPath == selectedOmpSessionPath,
                    onSelect = { if (entryPath != null) onSelectSession(entryPath) },
                    onStatus = onStatus,
                )
            }
        }
        if (isOhMyPkGroupEmpty) {
            item(key = "omp-empty") {
                Text(
                    text = "No oh-my-pk background lanes running. Start one on the host (oh-my-pk agent mode) and it will appear here.",
                    color = EpdInkMuted,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

@Composable
private fun HubSessionRow(
    entry: GatewaySessionEntry,
    dashboard: GatewaySessionDashboard,
    client: VoiceAgentClient,
    scope: kotlinx.coroutines.CoroutineScope,
    isSelected: Boolean = false,
    onSelect: () -> Unit = {},
    onStatus: (String) -> Unit = {},
) {
    var expanded by remember(entry.name) { mutableStateOf(false) }
    var chatText by remember(entry.name) { mutableStateOf("") }
    var sending by remember(entry.name) { mutableStateOf(false) }
    var pendingKillToken by remember(entry.name) { mutableStateOf<String?>(null) }
    var killing by remember(entry.name) { mutableStateOf(false) }
    val (statusGlyph, statusLabel, statusBorderWeight) = when {
        entry.isCurrentIn(dashboard) -> Triple("[+]", "current", 2.dp)
        entry.isReadyIn(dashboard) -> Triple("[+]", "ready", 2.dp)
        entry.activity.equals("busy", ignoreCase = true) -> Triple("[*]", "running", 1.dp)
        entry.activity.equals("idle", ignoreCase = true) -> Triple("[~]", "idle", 1.dp)
        entry.activity.isNullOrBlank() -> Triple("[ ]", "—", 1.dp)
        else -> Triple("[!]", entry.activity, 1.dp)
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = if (isSelected) EpdChromeSelected else Paper,
        shape = RoundedCornerShape(2.dp),
        border = BorderStroke(if (isSelected) 2.dp else 1.dp, if (isSelected) Ink else SoftChrome)
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
                    color = EpdInkMuted,
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
                    color = EpdInkMuted,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            OutlinedButton(
                onClick = onSelect,
                border = BorderStroke(if (isSelected) 2.dp else 1.dp, Ink),
                shape = RoundedCornerShape(3.dp),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) {
                Text(
                    text = if (isSelected) "[*] ROUTING TURNS HERE" else "[ ] ROUTE TURNS HERE",
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            OutlinedButton(
                onClick = { expanded = !expanded },
                border = BorderStroke(1.dp, Chrome),
                shape = RoundedCornerShape(3.dp),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) {
                Text(
                    text = if (expanded) "^ HIDE CHAT / ARCHIVE" else "v CHAT / ARCHIVE",
                    color = Ink,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
            if (expanded) {
                Spacer(modifier = Modifier.height(4.dp))
                BasicTextField(
                    value = chatText,
                    onValueChange = { chatText = it },
                    enabled = !sending,
                    textStyle = TextStyle(color = Ink, fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                    cursorBrush = SolidColor(Ink),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
                        .border(1.dp, Chrome, RoundedCornerShape(3.dp)).padding(6.dp),
                )
                Spacer(modifier = Modifier.height(4.dp))
                Row(modifier = Modifier.fillMaxWidth()) {
                    OutlinedButton(
                        onClick = {
                            val text = chatText.trim()
                            if (text.isNotEmpty() && !sending) {
                                sending = true
                                scope.launch {
                                    val result = client.sendHubAgentChat(entry.name, text)
                                    sending = false
                                    if (result.ok) {
                                        chatText = ""
                                        onStatus("Sent to ${entry.name}.")
                                    } else {
                                        onStatus(result.error ?: "Message failed.")
                                    }
                                }
                            }
                        },
                        border = BorderStroke(1.dp, Ink),
                        shape = RoundedCornerShape(3.dp),
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                    ) {
                        Text(
                            text = if (sending) "SENDING..." else "SEND",
                            color = Ink,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    Spacer(modifier = Modifier.width(6.dp))
                    OutlinedButton(
                        onClick = {
                            if (killing) return@OutlinedButton
                            killing = true
                            scope.launch {
                                val outcome = client.killHubAgent(entry.name, pendingKillToken)
                                killing = false
                                when {
                                    outcome.ok -> {
                                        pendingKillToken = null
                                        onStatus("Archived ${entry.name}.")
                                    }
                                    outcome.code == "confirm_required" -> {
                                        pendingKillToken = outcome.confirmToken
                                        onStatus("Tap ARCHIVE again to confirm.")
                                    }
                                    else -> {
                                        pendingKillToken = null
                                        onStatus(outcome.error ?: "Archive failed.")
                                    }
                                }
                            }
                        },
                        border = BorderStroke(if (pendingKillToken != null) 2.dp else 1.dp, Ink),
                        shape = RoundedCornerShape(3.dp),
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                    ) {
                        Text(
                            text = if (pendingKillToken != null) "CONFIRM?" else "ARCHIVE",
                            color = Ink,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }
    }
}

private fun kindLabel(kind: String): String = when (kind) {
    "oh-my-pk" -> "AGENT (oh-my-pk background lanes)"
    "codex" -> "CODEX"
    "remote" -> "REMOTE"
    else -> "OTHER"
}

private fun groupSessionsByKind(sessions: List<GatewaySessionEntry>): Map<String, List<GatewaySessionEntry>> {
    val out = mutableMapOf<String, MutableList<GatewaySessionEntry>>()
    for (entry in sessions) {
        val key = when {
            entry.source.equals("oh-my-pk", ignoreCase = true) -> "oh-my-pk"
            entry.source.equals("oh-my-pi", ignoreCase = true) -> "oh-my-pk"
            entry.kind.equals("background", ignoreCase = true) -> "oh-my-pk"
            entry.provider.equals("codex", ignoreCase = true) -> "codex"
            entry.provider.equals("remote", ignoreCase = true) -> "remote"
            else -> "other"
        }
        out.getOrPut(key) { mutableListOf() }.add(entry)
    }
    return out
}

// ─── Settings pane (minimal — the things a Palma user actually needs) ─────
@OptIn(ExperimentalPermissionsApi::class)
@Composable
private fun SettingsPane(prefs: AppPreferences, onSave: () -> Unit, onClose: () -> Unit) {
    var gateway by remember { mutableStateOf(prefs.targetIpAddress) }
    var token by remember { mutableStateOf(prefs.remoteToken) }
    var session by remember { mutableStateOf(prefs.codexSessionName) }
    var agent by remember { mutableStateOf(prefs.activeAgent) }
    val ompAgent = "Gateway OMPK (oh-my-pk)"
    val legacyOmpAgent = "Gateway OMP (oh-my-pi)"
    // Remember what to fall back to when OMP routing is switched off.
    var previousAgent by remember {
        mutableStateOf(if (agent == ompAgent || agent == legacyOmpAgent) "Local Codex (Pi)" else agent.ifBlank { "Local Codex (Pi)" })
    }
    var showProgress by remember { mutableStateOf(prefs.showTurnProgress) }
    var speakProgress by remember { mutableStateOf(prefs.speakTurnProgress) }
    var savedHint by remember { mutableStateOf(false) }
    var scanHint by remember { mutableStateOf("") }

    val cameraPermission = rememberPermissionState(Manifest.permission.CAMERA)
    val scanLauncher = rememberSetupQrScanner { content ->
        if (content == null) return@rememberSetupQrScanner
        val uri = Uri.parse(content)
        val setup = parseSetupDeepLink(uri)
        var scannedGateway = ""
        var scannedToken = ""
        when {
            setup != null -> {
                // pi-speak://setup?base_url=...&token=... (native setup deep link)
                scannedGateway = setup.baseUrl
                scannedToken = setup.token
                setup.defaultTarget?.takeIf { it.isNotBlank() }?.let { session = it }
                scanHint = "[OK] QR applied + saved."
            }
            content.startsWith("http://") || content.startsWith("https://") -> {
                // HTTP URL — extract scheme://host:port and ?token= if present.
                val port = uri.port
                scannedGateway = buildString {
                    append(uri.scheme); append("://"); append(uri.host)
                    if (port != -1) { append(":"); append(port) }
                }
                val tok = uri.getQueryParameter("token")?.takeIf { it.isNotBlank() }
                if (tok != null) {
                    scannedToken = tok
                    scanHint = "[OK] URL + token applied + saved."
                } else {
                    scanHint = "[OK] URL applied. Enter token then SAVE."
                }
            }
            else -> {
                scanHint = "[!!] Not a setup QR."
            }
        }
        if (scannedGateway.isNotBlank()) {
            gateway = scannedGateway
            if (scannedToken.isNotBlank()) token = scannedToken
            // Auto-save immediately so the user doesn't have to tap SAVE.
            prefs.targetIpAddress = scannedGateway
            if (scannedToken.isNotBlank()) prefs.remoteToken = scannedToken
            onSave()
        }
        savedHint = false
    }

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

        SettingsRow("Gateway URL", gateway) { gateway = it; savedHint = false; scanHint = "" }
        SettingsRow("Token", token) { token = it; savedHint = false; scanHint = "" }
        SettingsRow("Session name", session) { session = it; savedHint = false; scanHint = "" }

        // QR scanner — fills Gateway URL + Token + Session from a pi-speak://setup QR.
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = {
                    scanHint = ""
                    if (cameraPermission.status.isGranted) {
                        scanLauncher.launch(setupScanOptions())
                    } else {
                        cameraPermission.launchPermissionRequest()
                    }
                },
                modifier = Modifier.heightIn(min = 56.dp),
                border = BorderStroke(1.dp, Ink),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            ) {
                Text(
                    text = if (cameraPermission.status.isGranted) "[+] SCAN QR" else "[?] ALLOW CAMERA",
                    color = Ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
            if (scanHint.isNotEmpty()) {
                Spacer(modifier = Modifier.width(8.dp))
                Text(scanHint, color = Ink, fontSize = 11.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
            }
        }

        // Sends agentProvider="oh-my-pk" with each turn so the gateway runs ompk -p --auto-approve.
        // This is stateless (a fresh ompk process per turn), not the same as routing into a running Hub session.
        ToggleRow(
            label = "Send turns via oh-my-pk (stateless)",
            value = agent == ompAgent || agent == legacyOmpAgent,
        ) { on ->
            if (on) {
                if (agent != ompAgent && agent != legacyOmpAgent) previousAgent = agent.ifBlank { "Local Codex (Pi)" }
                agent = ompAgent
            } else {
                agent = previousAgent.ifBlank { "Local Codex (Pi)" }
            }
            savedHint = false
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = {
                    prefs.targetIpAddress = gateway.trim()
                    prefs.remoteToken = token.trim()
                    prefs.codexSessionName = session.trim()
                    prefs.activeAgent = if (agent.trim() == legacyOmpAgent) ompAgent else agent.trim()
                    prefs.showTurnProgress = showProgress
                    prefs.speakTurnProgress = speakProgress
                    savedHint = true
                    onSave()
                },
                modifier = Modifier.heightIn(min = 56.dp),
                shape = RoundedCornerShape(4.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Text("SAVE", fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            }
            Spacer(modifier = Modifier.width(8.dp))
            OutlinedButton(
                onClick = onClose,
                modifier = Modifier.heightIn(min = 56.dp),
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
            color = EpdInkMuted,
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
                .heightIn(min = 56.dp)
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
            modifier = Modifier.heightIn(min = 56.dp),
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

private fun pcmPeakAmplitude(pcm: ByteArray): Int {
    var peak = 0
    var index = 0
    while (index + 1 < pcm.size) {
        val sample = (pcm[index].toInt() and 0xff) or (pcm[index + 1].toInt() shl 8)
        peak = maxOf(peak, kotlin.math.abs(sample.toShort().toInt()))
        index += 2
    }
    return peak
}

// ─── Version stamp pulled from BuildConfig.IS_EINK so the eink flavor stamps itself ─
private object BuildConfigEink {
    val einkVersion: String = if (BuildConfig.IS_EINK) "boox" else "standard"
}
