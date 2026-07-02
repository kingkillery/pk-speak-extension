package com.example

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
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
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.example.RealtimeVoiceSession
import com.example.RealtimeVoiceSessionListener
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
import com.example.api.GatewaySessionException
import com.example.api.VoiceAgentClient
import com.example.audio.AudioHelper
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

    // Hub visibility is part of cockpit UX (peek the gateway dashboard including oh-my-pk
    // background lanes). It does NOT add a "send to lane" button -- read-only by design.
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
                    .clickable(onClick = onToggle),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (expanded) "▲ SESSION" else "▼ SESSION",
                    color = Ink,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = stripLabel,
                    color = if (selectedSessionName.isNotBlank()) Ink else Color(0xFF888888),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
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
                        color = Color(0xFF888888),
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                } else {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(projects, key = { it }) { name ->
                            val sel = name == selectedProject
                            Surface(
                                modifier = Modifier.clickable { onSelectProject(name) },
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
                        color = Color(0xFF888888),
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
                                    .clickable { onSelectSession(entry) },
                                color = if (sel) Color(0xFFE8E8E8) else Paper,
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
                                        color = Color(0xFF666666),
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
    var approvalDialogState by remember { mutableStateOf<Triple<String, String, String>?>(null) }

    // Ensure resources are released if the cockpit leaves the composition.
    DisposableEffect(Unit) {
        onDispose {
            liveRecorderRef.value?.stop()
            liveSessionRef.value?.disconnect()
            livePlayerRef.value?.stop()
        }
    }

    // ─── Realtime terminal-command approval dialog ────────────────────────────
    approvalDialogState?.let { (approvalId, command, reason) ->
        AlertDialog(
            onDismissRequest = { approvalDialogState = null },
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
                            color = Color(0xFF555555),
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    liveSessionRef.value?.approveTerminal(approvalId)
                    approvalDialogState = null
                }) {
                    Text(
                        text = "APPROVE",
                        color = Ink,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    liveSessionRef.value?.rejectTerminal(approvalId)
                    appendChat(state, prefs, "system", "[live] Command rejected by user.")
                    approvalDialogState = null
                }) {
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

        // ─── Action row: TALK (push-to-talk) / LIVE / STOP ──────────────
        Row(
            modifier = Modifier.fillMaxWidth().height(120.dp),
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
                modifier = Modifier.weight(1f),
            )

            // LIVE toggle: starts / stops a full-duplex Gemini realtime voice session.
            LiveButton(
                isActive = liveSessionActive,
                onClick = {
                    if (liveSessionActive) {
                        // Toggle OFF — tear down the live session cleanly.
                        liveRecorderRef.value?.stop()
                        liveSessionRef.value?.disconnect()
                        livePlayerRef.value?.stop()
                        liveSessionRef.value = null
                        liveRecorderRef.value = null
                        livePlayerRef.value = null
                        liveSessionActive = false
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
                            val player = StreamingPcmPlayer()
                            val recorder = StreamingPcmRecorder(context)
                            val session = RealtimeVoiceSession(
                                prefs = prefs,
                                listener = object : RealtimeVoiceSessionListener {
                                    override fun onConnected(sessionId: String) {
                                        // Prepare playback and start streaming mic audio.
                                        player.start()
                                        recorder.start { seqId, pcm ->
                                            liveSessionRef.value?.sendAudioChunk(seqId, pcm)
                                        }
                                        scope.launch {
                                            appendChat(state, prefs, "system",
                                                "[live] Connected: $sessionId")
                                        }
                                    }

                                    override fun onAudioChunk(seqId: Int, pcm: ByteArray) {
                                        // Deliver server audio directly to the player (background thread, no lock needed).
                                        player.write(seqId, pcm)
                                    }

                                    override fun onTranscript(text: String) {
                                        scope.launch {
                                            appendChat(state, prefs, "user", text)
                                        }
                                    }

                                    override fun onInterrupt() {
                                        // Server interrupted its own speech — flush and restart the track.
                                        player.stop()
                                        player.start()
                                    }

                                    override fun onToolStart(name: String) {
                                        scope.launch {
                                            appendChat(state, prefs, "system", "[tool] $name")
                                        }
                                    }

                                    override fun onToolComplete(name: String, output: String) {
                                        scope.launch {
                                            appendChat(state, prefs, "system",
                                                "[tool done] $name: ${output.take(200)}")
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
                                            approvalDialogState = Triple(approvalId, command, reason)
                                        }
                                    }

                                    override fun onApprovalResolved(approvalId: String) {
                                        scope.launch {
                                            if (approvalDialogState?.first == approvalId) {
                                                approvalDialogState = null
                                            }
                                        }
                                    }

                                    override fun onError(message: String) {
                                        scope.launch {
                                            appendChat(state, prefs, "system",
                                                "[live error] $message")
                                            recorder.stop()
                                            player.stop()
                                            liveSessionRef.value = null
                                            liveRecorderRef.value = null
                                            livePlayerRef.value = null
                                            liveSessionActive = false
                                        }
                                    }

                                    override fun onDisconnected() {
                                        scope.launch {
                                            if (liveSessionActive) {
                                                appendChat(state, prefs, "system",
                                                    "[live] Disconnected.")
                                                recorder.stop()
                                                player.stop()
                                            }
                                            liveSessionRef.value = null
                                            liveRecorderRef.value = null
                                            livePlayerRef.value = null
                                            liveSessionActive = false
                                        }
                                    }
                                }
                            )
                            liveSessionRef.value = session
                            liveRecorderRef.value = recorder
                            livePlayerRef.value = player
                            liveSessionActive = true
                            session.connect()
                        }
                    }
                },
                modifier = Modifier.weight(1f),
            )

            // STOP: cancels an in-flight HTTP turn OR interrupts Gemini mid-speech in live mode.
            StopButton(
                enabled = state.isProcessing || liveSessionActive,
                onClick = {
                    if (liveSessionActive) {
                        liveSessionRef.value?.sendInterrupt()
                        livePlayerRef.value?.stop()
                        livePlayerRef.value?.start()
                    } else {
                        stopCurrentTurn(state, scope, client, audioHelper, ttsHelper, prefs)
                    }
                },
                modifier = Modifier.weight(1f),
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
                border = BorderStroke(1.dp, if (prefs.autoSpeakEnabled) Ink else Chrome),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = if (prefs.autoSpeakEnabled) "[x] SPEAK REPLIES" else "[ ] SPEAK REPLIES",
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

// ─── Live button: toggles full-duplex Gemini realtime voice session ────────
@Composable
private fun LiveButton(
    isActive: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // EPD-safe active indicator: inverted fill (Ink bg / Paper text) mirrors the
    // RECORDING state of TalkButton. No accent colour — EPD dithering can collapse
    // colours into the same grey as everything else on a 16-level panel.
    val container = if (isActive) Ink else Paper
    val content = if (isActive) Paper else Ink
    val borderWeight = if (isActive) 2.dp else 1.dp
    Surface(
        modifier = modifier
            .border(borderWeight, Ink, RoundedCornerShape(4.dp))
            .clickable(onClick = onClick),
        color = container,
        shape = RoundedCornerShape(4.dp),
    ) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                text = if (isActive) "● LIVE" else "LIVE",
                color = content,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

// ─── Hub pane: read-only gateway session dashboard including oh-my-pk lanes ─
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
            text = "OMPK AGENT HUB (read-only)",
            color = Ink,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = "Persistent oh-my-pk sessions on the host. " +
                "Tap ROUTE TURNS HERE on a session to direct voice/text turns into it. " +
                "LAUNCH OMPK HUB starts a new background session.",
            color = Color(0xFF555555),
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(modifier = Modifier.height(8.dp))

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
                HubLoadedContent(
                    dashboard = state.dashboard,
                    selectedOmpSessionPath = selectedOmpSessionPath,
                    onSelectSession = { path ->
                        scope.launch {
                            val msg = client.selectOmpSession(path)
                            selectedOmpSessionPath = path
                            launchStatus = msg
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun HubLoadedContent(
    dashboard: GatewaySessionDashboard,
    selectedOmpSessionPath: String?,
    onSelectSession: (String) -> Unit,
) {
    val byKind = remember(dashboard) { groupSessionsByKind(dashboard.sessions) }
    val isOhMyPkGroupEmpty = byKind["oh-my-pk"].isNullOrEmpty()
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
        // This is the OMPK Agent Hub: surface ONLY oh-my-pk background agent lanes. codex/remote/
        // other gateway sessions are intentionally hidden here. Read-only -- no "drive lane" button.
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
                    isSelected = entryPath != null && entryPath == selectedOmpSessionPath,
                    onSelect = { if (entryPath != null) onSelectSession(entryPath) },
                )
            }
        }
        if (isOhMyPkGroupEmpty) {
            item(key = "omp-empty") {
                Text(
                    text = "No oh-my-pk background lanes running. Start one on the host (oh-my-pk agent mode) and it will appear here.",
                    color = Color(0xFF555555),
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
    isSelected: Boolean = false,
    onSelect: () -> Unit = {},
) {
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
        color = if (isSelected) Color(0xFFE8E8E8) else Paper,
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
            Spacer(modifier = Modifier.height(4.dp))
            OutlinedButton(
                onClick = onSelect,
                border = BorderStroke(if (isSelected) 2.dp else 1.dp, Ink),
                shape = RoundedCornerShape(3.dp),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = if (isSelected) "[*] ROUTING TURNS HERE" else "[ ] ROUTE TURNS HERE",
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                    fontFamily = FontFamily.Monospace,
                )
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
    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val content = result.contents ?: return@rememberLauncherForActivityResult
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
                        scanLauncher.launch(
                            ScanOptions().apply {
                                setOrientationLocked(false)
                                setBeepEnabled(false)
                                setPrompt("Point at the pi-speak setup QR code")
                            }
                        )
                    } else {
                        cameraPermission.launchPermissionRequest()
                    }
                },
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
