package com.example

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.ui.draw.scale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import com.example.ui.theme.Canvas as CanvasColor
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import com.google.accompanist.permissions.PermissionState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.api.AutoConnectResult
import com.example.api.ConnectionReason
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
import com.example.api.GatewaySessionErrorKind
import com.example.api.GatewaySessionException
import com.example.api.GatewayRouteUpdate
import com.example.api.VoiceAgentClient
import com.example.api.RemoteSlashCommand
import com.example.audio.StreamingPcmPlayer
import com.example.audio.StreamingPcmRecorder
import com.example.audio.AudioHelper
import com.example.audio.TtsHelper
import com.example.data.AppPreferences
import com.example.data.ChatMessage
import com.example.data.RecordedSession
import com.example.ui.theme.MyApplicationTheme
import com.example.ui.theme.Accent
import com.example.ui.theme.AccentSoft
import com.example.ui.theme.Error
import com.example.ui.theme.ErrorContainer
import com.example.ui.theme.Ink
import com.example.ui.theme.InkMuted
import com.example.ui.theme.Line
import com.example.ui.theme.SelectedFill
import com.example.ui.theme.Success
import com.example.ui.theme.SuccessSoft
import com.example.ui.theme.SurfaceMuted
import com.example.ui.theme.SurfacePaper
import com.example.ui.theme.SurfaceSubtle
import com.example.ui.theme.Warn
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
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
import android.media.AudioRecord
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import okhttp3.WebSocket
import okio.ByteString

class MainActivity : ComponentActivity() {
    private lateinit var audioHelper: AudioHelper
    private lateinit var ttsHelper: TtsHelper
    private lateinit var appPreferences: AppPreferences
    private lateinit var voiceAgentClient: VoiceAgentClient
    private var pairingIntentGeneration by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        audioHelper = AudioHelper(this)
        ttsHelper = TtsHelper(this)
        appPreferences = AppPreferences(this)
        appPreferences.clearGatewayConfigIfAppUpgraded(BuildConfig.VERSION_CODE)
        voiceAgentClient = VoiceAgentClient(this, appPreferences)
        
        if (savedInstanceState == null) handleDeepLink(intent)

        setContent {
            MyApplicationTheme {
                Scaffold(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(CanvasColor)
                ) { innerPadding ->
                    PiSpeakConsoleScreen(
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        prefs = appPreferences,
                        client = voiceAgentClient,
                        pairingIntentGeneration = pairingIntentGeneration,
                        modifier = Modifier.padding(innerPadding)
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val setup = parseSetupDeepLink(intent?.data) ?: return
        applySetupDeepLink(appPreferences, setup)
        pairingIntentGeneration += 1
        intent?.data = null
        Log.d(
            "MainActivity",
            "Successfully processed zero-touch onboarding QR link: base_url=${setup.baseUrl}, profile=${setup.profileName}, target=${setup.defaultTarget}"
        )
    }

    override fun onDestroy() {
        ttsHelper.shutdown()
        super.onDestroy()
    }
}

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun PiSpeakConsoleScreen(
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
    client: VoiceAgentClient,
    pairingIntentGeneration: Int = 0,
    modifier: Modifier = Modifier
) {
    val permissionState = rememberPermissionState(permission = Manifest.permission.RECORD_AUDIO)
    val scope = rememberCoroutineScope()

    // Navigation and tabs
    var currentTab by remember { mutableStateOf("studio") } // "studio" | "sessions" | "settings"

    // Configuration updates state
    var selectedAgent by remember { mutableStateOf(prefs.activeAgent) }
    var codexSessionName by remember { mutableStateOf(prefs.codexSessionName) }
    var scaleAnimationActive by remember { mutableStateOf(false) }
    val studioConversationKey = prefs.conversationKey()
    val studioState = remember {
        StudioRuntimeState(
            conversationKey = studioConversationKey,
            chatMessages = prefs.getChatMessages(studioConversationKey)
        )
    }
    val context = androidx.compose.ui.platform.LocalContext.current
    var consumedPairingIntentGeneration by remember { mutableIntStateOf(0) }

    LaunchedEffect(pairingIntentGeneration) {
        if (pairingIntentGeneration > consumedPairingIntentGeneration) {
            consumedPairingIntentGeneration = pairingIntentGeneration
            studioState.pairingGeneration += 1
        }
    }

    // Synchronize agent state
    LaunchedEffect(selectedAgent) {
        prefs.activeAgent = selectedAgent
    }

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)

    val tabTitle = when (currentTab) {
        "studio" -> "Studio"
        "discovery" -> "Discover"
        "commands" -> "Commands"
        "sessions" -> "Agent Hub"
        "settings" -> "Configure"
        else -> "Pi Speak"
    }

    LaunchedEffect(studioConversationKey) {
        if (studioState.conversationKey != studioConversationKey && !studioState.isProcessing && !studioState.isRecording) {
            studioState.conversationKey = studioConversationKey
            studioState.chatMessages = prefs.getChatMessages(studioConversationKey)
            studioState.transcription = ""
            studioState.latestReply = ""
            studioState.progressText = ""
            studioState.stopStatusText = ""
        }
    }

    fun applyAutoConnectResult(result: AutoConnectResult, latencyMs: Long, searching: Boolean) {
        codexSessionName = prefs.codexSessionName
        studioState.connectionHealth = result.reason
        studioState.connectionLatencyMs = latencyMs
        if (result.reason == ConnectionReason.Ok && result.connected) {
            studioState.isGatewayConnected = true
            studioState.isReconnecting = false
            studioState.connectionStatusText = "Connected"
            studioState.connectionBannerText = ""
            studioState.realtimeAuthFailure = false
            return
        }

        studioState.isGatewayConnected = false
        studioState.connectionBannerText = result.message.ifBlank {
            "Gateway is unreachable. Searching for a Pi Speak server."
        }
        val setupRequired = result.reason == ConnectionReason.PairingRequired ||
            result.reason == ConnectionReason.TokenRejected
        studioState.isReconnecting = !setupRequired && searching
        studioState.connectionStatusText = when {
            setupRequired -> "Setup required"
            searching -> "Searching for gateway..."
            else -> "Gateway unreachable"
        }
    }

    // A newly applied setup link gets an immediate authenticated verification instead of
    // waiting for the next five-second lifecycle poll.
    LaunchedEffect(studioState.pairingGeneration) {
        if (studioState.pairingGeneration == 0) return@LaunchedEffect
        val verificationGeneration = studioState.pairingGeneration
        studioState.isReconnecting = true
        studioState.connectionStatusText = "Reconnecting..."
        val startedAt = System.currentTimeMillis()
        val result = withContext(Dispatchers.IO) { client.tryAutoConnect(forceVerify = true) }
        if (studioState.pairingGeneration != verificationGeneration) return@LaunchedEffect
        applyAutoConnectResult(result, System.currentTimeMillis() - startedAt, searching = false)
        Log.d("PiSpeakConnection", "Gateway connection state: ${studioState.connectionStatusText}")
    }

    // Health polling only runs while the app is visible (STARTED). tryAutoConnect verifies
    // both reachability and the saved token, so a public /health response cannot hide a 401.
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    LaunchedEffect(Unit) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            var unreachableSinceMs: Long? = null
            var lastLoggedConnectionStatus = ""
            while (true) {
                val pollGeneration = studioState.pairingGeneration
                val startedAt = System.currentTimeMillis()
                val result = withContext(Dispatchers.IO) { client.tryAutoConnect(forceVerify = true) }
                val latencyMs = System.currentTimeMillis() - startedAt
                val setupRequired = result.reason == ConnectionReason.PairingRequired ||
                    result.reason == ConnectionReason.TokenRejected
                val searching = if (result.connected || setupRequired) {
                    unreachableSinceMs = null
                    false
                } else {
                    val firstFailureMs = unreachableSinceMs ?: System.currentTimeMillis()
                    unreachableSinceMs = firstFailureMs
                    System.currentTimeMillis() - firstFailureMs <= 10_000L
                }
                if (studioState.pairingGeneration == pollGeneration) {
                    applyAutoConnectResult(result, latencyMs, searching)
                    if (studioState.connectionStatusText != lastLoggedConnectionStatus) {
                        lastLoggedConnectionStatus = studioState.connectionStatusText
                        Log.d("PiSpeakConnection", "Gateway connection state: ${studioState.connectionStatusText}")
                    }
                }
                delay(5_000)
            }
        }
    }

    val pairingGateReason = if (studioState.realtimeAuthFailure) {
        ConnectionReason.TokenRejected
    } else {
        studioState.connectionHealth
    }
    val showPairingGate = pairingGateReason == ConnectionReason.PairingRequired ||
        pairingGateReason == ConnectionReason.TokenRejected
    val pairingGateDetail = if (
        studioState.realtimeAuthFailure &&
        (studioState.connectionHealth == ConnectionReason.Unreachable ||
            studioState.connectionHealth == ConnectionReason.DiscoveryFailed)
    ) {
        "The saved token still needs replacement, and the gateway is currently unreachable."
    } else {
        studioState.connectionBannerText
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        scrimColor = Ink.copy(alpha = 0.4f),
        gesturesEnabled = !showPairingGate,
        drawerContent = {
            PiSpeakDrawer(
                activeTab = currentTab,
                profileName = prefs.machineProfileName,
                sessionName = codexSessionName,
                recents = prefs.getRecordedSessions(),
                onSelect = { tab ->
                    currentTab = tab
                    scope.launch { drawerState.close() }
                },
                onSettings = {
                    currentTab = "settings"
                    scope.launch { drawerState.close() }
                }
            )
        }
    ) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(CanvasColor)
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
        ) {
            // Slim top bar: menu / title+status / settings (Claude Code mobile style)
            HeaderSection(
                title = tabTitle,
                sessionName = codexSessionName,
                onMenuClick = { scope.launch { drawerState.open() } },
                isGatewayConnected = studioState.isGatewayConnected,
                isReconnecting = studioState.isReconnecting,
                connectionStatusText = studioState.connectionStatusText,
                connectionLatencyMs = studioState.connectionLatencyMs,
                onSettingsClick = { currentTab = "settings" }
            )

            // Content container. Studio renders edge-to-edge like a chat surface;
            // the list-style tabs keep a small gutter.
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(horizontal = if (currentTab == "studio") 0.dp else 12.dp)
            ) {
                when (currentTab) {
                    "studio" -> StudioTabContent(
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        prefs = prefs,
                        client = client,
                        runtimeState = studioState,
                        appScope = scope
                    )
                    "sessions" -> SessionsTabContent(
                        client = client,
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        prefs = prefs,
                        onRemoteSessionSelected = { entry, dashboard ->
                            applyGatewaySessionSelection(entry, dashboard, prefs)
                            codexSessionName = prefs.codexSessionName
                        }
                    )
                    "commands" -> CommandsTabContent(
                        client = client,
                        prefs = prefs
                    )
                    "discovery" -> DiscoveryTabContent(
                        client = client,
                        prefs = prefs,
                        onSessionSelected = { newSession, machineIp ->
                            prefs.codexSessionName = newSession
                            prefs.targetIpAddress = machineIp
                            codexSessionName = newSession
                            studioState.isGatewayConnected = false
                            studioState.isReconnecting = true
                            studioState.connectionStatusText = "Reconnecting..."
                        }
                    )
                    "settings" -> SettingsTabContent(
                        prefs = prefs,
                        onConfigChanged = {
                            codexSessionName = prefs.codexSessionName
                            selectedAgent = prefs.activeAgent
                        }
                    )
                }
            }
        }
        ConnectionErrorBanner(
            message = if (showPairingGate) "" else studioState.connectionBannerText,
            onDismiss = { studioState.connectionBannerText = "" },
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = 60.dp, start = 16.dp, end = 16.dp)
        )
        if (showPairingGate) {
            PairingRequiredGate(
                connectionReason = pairingGateReason,
                detail = pairingGateDetail,
                prefs = prefs,
                client = client,
                onPairingApplied = { studioState.pairingGeneration += 1 },
                modifier = Modifier.fillMaxSize()
            )
        }
    }
    }
}

@Composable
fun HeaderSection(
    title: String,
    sessionName: String,
    onMenuClick: () -> Unit,
    isGatewayConnected: Boolean,
    isReconnecting: Boolean,
    connectionStatusText: String,
    connectionLatencyMs: Long = -1L,
    onSettingsClick: () -> Unit
) {
    val connectionColor = gatewayConnectionIndicatorColor(isGatewayConnected, isReconnecting)
    val statusLabel = "$connectionStatusText | Codex: $sessionName"
    // Flat, slim app bar (Claude Code mobile style): icon / title+status / icon,
    // separated from content by a hairline instead of a floating card.
    Column(modifier = Modifier.fillMaxWidth().background(CanvasColor)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onMenuClick) {
                Icon(Icons.Default.Menu, contentDescription = "Menu", tint = Ink)
            }
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 2.dp),
            ) {
                Text(
                    text = title,
                    color = Ink,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(connectionColor)
                    )
                    Spacer(modifier = Modifier.width(5.dp))
                    Text(
                        text = statusLabel,
                        color = InkMuted,
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (isGatewayConnected && connectionLatencyMs >= 0L) {
                        Spacer(modifier = Modifier.width(5.dp))
                        Text(
                            text = "${connectionLatencyMs}ms",
                            color = connectionColor,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
            IconButton(onClick = onSettingsClick) {
                Icon(Icons.Default.Settings, contentDescription = "Settings", tint = InkMuted)
            }
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Line)
        )
    }
}

fun gatewayConnectionIndicatorColor(isGatewayConnected: Boolean, isReconnecting: Boolean): Color = when {
    isGatewayConnected -> Success
    isReconnecting -> Warn
    else -> Error
}


@Composable
fun ConnectionErrorBanner(
    message: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    AnimatedVisibility(
        visible = message.isNotBlank(),
        enter = fadeIn() + slideInVertically(initialOffsetY = { -it / 2 }),
        exit = fadeOut() + slideOutVertically(targetOffsetY = { -it / 2 }),
        modifier = modifier
    ) {
        Surface(
            color = Error,
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, Error),
            shadowElevation = 4.dp
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(ErrorContainer)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = message,
                    color = SurfacePaper,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    modifier = Modifier.weight(1f)
                )
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.heightIn(min = 44.dp),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                ) {
                    Text("Dismiss", color = SurfacePaper, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
fun PiSpeakDrawer(
    activeTab: String,
    profileName: String,
    sessionName: String,
    recents: List<RecordedSession>,
    onSelect: (String) -> Unit,
    onSettings: () -> Unit
) {
    ModalDrawerSheet(
        drawerContainerColor = CanvasColor,
        drawerContentColor = Ink,
        drawerShape = RoundedCornerShape(topEnd = 20.dp, bottomEnd = 20.dp),
        modifier = Modifier.fillMaxWidth(0.84f)
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 14.dp)
        ) {
            Spacer(modifier = Modifier.height(18.dp))
            Text(
                text = "Pi Speak",
                color = Ink,
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(horizontal = 6.dp)
            )
            Spacer(modifier = Modifier.height(16.dp))

            // Accent "New session" action (mirrors Claude's "New chat")
            DrawerRow(
                glyph = "+",
                label = "New session",
                selected = false,
                accent = true,
                onClick = { onSelect("studio") }
            )

            Spacer(modifier = Modifier.height(4.dp))
            DrawerRow(glyph = "St", label = "Studio", selected = activeTab == "studio", mono = true) { onSelect("studio") }
            DrawerRow(glyph = "Di", label = "Discover", selected = activeTab == "discovery", mono = true) { onSelect("discovery") }
            DrawerRow(glyph = "</>", label = "Commands", selected = activeTab == "commands", mono = true) { onSelect("commands") }
            DrawerRow(glyph = "Hub", label = "Agent Hub", selected = activeTab == "sessions", mono = true) { onSelect("sessions") }
            DrawerRow(glyph = "Cfg", label = "Configure", selected = activeTab == "settings", mono = true) { onSelect("settings") }

            if (recents.isNotEmpty()) {
                Spacer(modifier = Modifier.height(18.dp))
                Text(
                    text = "Recent turns",
                    color = InkMuted,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.5.sp,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
                )
                Column(modifier = Modifier.weight(1f, fill = false)) {
                    recents.take(6).forEach { session ->
                        val label = session.transcriptionText.ifBlank { "Untitled turn" }
                        Text(
                            text = label,
                            color = Ink,
                            fontSize = 14.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .clickable { onSelect("sessions") }
                                .padding(horizontal = 12.dp, vertical = 11.dp)
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.weight(1f))
            Divider(color = Line)
            // Profile footer with settings cog
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .clickable { onSettings() }
                    .padding(horizontal = 8.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(Accent),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = profileName.take(2).uppercase().ifBlank { "PI" },
                        color = SurfacePaper,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Text(
                    text = profileName.ifBlank { "Pi Speak" },
                    color = Ink,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(text = "Tune", color = InkMuted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(modifier = Modifier.height(10.dp))
        }
    }
}

@Composable
private fun DrawerRow(
    glyph: String,
    label: String,
    selected: Boolean,
    accent: Boolean = false,
    mono: Boolean = false,
    onClick: () -> Unit
) {
    val contentColor = when {
        accent -> Accent
        else -> Ink
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) SelectedFill else Color.Transparent)
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(modifier = Modifier.width(26.dp), contentAlignment = Alignment.CenterStart) {
            Text(
                text = glyph,
                color = contentColor,
                fontSize = if (mono) 14.sp else 17.sp,
                fontWeight = if (mono) FontWeight.Bold else FontWeight.Normal,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default
            )
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = label,
            color = contentColor,
            fontSize = 16.sp,
            fontWeight = if (accent || selected) FontWeight.SemiBold else FontWeight.Normal
        )
    }
}

class StudioRuntimeState(
    conversationKey: String,
    chatMessages: List<ChatMessage>
) {
    var isRecording by mutableStateOf(false)
    var isProcessing by mutableStateOf(false)
    var transcription by mutableStateOf("")
    var latestReply by mutableStateOf("")
    var progressText by mutableStateOf("")
    var currentRecordPath by mutableStateOf<String?>(null)
    var textInputState by mutableStateOf("")
    var activeTurnJob by mutableStateOf<Job?>(null)
    var turnGeneration by mutableIntStateOf(0)
    var stopStatusText by mutableStateOf("")
    var conversationKey by mutableStateOf(conversationKey)
    var chatMessages by mutableStateOf(chatMessages)
    var playingMessageId by mutableStateOf<String?>(null)
    var isGatewayConnected by mutableStateOf(false)
    var isReconnecting by mutableStateOf(true)
    var connectionStatusText by mutableStateOf("Searching for gateway...")
    var connectionBannerText by mutableStateOf("")
    var connectionLatencyMs by mutableLongStateOf(-1L)
    var connectionHealth by mutableStateOf(ConnectionReason.Unreachable)
    var realtimeAuthFailure by mutableStateOf(false)
    var pairingGeneration by mutableIntStateOf(0)
    var isRealtimeActive by mutableStateOf(false)
    var isRealtimeConnected by mutableStateOf(false)
    val pendingTerminalApprovals = mutableStateListOf<TerminalApprovalPrompt>()
}

data class TerminalApprovalPrompt(
    val approvalId: String,
    val command: String,
    val cwd: String,
    val reason: String,
    val timeoutMs: Int
)

@Composable
fun TerminalApprovalCard(
    approval: TerminalApprovalPrompt,
    onApprove: () -> Unit,
    onReject: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = AccentSoft,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, Warn)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = "Terminal approval needed",
                color = Accent,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.3.sp
            )
            Text(
                text = approval.command.ifBlank { "(unknown command)" },
                color = Ink,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                fontFamily = FontFamily.Monospace
            )
            val details = listOfNotNull(
                approval.reason.takeIf { it.isNotBlank() }?.let { "Reason: $it" },
                approval.cwd.takeIf { it.isNotBlank() }?.let { "CWD: $it" },
                approval.timeoutMs.takeIf { it > 0 }?.let { "Timeout: ${it}ms" }
            )
            if (details.isNotEmpty()) {
                Text(
                    text = details.joinToString("\n"),
                    color = InkMuted,
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(
                    onClick = onReject,
                    border = BorderStroke(1.dp, Error),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.heightIn(min = 44.dp),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp)
                ) {
                    Text("Reject", color = Error, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
                Spacer(modifier = Modifier.width(8.dp))
                Button(
                    onClick = onApprove,
                    colors = ButtonDefaults.buttonColors(containerColor = Success),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.heightIn(min = 44.dp),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp)
                ) {
                    Text("Approve", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun StudioTabContent(
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
    client: VoiceAgentClient,
    runtimeState: StudioRuntimeState,
    appScope: CoroutineScope
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val permissionState = rememberPermissionState(permission = Manifest.permission.RECORD_AUDIO)
    val scope = appScope
    val state = runtimeState
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current

    // ─── Live (Gemini realtime) session state ────────────────────────────
    val liveSessionRef = remember { mutableStateOf<RealtimeVoiceSession?>(null) }
    val liveRecorderRef = remember { mutableStateOf<StreamingPcmRecorder?>(null) }
    val livePlayerRef = remember { mutableStateOf<StreamingPcmPlayer?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            val disposedSession = liveSessionRef.value
            liveSessionRef.value = null
            liveRecorderRef.value?.stop()
            liveRecorderRef.value = null
            livePlayerRef.value?.stop()
            livePlayerRef.value = null
            disposedSession?.disconnect()
            state.isRealtimeActive = false
            state.isRealtimeConnected = false
        }
    }

    val infiniteTransition = rememberInfiniteTransition(label = "recordingPulse")
    val recordingScale by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulse"
    )

    // Live decibels state for custom drawing
    val amplitudeList = remember { mutableStateListOf<Float>().apply { addAll(List(16) { 0.1f }) } }
    var liveAmplitudeJob by remember { mutableStateOf<Job?>(null) }

    val listState = rememberLazyListState()

    LaunchedEffect(state.chatMessages.size, state.transcription, state.isProcessing, state.isRecording, state.latestReply) {
        val layoutInfo = listState.layoutInfo
        val lastVisibleIndex = layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
        if (!shouldFollowConversationTail(lastVisibleIndex, layoutInfo.totalItemsCount)) return@LaunchedEffect
        val totalCount = state.chatMessages.size + 10
        if (totalCount > 10) {
            listState.animateScrollToItem(totalCount)
        }
    }

    // Real-time synchronized simulated transcription stream
    var wordStreamJob by remember { mutableStateOf<Job?>(null) }
    var recordingStartedAtMs by remember { mutableLongStateOf(0L) }
    val minimumVoiceCaptureMs = 1200L

    fun setProgress(message: String) {
        if (prefs.showTurnProgress) {
            state.progressText = message
        }
    }

    fun persistChat(messages: List<ChatMessage>) {
        val capped = messages.takeLast(50)
        state.chatMessages = capped
        prefs.saveChatMessages(state.conversationKey, capped)
    }

    fun appendChat(role: String, text: String, progress: List<String> = emptyList(), audioPath: String? = null) {
        val trimmed = text.trim()
        if (trimmed.isBlank() && progress.isEmpty()) return
        persistChat(
            state.chatMessages + ChatMessage(
                id = UUID.randomUUID().toString(),
                role = role,
                text = trimmed,
                timestampMs = System.currentTimeMillis(),
                baseUrl = prefs.targetIpAddress.trim().trimEnd('/'),
                workspacePath = prefs.workspacePath,
                targetSession = prefs.codexSessionName,
                progress = progress,
                audioPath = audioPath
            )
        )
    }

    fun handleGatewayConnectionError(message: String) {
        val cleanMessage = message.lineSequence().firstOrNull()?.ifBlank { null }
            ?: "Gateway is unreachable. Searching for a Pi Speak server."
        state.isGatewayConnected = false
        state.isReconnecting = true
        state.connectionStatusText = "Reconnecting..."
        state.connectionBannerText = cleanMessage
        setProgress("Gateway unreachable. Searching for a Pi Speak server.")
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
                state.connectionBannerText = reconnect.message.ifBlank { cleanMessage }
            }
        }
    }

    fun stopLiveSession() {
        liveRecorderRef.value?.stop()
        liveSessionRef.value?.disconnect()
        livePlayerRef.value?.stop()
        liveSessionRef.value = null
        liveRecorderRef.value = null
        livePlayerRef.value = null
        state.isRealtimeActive = false
        state.isRealtimeConnected = false
        state.pendingTerminalApprovals.clear()
    }

    fun startLiveSession() {
        val sharedPrefs = context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
        val player = StreamingPcmPlayer()
        val recorder = StreamingPcmRecorder(context)
        lateinit var session: RealtimeVoiceSession
        session = RealtimeVoiceSession(
            prefs = prefs,
            listener = object : RealtimeVoiceSessionListener {
                override fun onConnected(sessionId: String) {
                    if (liveSessionRef.value !== session) return
                    player.start()
                    try {
                        recorder.start { seqId, pcm ->
                            if (liveSessionRef.value === session) {
                                session.sendAudioChunk(seqId, pcm)
                            }
                            // Client-side VAD barge-in: interrupt assistant speech when the
                            // user starts talking over it (configurable in Settings).
                            if (player.isPlaying && sharedPrefs.getBoolean("vad_enabled", true)) {
                                val threshold = sharedPrefs.getFloat("vad_threshold", 1500f).toInt()
                                if (pcmPeakAmplitude(pcm) > threshold) {
                                    session.sendInterrupt()
                                    player.stop()
                                    player.start()
                                }
                            }
                        }
                    } catch (e: Exception) {
                        scope.launch {
                            if (liveSessionRef.value === session) {
                                appendChat("system", "[live] Mic failed to start: ${e.message}")
                            }
                        }
                    }
                    scope.launch {
                        if (liveSessionRef.value !== session) return@launch
                        state.isRealtimeConnected = true
                        state.realtimeAuthFailure = false
                        state.connectionHealth = ConnectionReason.Ok
                        appendChat("system", "[live] Connected: $sessionId")
                    }
                }

                override fun onAudioChunk(seqId: Int, pcm: ByteArray) {
                    if (liveSessionRef.value === session) player.write(seqId, pcm)
                }

                override fun onTranscript(text: String) {
                    scope.launch {
                        if (liveSessionRef.value === session) state.transcription = text
                    }
                }
                override fun onTranscriptComplete() = Unit

                override fun onInterrupt() {
                    if (liveSessionRef.value !== session) return
                    player.stop()
                    player.start()
                }

                override fun onToolStart(name: String) {
                    scope.launch {
                        if (liveSessionRef.value === session) appendChat("system", "[tool] $name")
                    }
                }

                override fun onToolComplete(name: String, output: String) {
                    scope.launch {
                        if (liveSessionRef.value === session) {
                            appendChat("system", "[tool done] $name: ${output.take(200)}")
                        }
                    }
                }

                override fun onApprovalRequired(
                    approvalId: String,
                    command: String,
                    reason: String,
                    cwd: String,
                    timeoutMs: Int
                ) {
                    scope.launch {
                        if (liveSessionRef.value !== session) return@launch
                        state.pendingTerminalApprovals.removeAll { it.approvalId == approvalId }
                        state.pendingTerminalApprovals.add(
                            TerminalApprovalPrompt(
                                approvalId = approvalId,
                                command = command,
                                cwd = cwd,
                                reason = reason,
                                timeoutMs = timeoutMs
                            )
                        )
                        state.latestReply = "Terminal approval needed."
                    }
                }

                override fun onApprovalResolved(approvalId: String) {
                    scope.launch {
                        if (liveSessionRef.value === session) {
                            state.pendingTerminalApprovals.removeAll { it.approvalId == approvalId }
                        }
                    }
                }

                override fun onError(message: String, httpCode: Int?) {
                    scope.launch {
                        if (liveSessionRef.value !== session) return@launch
                        val authFailure = httpCode == 401
                        recorder.stop()
                        player.stop()
                        session.disconnect()
                        liveSessionRef.value = null
                        liveRecorderRef.value = null
                        livePlayerRef.value = null
                        state.isRealtimeConnected = false
                        if (authFailure) {
                            state.latestReply = "Gateway pairing is required."
                            state.realtimeAuthFailure = true
                            state.connectionHealth = ConnectionReason.TokenRejected
                            state.isGatewayConnected = false
                            state.isReconnecting = false
                            state.connectionStatusText = "Setup required"
                            state.connectionBannerText = "Gateway found, but the saved token was rejected. Scan or paste a fresh setup link."
                            // Preserve the user's live-session intent so pairingGeneration can
                            // restart it with the replacement token.
                            state.isRealtimeActive = true
                        } else {
                            state.latestReply = "Realtime error: $message"
                            appendChat("system", "[live error] $message")
                            state.isRealtimeActive = false
                        }
                    }
                }

                override fun onDisconnected() {
                    scope.launch {
                        // A repaired session may already have replaced this one. Never let a
                        // delayed callback from the old socket clear the new refs or active flag.
                        if (liveSessionRef.value !== session) return@launch
                        if (state.isRealtimeActive) {
                            appendChat("system", "[live] Disconnected.")
                            recorder.stop()
                            player.stop()
                        }
                        liveSessionRef.value = null
                        liveRecorderRef.value = null
                        livePlayerRef.value = null
                        state.isRealtimeActive = false
                        state.isRealtimeConnected = false
                    }
                }
            }
        )
        liveSessionRef.value = session
        liveRecorderRef.value = recorder
        livePlayerRef.value = player
        state.isRealtimeActive = true
        session.connect()
    }

    var observedPairingGeneration by remember { mutableIntStateOf(state.pairingGeneration) }
    LaunchedEffect(state.pairingGeneration) {
        if (state.pairingGeneration == observedPairingGeneration) return@LaunchedEffect
        observedPairingGeneration = state.pairingGeneration
        val shouldRestartLive = state.isRealtimeActive || state.realtimeAuthFailure
        val oldSession = liveSessionRef.value
        liveSessionRef.value = null
        liveRecorderRef.value?.stop()
        liveRecorderRef.value = null
        livePlayerRef.value?.stop()
        livePlayerRef.value = null
        oldSession?.disconnect()
        state.isRealtimeConnected = false
        if (shouldRestartLive) {
            state.isRealtimeActive = false
            startLiveSession()
        }
    }

    fun stopCurrentTurn() {
        val stoppedTurnGeneration = state.turnGeneration + 1
        state.turnGeneration = stoppedTurnGeneration
        client.cancelActiveTurnCall()
        state.activeTurnJob?.cancel()
        state.activeTurnJob = null
        state.stopStatusText = "Stopping..."
        state.isProcessing = true
        setProgress("Stopping local request. Asking gateway to cancel the current turn.")
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
                setProgress(stoppedMessage)
                state.latestReply = stoppedMessage
                appendChat("system", stoppedMessage)
                state.isProcessing = false
            }
        }
    }

    val startSimulatedTranscription = {
        wordStreamJob?.cancel()
        state.transcription = "Streaming wireless audio loop..."
    }

    val startAmplitudeSampling = {
        liveAmplitudeJob?.cancel()
        liveAmplitudeJob = scope.launch {
            while (state.isRecording) {
                val amp = audioHelper.getAmplitude().toFloat()
                // Normalize amplitude to reasonable range (0.1 to 1.0)
                val normalized = (amp / 32768f).coerceIn(0.1f, 1.0f)
                amplitudeList.removeAt(0)
                amplitudeList.add(normalized)
                delay(80)
            }
            // Transition back to quiet state
            while (amplitudeList.any { it > 0.15f }) {
                for (i in 0 until amplitudeList.size) {
                    amplitudeList[i] = (amplitudeList[i] * 0.7f).coerceAtLeast(0.1f)
                }
                delay(80)
            }
        }
    }

    val recordTriggerAction = {
        if (!state.isRecording && !state.isProcessing) {
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            ttsHelper.stop()
            audioHelper.stopPlayback()
            state.playingMessageId = null
            state.isRecording = true
            recordingStartedAtMs = System.currentTimeMillis()
            state.currentRecordPath = audioHelper.startRecording("turn.wav")
            Log.d("MainActivity", "Voice recording started: ${state.currentRecordPath}")
            startSimulatedTranscription()
            startAmplitudeSampling()
        }
    }

    val stopAndSendAction = {
        if (state.isRecording) {
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            state.isRecording = false
            liveAmplitudeJob?.cancel()
            wordStreamJob?.cancel()
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
                        if (elapsedMs in 0 until minimumVoiceCaptureMs) {
                            delay(minimumVoiceCaptureMs - elapsedMs)
                        }
                        withContext(Dispatchers.IO) { audioHelper.stopRecording() }
                    } catch (e: CancellationException) {
                        withContext(NonCancellable + Dispatchers.IO) { audioHelper.stopRecording() }
                        throw e
                    }
                    val file = audioHelper.getRecordedFile("turn.wav")
                    Log.d("MainActivity", "Voice recording stopped: stoppedCleanly=$stoppedCleanly, exists=${file.exists()}, bytes=${file.length()}")
                    if (stoppedCleanly && file.exists() && file.length() >= 12_000) {
                        // Deliver audio file turn to API
                        Log.d("MainActivity", "Sending voice recording to gateway: ${file.absolutePath}, bytes=${file.length()}")
                        setProgress("Uploading voice to gateway.")
                        progressJob = scope.launch {
                            val updates = listOf(
                                "Transcribing voice.",
                                "Sending transcript to coding agent.",
                                "Waiting for coding agent response.",
                                "Preparing spoken reply."
                            )
                            var index = 0
                            while (state.isProcessing) {
                                delay(7000)
                                if (myTurnGeneration != state.turnGeneration) break
                                val message = updates[index.coerceAtMost(updates.lastIndex)]
                                setProgress(message)
                                if (prefs.speakTurnProgress) {
                                    ttsHelper.speak(message)
                                }
                                if (index < updates.lastIndex) index += 1
                            }
                        }
                        val result = client.sendVoiceTurnDetailed(file, state.transcription)
                        if (myTurnGeneration != state.turnGeneration) return@launch
                        progressJob?.cancel()
                        ttsHelper.stop()
                        if (result.connectionError) {
                            state.transcription = result.transcript
                            state.latestReply = ""
                            handleGatewayConnectionError(result.replyText)
                            return@launch
                        }
                        state.transcription = result.transcript
                        val finalProgressText = result.progress.joinToString("\n")
                        state.progressText = finalProgressText
                        state.latestReply = result.replyText

                        // Try to fetch audio synthesized voice if using ElevenLabs/Gemini Text
                        val replyVoiceFile = File(file.parentFile, "elevenlabs_reply.mp3")
                        val path = if (replyVoiceFile.exists()) replyVoiceFile.absolutePath else null
                        appendChat("user", result.transcript)
                        if (result.progress.isNotEmpty()) {
                            appendChat("progress", finalProgressText, result.progress)
                        }
                        appendChat("assistant", result.replyText, result.progress, path)

                        // Save session record
                        val sessionRecord = RecordedSession(
                            id = UUID.randomUUID().toString(),
                            timestamp = System.currentTimeMillis(),
                            durationSeconds = 4, // Average voice turn
                            recordingPath = file.absolutePath,
                            transcriptionText = result.transcript,
                            replyText = result.replyText,
                            replyAudioPath = path,
                            voiceAgent = prefs.activeAgent
                        )
                        prefs.addRecordedSession(sessionRecord)

                        // If ElevenLabs spoke, play it!
                        if (path != null) {
                            audioHelper.startPlayback(path)
                        } else if (prefs.autoSpeakEnabled && state.latestReply.isNotEmpty()) {
                            ttsHelper.speak(state.latestReply)
                        }
                    } else {
                        if (myTurnGeneration != state.turnGeneration) return@launch
                        state.transcription = "Failed to record voice correctly."
                        state.latestReply = "The audio clip was too short or could not be finalized. Hold the voice button a little longer and try again."
                        appendChat("system", state.latestReply)
                    }
                } catch (_: CancellationException) {
                    if (myTurnGeneration == state.turnGeneration) {
                        state.stopStatusText = "Local request cancelled."
                        setProgress("Local request cancelled.")
                    }
                } catch (e: Exception) {
                    if (myTurnGeneration == state.turnGeneration) {
                        state.latestReply = "System error contacting voice node: ${e.localizedMessage}"
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
    }

    // context declared at the top of StudioTabContent
    val sendTextAction: () -> Unit = sendText@{
        if (state.textInputState.trim().isEmpty() || state.isProcessing) return@sendText
        val promptText = state.textInputState.trim()
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
            setProgress("Sending text to gateway.")
            appendChat("user", promptText)
            try {
                val result = client.sendTextTurnDetailed(promptText)
                if (myTurnGeneration != state.turnGeneration) return@launch
                ttsHelper.stop()
                if (result.connectionError) {
                    state.latestReply = ""
                    handleGatewayConnectionError(result.replyText)
                    return@launch
                }
                state.transcription = result.transcript
                val finalProgressText = result.progress.joinToString("\n")
                state.progressText = finalProgressText
                state.latestReply = result.replyText

                val replyVoiceFile = File(context.cacheDir, "elevenlabs_reply.mp3")
                val path = if (replyVoiceFile.exists()) replyVoiceFile.absolutePath else null
                if (result.progress.isNotEmpty()) {
                    appendChat("progress", finalProgressText, result.progress)
                }
                appendChat("assistant", result.replyText, result.progress, path)

                val sessionRecord = RecordedSession(
                    id = UUID.randomUUID().toString(),
                    timestamp = System.currentTimeMillis(),
                    durationSeconds = 1,
                    recordingPath = "",
                    transcriptionText = result.transcript,
                    replyText = result.replyText,
                    replyAudioPath = path,
                    voiceAgent = prefs.activeAgent
                )
                prefs.addRecordedSession(sessionRecord)

                if (path != null) {
                    audioHelper.startPlayback(path)
                } else if (prefs.autoSpeakEnabled && state.latestReply.isNotEmpty()) {
                    ttsHelper.speak(state.latestReply)
                }
            } catch (_: CancellationException) {
                if (myTurnGeneration == state.turnGeneration) {
                    state.stopStatusText = "Local request cancelled."
                    setProgress("Local request cancelled.")
                }
            } catch (e: Exception) {
                if (myTurnGeneration == state.turnGeneration) {
                    state.latestReply = "System error contacting local node: ${e.localizedMessage}"
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

    StudioCockpitLayout(
        state = state,
        prefs = prefs,
        listState = listState,
        recordingScale = recordingScale,
        permissionState = permissionState,
        liveSessionRef = liveSessionRef,
        livePlayerRef = livePlayerRef,
        audioHelper = audioHelper,
        ttsHelper = ttsHelper,
        haptic = haptic,
        onClearConversation = {
            prefs.clearChatMessages(state.conversationKey)
            state.chatMessages = emptyList()
            state.transcription = ""
            state.latestReply = ""
            state.progressText = ""
        },
        onStopCurrentTurn = { stopCurrentTurn() },
        onStartLiveSession = { startLiveSession() },
        onStopLiveSession = { stopLiveSession() },
        onRecordTrigger = { recordTriggerAction() },
        onStopAndSend = { stopAndSendAction() },
        onSendText = sendTextAction,
    )
}

@Composable
fun CommandsTabContent(
    client: VoiceAgentClient,
    prefs: AppPreferences
) {
    val scope = rememberCoroutineScope()
    var commands by remember { mutableStateOf<List<RemoteSlashCommand>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var isRunning by remember { mutableStateOf(false) }
    var statusText by remember { mutableStateOf("") }
    var customCommand by remember { mutableStateOf("") }

    fun runCommand(commandText: String) {
        val command = commandText.trim()
        if (command.isBlank() || isRunning) return
        scope.launch {
            isRunning = true
            statusText = "Running $command"
            try {
                val result = client.sendTextTurnDetailed(command)
                statusText = result.replyText.ifBlank { "Command accepted." }
            } catch (e: Exception) {
                statusText = "Command failed: ${e.localizedMessage ?: e.javaClass.simpleName}"
            } finally {
                isRunning = false
            }
        }
    }

    LaunchedEffect(prefs.targetIpAddress, prefs.remoteToken) {
        isLoading = true
        commands = client.listSlashCommands()
        statusText = if (commands.isEmpty()) "No commands reported by the gateway." else ""
        isLoading = false
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text(
                        text = "Slash command connector",
                        color = Ink,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Gateway: ${prefs.machineProfileName}",
                        color = InkMuted,
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = customCommand,
                            onValueChange = { customCommand = it },
                            placeholder = { Text("/sess status", color = InkMuted, fontSize = 12.sp) },
                            singleLine = true,
                            enabled = !isRunning,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Accent,
                                unfocusedBorderColor = Line,
                                focusedTextColor = Ink,
                                unfocusedTextColor = Ink,
                                focusedContainerColor = SurfaceSubtle,
                                unfocusedContainerColor = SurfaceSubtle
                            ),
                            modifier = Modifier.weight(1f)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = { runCommand(customCommand) },
                            enabled = customCommand.trim().isNotEmpty() && !isRunning,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Accent,
                                contentColor = SurfacePaper
                            ),
                            modifier = Modifier.heightIn(min = 44.dp),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text("Run", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    if (statusText.isNotBlank()) {
                        Spacer(modifier = Modifier.height(10.dp))
                        Text(
                            text = statusText,
                            color = if (statusText.startsWith("Command failed")) Error else Ink,
                            fontSize = 12.sp,
                            maxLines = 5,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }
        }

        if (isLoading) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(120.dp),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(color = Accent)
                }
            }
        }

        items(commands, key = { it.name }) { command ->
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text(
                        text = "/${command.name}",
                        color = Accent,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace
                    )
                    if (command.description.isNotBlank()) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = command.description,
                            color = Ink,
                            fontSize = 12.sp
                        )
                    }
                    if (command.usage.isNotBlank()) {
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = command.usage,
                            color = InkMuted,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                    if (command.examples.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(10.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            command.examples.take(2).forEach { example ->
                                OutlinedButton(
                                    onClick = { runCommand(example) },
                                    enabled = !isRunning,
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                    modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                                    shape = RoundedCornerShape(12.dp),
                                    border = BorderStroke(1.dp, Line)
                                ) {
                                    Text(
                                        text = example,
                                        fontSize = 10.sp,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                            }
                        }
                    } else {
                        Spacer(modifier = Modifier.height(10.dp))
                        Button(
                            onClick = { runCommand("/${command.name}") },
                            enabled = !isRunning,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Accent,
                                contentColor = Color.White
                            ),
                            modifier = Modifier.heightIn(min = 44.dp),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text("Run /${command.name}", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

// Canvas-drawn Multi-amplitude spectrum bars
@Composable
fun WaveformBars(
    amplitudes: List<Float>,
    active: Boolean
) {
    Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(80.dp)
    ) {
        val spacing = 12.dp.toPx()
        val barWidth = 6.dp.toPx()
        val height = size.height
        val totalBars = amplitudes.size
        val totalWidth = (totalBars * barWidth) + ((totalBars - 1) * spacing)
        val startX = (size.width - totalWidth) / 2f

        for (i in 0 until totalBars) {
            val amp = amplitudes[i]
            // Animate bar size dynamically to give premium look
            val dynamicMultiplier = if (active) (0.6f + (Math.sin(System.currentTimeMillis() / 200.0 + i).toFloat() * 0.4f)) else 1f
            val barHeight = (height * amp * dynamicMultiplier).coerceAtLeast(6.dp.toPx())

            val offset = startX + (i * (barWidth + spacing))
            val topY = (height - barHeight) / 2f
            
            val colorBrush = if (active) {
                androidx.compose.ui.graphics.Brush.verticalGradient(
                    colors = listOf(Accent, Accent.copy(alpha = 0.55f)),
                    startY = topY,
                    endY = topY + barHeight
                )
            } else {
                androidx.compose.ui.graphics.Brush.linearGradient(
                    colors = listOf(Accent.copy(alpha = 0.2f), Accent.copy(alpha = 0.1f))
                )
            }
            
            drawRoundRect(
                brush = colorBrush,
                topLeft = androidx.compose.ui.geometry.Offset(offset, topY),
                size = androidx.compose.ui.geometry.Size(barWidth, barHeight),
                cornerRadius = CornerRadius(barWidth / 2, barWidth / 2)
            )
        }
    }
}

@Composable
fun ScanningRadarGraphic(modifier: Modifier = Modifier) {
    val infiniteTransition = rememberInfiniteTransition(label = "radar")
    val radiusRatio by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(2200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "radius"
    )
    val opacity by infiniteTransition.animateFloat(
        initialValue = 0.8f,
        targetValue = 0f,
        animationSpec = infiniteRepeatable(
            animation = tween(2200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "opacity"
    )

    Canvas(modifier = modifier.size(50.dp)) {
        val center = Offset(size.width / 2f, size.height / 2f)
        val maxRadius = size.width / 2f

        // Draw background radar concentric circles
        drawCircle(
            color = Accent.copy(alpha = 0.15f),
            radius = maxRadius * 0.4f,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )
        drawCircle(
            color = Accent.copy(alpha = 0.15f),
            radius = maxRadius * 0.7f,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )
        drawCircle(
            color = Accent.copy(alpha = 0.15f),
            radius = maxRadius,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )

        // Pulsating wave line
        drawCircle(
            color = Accent.copy(alpha = opacity),
            radius = maxRadius * radiusRatio,
            center = center,
            style = Stroke(width = 2.dp.toPx())
        )

        // Center beacon dot
        drawCircle(
            color = Accent,
            radius = 4.dp.toPx(),
            center = center
        )
    }
}

@Composable
fun DiscoveryTabContent(
    client: com.example.api.VoiceAgentClient,
    prefs: com.example.data.AppPreferences,
    onSessionSelected: (String, String) -> Unit // returns (sessionName, targetIpAddress)
) {
    val scope = rememberCoroutineScope()
    var isScanning by remember { mutableStateOf(false) }
    var machines by remember { mutableStateOf<List<com.example.api.DiscoveredMachine>>(emptyList()) }
    var selectedMachine by remember { mutableStateOf<com.example.api.DiscoveredMachine?>(null) }
    var warpSnapshot by remember { mutableStateOf<com.example.api.WarpControlSnapshot?>(null) }
    var warpStatusText by remember { mutableStateOf("Warp bridge not loaded.") }
    var warpLoading by remember { mutableStateOf(false) }
    var warpTabConfigName by remember { mutableStateOf("phone_remote") }
    val context = androidx.compose.ui.platform.LocalContext.current

    // Trigger automatic network scan on tab launch for seamless UX
    LaunchedEffect(Unit) {
        if (machines.isEmpty()) {
            isScanning = true
            kotlinx.coroutines.delay(1200) // Realistic probing sweep
            machines = client.discoverMachines()
            isScanning = false
            // Automatically select the first online machine
            selectedMachine = machines.firstOrNull { it.status == "online" } ?: machines.firstOrNull()
            warpLoading = true
            warpSnapshot = client.getWarpControlSnapshot()
            warpStatusText = warpSnapshot?.let {
                if (it.available) "Warp bridge ready: ${it.sessions.size} psmux sessions, ${it.paneCount} panes." else "Warp bridge reachable; psmux is not available."
            } ?: "Warp bridge unavailable on active gateway."
            warpLoading = false
        }
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .animateContentSize(),
        contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Sonar Diagnostic Header
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Pi Speak server discovery",
                            color = Ink,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = if (isScanning) "Finding Pi Speak gateways on LAN and Tailscale..." else "Discovery finds machines. Scan the setup QR once to pair.",
                            color = if (isScanning) Accent else InkMuted,
                            fontSize = 11.sp,
                            fontWeight = if (isScanning) FontWeight.SemiBold else FontWeight.Normal
                        )
                    }
                    if (isScanning) {
                        ScanningRadarGraphic()
                    } else {
                        Button(
                            onClick = {
                                scope.launch {
                                    isScanning = true
                                    kotlinx.coroutines.delay(1500)
                                    machines = client.discoverMachines()
                                    isScanning = false
                                    selectedMachine = machines.firstOrNull { it.status == "online" } ?: machines.firstOrNull()
                                    android.widget.Toast.makeText(context, "Network discovery complete.", android.widget.Toast.LENGTH_SHORT).show()
                                }
                            },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Accent,
                                contentColor = Color.White
                            ),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text("Scan", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }

        // Active Target IP Diagnostic bar
        item {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Detected Pi Speak servers",
                    color = InkMuted,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.8.sp
                )
                Text(
                    text = "Active gateway: ${prefs.targetIpAddress}",
                    color = Accent,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }

        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Warp / psmux control",
                                color = Ink,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = warpStatusText,
                                color = if (warpSnapshot?.available == true) Success else InkMuted,
                                fontSize = 11.sp,
                                lineHeight = 15.sp
                            )
                            warpSnapshot?.warpRemoteBaseUrl?.let { url ->
                                Text(
                                    text = "Warp relay: $url",
                                    color = InkMuted,
                                    fontSize = 10.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            warpSnapshot?.let { snapshot ->
                                Text(
                                    text = "Connection: ${if (snapshot.sameTailnet) "Tailscale" else "gateway"} • ${prefs.targetIpAddress} • ${snapshot.warpUriScheme}://",
                                    color = InkMuted,
                                    fontSize = 10.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                snapshot.psmuxError?.let { error ->
                                    Text(
                                        text = "psmux: $error",
                                        color = Accent,
                                        fontSize = 10.sp,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                            }
                        }
                        Button(
                            onClick = {
                                scope.launch {
                                    warpLoading = true
                                    warpSnapshot = client.getWarpControlSnapshot()
                                    warpStatusText = warpSnapshot?.let {
                                        if (it.available) "Warp bridge ready: ${it.sessions.size} psmux sessions, ${it.paneCount} panes." else "Warp bridge reachable; psmux is not available."
                                    } ?: "Warp bridge unavailable on active gateway."
                                    warpLoading = false
                                }
                            },
                            enabled = !warpLoading,
                            colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Color.White),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text(if (warpLoading) "Loading" else "Refresh", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    OutlinedTextField(
                        value = warpTabConfigName,
                        onValueChange = { warpTabConfigName = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Warp tab config", fontSize = 11.sp) },
                        placeholder = { Text("phone_remote", fontSize = 11.sp) },
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Spacer(modifier = Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        TextButton(
                            onClick = {
                                scope.launch {
                                    warpStatusText = client.createWarpTab(prefs.workspacePath)
                                    warpSnapshot = client.getWarpControlSnapshot()
                                }
                            }
                        ) { Text("New Warp tab") }
                        TextButton(
                            onClick = {
                                scope.launch {
                                    warpStatusText = client.openWarpTabConfig(warpTabConfigName.trim())
                                    warpSnapshot = client.getWarpControlSnapshot()
                                }
                            },
                            enabled = warpTabConfigName.isNotBlank()
                        ) { Text("Open Warp config") }
                        TextButton(
                            onClick = {
                                scope.launch {
                                    val name = "phone-${System.currentTimeMillis()}"
                                    warpStatusText = client.createWarpPsmuxSession(name, prefs.workspacePath)
                                    warpSnapshot = client.getWarpControlSnapshot()
                                }
                            }
                        ) { Text("New psmux session") }
                        val firstSession = warpSnapshot?.sessions?.firstOrNull()?.name
                        TextButton(
                            enabled = firstSession != null,
                            onClick = {
                                val session = firstSession ?: return@TextButton
                                scope.launch {
                                    val name = "phone-${System.currentTimeMillis()}"
                                    warpStatusText = client.createWarpPsmuxWindow(session, name, prefs.workspacePath)
                                    warpSnapshot = client.getWarpControlSnapshot()
                                }
                            }
                        ) { Text("New psmux tab") }
                    }
                    warpSnapshot?.sessions?.take(6)?.forEach { session ->
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Session ${session.name}",
                            color = Ink,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                        session.windows.take(4).forEach { window ->
                            Text(
                                text = "  tab ${window.index}: ${window.name}",
                                color = InkMuted,
                                fontSize = 11.sp
                            )
                            window.panes.take(8).forEach { pane ->
                                Text(
                                    text = "    pane ${pane.paneId.ifBlank { pane.pane }} ${if (pane.active) "• active" else ""} ${pane.command ?: ""}",
                                    color = if (pane.active) Success else InkMuted,
                                    fontSize = 10.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                }
            }
        }

        // Machines list selection
        if (machines.isEmpty() && isScanning) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(140.dp),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(color = Accent)
                }
            }
        } else if (machines.isEmpty()) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "No Pi Speak servers found yet.",
                        color = InkMuted,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Tap Scan to probe LAN and Tailscale, or run /pk-remote on the host to pair.",
                        color = InkMuted,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center
                    )
                }
            }
        } else {
            machines.forEach { machine ->
                item {
                    val isMachineActive = prefs.targetIpAddress == machine.ip
                    val isMachineSelected = selectedMachine?.ip == machine.ip
                    val isOnline = machine.status == "online"
                    val needsSetupQr = isOnline && machine.requiresPairing && prefs.remoteToken.isBlank()

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                selectedMachine = machine
                                if (needsSetupQr) {
                                    android.widget.Toast.makeText(
                                        context,
                                        "Gateway found. Run /pk-remote on the computer and scan the setup QR to pair.",
                                        android.widget.Toast.LENGTH_LONG
                                    ).show()
                                } else if (isOnline) {
                                    onSessionSelected(prefs.codexSessionName, machine.ip)
                                }
                            },
                        color = if (isMachineSelected) AccentSoft else SurfacePaper,
                        shape = RoundedCornerShape(16.dp),
                        border = BorderStroke(
                            width = 1.dp,
                            color = if (isMachineSelected) Accent else Line
                        )
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Box(
                                        modifier = Modifier
                                            .size(8.dp)
                                            .clip(CircleShape)
                                            .background(if (isOnline) Success else InkMuted)
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = machine.name,
                                        color = if (isOnline) Ink else InkMuted,
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (isOnline) SuccessSoft else SurfaceMuted)
                                        .padding(horizontal = 6.dp, vertical = 2.dp)
                                ) {
                                    Text(
                                        text = if (isOnline) "${machine.latencyMs}ms" else "Offline",
                                        color = if (isOnline) Success else InkMuted,
                                        fontSize = 9.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "Endpoint: ${machine.ip}",
                                color = InkMuted,
                                fontSize = 11.sp
                            )
                            if (needsSetupQr) {
                                Spacer(modifier = Modifier.height(6.dp))
                                Text(
                                    text = "Setup required: scan the QR from /pk-remote on this computer.",
                                    color = Accent,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }

                            Spacer(modifier = Modifier.height(8.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "${machine.activeSessions.size} AI sessions cached",
                                    color = InkMuted,
                                    fontSize = 11.sp
                                )

                                if (needsSetupQr) {
                                    Text(
                                        text = "Pair with QR",
                                        color = Accent,
                                        fontSize = 9.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                } else if (isOnline) {
                                    if (isMachineActive) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Box(
                                                modifier = Modifier
                                                    .size(12.dp)
                                                    .clip(CircleShape)
                                                    .background(Success),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(
                                                    text = "✓",
                                                    color = Color.White,
                                                    fontSize = 8.sp,
                                                    fontWeight = FontWeight.Bold
                                                )
                                            }
                                            Spacer(modifier = Modifier.width(6.dp))
                                            Text(
                                                text = "Active gateway",
                                                color = Success,
                                                fontSize = 10.sp,
                                                fontWeight = FontWeight.Bold
                                            )
                                        }
                                    } else {
                                        Text(
                                            text = "Tap to rotate gateway",
                                            color = Accent,
                                            fontSize = 9.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                } else {
                                    Text(
                                        text = "Host unreachable",
                                        color = Error,
                                        fontSize = 9.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // Selected Machine Session matrix
        val currentMachine = selectedMachine
        if (currentMachine != null && currentMachine.status == "online" && !(currentMachine.requiresPairing && prefs.remoteToken.isBlank())) {
            item {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Running sessions on ${currentMachine.name}",
                    color = InkMuted,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.8.sp,
                    modifier = Modifier.padding(horizontal = 4.dp)
                )
            }

            currentMachine.activeSessions.forEach { session ->
                item {
                    val isSessionActive = prefs.codexSessionName == session.sessionId && prefs.targetIpAddress == currentMachine.ip
                    val badgeColor = when (session.engineType.uppercase()) {
                        "CODEX" -> Success
                        "AGY" -> Warn
                        "CLAUDE" -> Accent
                        "KIMI" -> Ink
                        else -> InkMuted
                    }

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                onSessionSelected(session.sessionId, currentMachine.ip)
                                android.widget.Toast.makeText(
                                    context,
                                    "Connected to ${session.engineType} session: ${session.sessionId}",
                                    android.widget.Toast.LENGTH_SHORT
                                ).show()
                            },
                        color = if (isSessionActive) SuccessSoft else SurfaceSubtle,
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(
                            width = 1.dp,
                            color = if (isSessionActive) Success else Line
                        )
                    ) {
                        Row(
                            modifier = Modifier.padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Box(
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(badgeColor.copy(alpha = 0.15f))
                                            .border(1.dp, badgeColor, RoundedCornerShape(8.dp))
                                            .padding(horizontal = 6.dp, vertical = 2.dp)
                                    ) {
                                        Text(
                                            text = session.engineType,
                                            color = badgeColor,
                                            fontSize = 9.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = session.sessionId,
                                        color = Ink,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = session.description,
                                    color = InkMuted,
                                    fontSize = 11.sp
                                )
                            }

                            if (isSessionActive) {
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(SuccessSoft)
                                        .border(1.dp, Success, RoundedCornerShape(6.dp))
                                        .padding(horizontal = 8.dp, vertical = 4.dp)
                                ) {
                                    Text(
                                        text = "Mounted",
                                        color = Success,
                                        fontSize = 8.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            } else {
                                Button(
                                    onClick = {
                                        onSessionSelected(session.sessionId, currentMachine.ip)
                                        android.widget.Toast.makeText(
                                            context,
                                            "Connected to ${session.engineType} session: ${session.sessionId}",
                                            android.widget.Toast.LENGTH_SHORT
                                        ).show()
                                    },
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = SurfaceMuted,
                                        contentColor = InkMuted
                                    ),
                                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                                    shape = RoundedCornerShape(12.dp),
                                    modifier = Modifier.heightIn(min = 44.dp)
                                ) {
                                    Text("Mount", fontSize = 10.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }
                }
            }
        } else if (currentMachine != null) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "Selected target is currently offline. Cannot mount active context tunnels.",
                        color = Error,
                        fontSize = 12.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}

/** Peak |amplitude| of little-endian 16-bit mono PCM; used for live-mode VAD barge-in. */
private fun pcmPeakAmplitude(pcm: ByteArray): Int {
    var peak = 0
    var i = 0
    while (i + 1 < pcm.size) {
        val sample = (((pcm[i + 1].toInt() and 0xFF) shl 8) or (pcm[i].toInt() and 0xFF)).toShort().toInt()
        val magnitude = if (sample < 0) -sample else sample
        if (magnitude > peak) peak = magnitude
        i += 2
    }
    return peak
}
