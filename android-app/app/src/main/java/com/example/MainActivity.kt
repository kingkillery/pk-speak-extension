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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
import com.example.api.GatewaySessionErrorKind
import com.example.api.GatewaySessionException
import com.example.api.VoiceAgentClient
import com.example.api.RemoteSlashCommand
import com.example.api.RealtimeVoiceClient
import com.example.api.RealtimeListener
import com.example.audio.AudioHelper
import com.example.audio.TtsHelper
import com.example.data.AppPreferences
import com.example.data.ChatMessage
import com.example.data.RecordedSession
import com.example.ui.theme.MyApplicationTheme
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var audioHelper: AudioHelper
    private lateinit var ttsHelper: TtsHelper
    private lateinit var appPreferences: AppPreferences
    private lateinit var voiceAgentClient: VoiceAgentClient

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        audioHelper = AudioHelper(this)
        ttsHelper = TtsHelper(this)
        appPreferences = AppPreferences(this)
        appPreferences.clearGatewayConfigIfAppUpgraded(BuildConfig.VERSION_CODE)
        voiceAgentClient = VoiceAgentClient(this, appPreferences)
        
        handleDeepLink(intent)

        setContent {
            MyApplicationTheme {
                Scaffold(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color(0xFFF4F1E9))
                ) { innerPadding ->
                    PiSpeakConsoleScreen(
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        prefs = appPreferences,
                        client = voiceAgentClient,
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
        intent?.data?.let { uri ->
            if (uri.scheme == "pi-speak" && uri.host == "setup") {
                val baseUrl = uri.getQueryParameter("base_url")
                val token = uri.getQueryParameter("token")
                val profileName = uri.getQueryParameter("profile_name") ?: uri.getQueryParameter("machine_id")
                val connectionMode = uri.getQueryParameter("connection_mode")
                val defaultTarget = uri.getQueryParameter("default_target")
                    ?: uri.getQueryParameter("target")
                    ?: uri.getQueryParameter("session")
                val agentProvider = uri.getQueryParameter("agent_provider")
                val workspaceRoot = uri.getQueryParameter("workspace_root")
                val workspacePath = uri.getQueryParameter("workspace_path")

                baseUrl?.let { appPreferences.targetIpAddress = it.trim().trimEnd('/') }
                token?.takeIf { it.isNotBlank() }?.let { appPreferences.remoteToken = it }
                profileName?.let { appPreferences.machineProfileName = it }
                defaultTarget?.takeIf { it.isNotBlank() }?.let { appPreferences.codexSessionName = it }
                workspaceRoot?.takeIf { it.isNotBlank() }?.let { appPreferences.workspaceRoot = it }
                workspacePath?.takeIf { it.isNotBlank() }?.let { appPreferences.workspacePath = it }
                connectionMode?.let { appPreferences.connectionMode = it }
                when (agentProvider?.lowercase()) {
                    "codex", "pi" -> appPreferences.activeAgent = "Local Codex (Pi)"
                    "claude" -> appPreferences.activeAgent = "Gateway Claude (Claude Code)"
                    "elevenlabs" -> appPreferences.activeAgent = "Gateway Voice (ElevenLabs)"
                    "gemini", "gemini-live", "vertex" -> appPreferences.activeAgent = "Gateway Gemini (Vertex AI)"
                }
                Log.d("MainActivity", "Successfully processed zero-touch onboarding QR link: base_url=$baseUrl, profile=$profileName, target=$defaultTarget")
            }
        }
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
    val realtimeClient = remember { com.example.api.RealtimeVoiceClient(context, prefs) }

    // Synchronize agent state
    LaunchedEffect(selectedAgent) {
        prefs.activeAgent = selectedAgent
    }

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)

    val tabTitle = when (currentTab) {
        "studio" -> "Studio"
        "discovery" -> "Discover"
        "commands" -> "Commands"
        "sessions" -> "Sessions"
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

    LaunchedEffect(Unit) {
        var unreachableSinceMs: Long? = null
        var lastLoggedConnectionStatus = ""
        while (true) {
            val startTime = System.currentTimeMillis()
            val healthy = client.pingHealth()
            val latency = System.currentTimeMillis() - startTime
            if (healthy) {
                unreachableSinceMs = null
                studioState.isGatewayConnected = true
                studioState.isReconnecting = false
                studioState.connectionLatencyMs = latency
                studioState.connectionStatusText = "Connected"
                studioState.connectionBannerText = ""
            } else {
                val firstFailureMs = unreachableSinceMs ?: System.currentTimeMillis()
                unreachableSinceMs = firstFailureMs
                studioState.isGatewayConnected = false
                studioState.isReconnecting = true
                studioState.connectionStatusText = "Reconnecting..."
                val reconnectStartTime = System.currentTimeMillis()
                val result = withContext(Dispatchers.IO) { client.tryAutoConnect(forceVerify = true) }
                val reconnectLatency = System.currentTimeMillis() - reconnectStartTime
                codexSessionName = prefs.codexSessionName
                if (result.connected) {
                    unreachableSinceMs = null
                    studioState.isGatewayConnected = true
                    studioState.isReconnecting = false
                    studioState.connectionLatencyMs = reconnectLatency
                    studioState.connectionStatusText = "Connected"
                    studioState.connectionBannerText = ""
                } else {
                    val elapsedMs = System.currentTimeMillis() - firstFailureMs
                    studioState.isReconnecting = elapsedMs <= 10_000L
                    studioState.connectionStatusText = if (studioState.isReconnecting) "Searching for gateway..." else "Gateway unreachable"
                    if (studioState.connectionBannerText.isBlank()) {
                        studioState.connectionBannerText = result.message.ifBlank { "Gateway is unreachable. Searching for a Pi Speak server." }
                    }
                }
            }
            if (studioState.connectionStatusText != lastLoggedConnectionStatus) {
                lastLoggedConnectionStatus = studioState.connectionStatusText
                Log.d("PiSpeakConnection", "Gateway connection state: ${studioState.connectionStatusText}")
            }
            delay(5_000)
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        scrimColor = Color(0x66211C16),
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
            .background(Color(0xFFF4F1E9))
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
        ) {
            // Top bar: menu / serif title / settings (Claude "paper" header)
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

            // Content Container with smooth fade effects
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(horizontal = 16.dp)
            ) {
                when (currentTab) {
                    "studio" -> StudioTabContent(
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        prefs = prefs,
                        client = client,
                        runtimeState = studioState,
                        appScope = scope,
                        realtimeClient = realtimeClient
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

            // Android standard decoration indicator at bottom
            Spacer(modifier = Modifier.height(12.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp),
                contentAlignment = Alignment.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(width = 120.dp, height = 4.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(Color(0xFFE3DCCC))
                )
            }
        }
        ConnectionErrorBanner(
            message = studioState.connectionBannerText,
            onDismiss = { studioState.connectionBannerText = "" },
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = 76.dp, start = 16.dp, end = 16.dp)
        )
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
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        // Menu (opens the navigation drawer)
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .clickable { onMenuClick() },
            contentAlignment = Alignment.Center
        ) {
            Text(text = "≡", color = Color(0xFF211C16), fontSize = 22.sp)
        }

        Column(
            modifier = Modifier.weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                Text(
                    text = title,
                    color = Color(0xFF211C16),
                    style = MaterialTheme.typography.titleLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(text = "⌄", color = Color(0xFF6E665A), fontSize = 16.sp)
            }
            Spacer(modifier = Modifier.height(2.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(connectionColor)
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = "$connectionStatusText | Codex: $sessionName",
                    color = Color(0xFF6E665A),
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (isGatewayConnected && connectionLatencyMs >= 0L) {
                    Spacer(modifier = Modifier.width(6.dp))
                    val badgeBg = when {
                        connectionLatencyMs < 100L -> Color(0xFFDCFCE7)
                        connectionLatencyMs < 300L -> Color(0xFFFEF3C7)
                        else -> Color(0xFFFEE2E2)
                    }
                    val badgeFg = when {
                        connectionLatencyMs < 100L -> Color(0xFF156534)
                        connectionLatencyMs < 300L -> Color(0xFF92400E)
                        else -> Color(0xFF991B1B)
                    }
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(badgeBg)
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text(
                            text = "${connectionLatencyMs}ms",
                            color = badgeFg,
                            fontSize = 9.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }

        // Settings
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .clickable { onSettingsClick() },
            contentAlignment = Alignment.Center
        ) {
            Text(text = "⚙", color = Color(0xFF211C16), fontSize = 18.sp)
        }
    }
}

fun gatewayConnectionIndicatorColor(isGatewayConnected: Boolean, isReconnecting: Boolean): Color = when {
    isGatewayConnected -> Color(0xFF22C55E)
    isReconnecting -> Color(0xFFF59E0B)
    else -> Color(0xFFEF4444)
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
            color = Color(0xFF3A2424),
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, Color(0xFF7F1D1D)),
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
                        .background(Color(0xFFEF4444))
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = message,
                    color = Color(0xFFFFD7D7),
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    modifier = Modifier.weight(1f)
                )
                TextButton(
                    onClick = onDismiss,
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                ) {
                    Text("Dismiss", color = Color(0xFFFFD7D7), fontSize = 11.sp)
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
        drawerContainerColor = Color(0xFFF4F1E9),
        drawerContentColor = Color(0xFF211C16),
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
                color = Color(0xFF211C16),
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(horizontal = 6.dp)
            )
            Spacer(modifier = Modifier.height(16.dp))

            // Accent "New session" action (mirrors Claude's "New chat")
            DrawerRow(
                glyph = "＋",
                label = "New session",
                selected = false,
                accent = true,
                onClick = { onSelect("studio") }
            )

            Spacer(modifier = Modifier.height(4.dp))
            DrawerRow(glyph = "◉", label = "Studio", selected = activeTab == "studio") { onSelect("studio") }
            DrawerRow(glyph = "⊚", label = "Discover", selected = activeTab == "discovery") { onSelect("discovery") }
            DrawerRow(glyph = "</>", label = "Commands", selected = activeTab == "commands", mono = true) { onSelect("commands") }
            DrawerRow(glyph = "≣", label = "Sessions", selected = activeTab == "sessions") { onSelect("sessions") }
            DrawerRow(glyph = "⚙", label = "Configure", selected = activeTab == "settings") { onSelect("settings") }

            if (recents.isNotEmpty()) {
                Spacer(modifier = Modifier.height(18.dp))
                Text(
                    text = "Recent turns",
                    color = Color(0xFF6E665A),
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
                            color = Color(0xFF211C16),
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
            Divider(color = Color(0xFFE3DCCC))
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
                        .background(Color(0xFFC2542F)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = profileName.take(2).uppercase().ifBlank { "PI" },
                        color = Color(0xFFFFFFFF),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Text(
                    text = profileName.ifBlank { "Pi Speak" },
                    color = Color(0xFF211C16),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(text = "⚙", color = Color(0xFF6E665A), fontSize = 18.sp)
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
        accent -> Color(0xFFC2542F)
        else -> Color(0xFF211C16)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) Color(0xFFEDE7DB) else Color.Transparent)
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
    var isRealtimeActive by mutableStateOf(false)
    var isRealtimeConnected by mutableStateOf(false)
}

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun StudioTabContent(
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
    client: VoiceAgentClient,
    runtimeState: StudioRuntimeState,
    appScope: CoroutineScope,
    realtimeClient: com.example.api.RealtimeVoiceClient
) {
    val permissionState = rememberPermissionState(permission = Manifest.permission.RECORD_AUDIO)
    val scope = appScope
    val state = runtimeState
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current

    LaunchedEffect(realtimeClient) {
        realtimeClient.listener = object : com.example.api.RealtimeListener {
            override fun onTranscript(text: String) {
                state.transcription = text
            }

            override fun onTextReply(text: String) {
                state.latestReply = text
            }

            override fun onInterrupt() {
                state.latestReply = "Interrupted"
            }

            override fun onError(message: String) {
                state.latestReply = "Realtime error: $message"
            }

            override fun onStatusChanged(connected: Boolean) {
                state.isRealtimeConnected = connected
            }
        }
    }

    DisposableEffect(realtimeClient) {
        onDispose {
            if (state.isRealtimeActive) {
                state.isRealtimeActive = false
                realtimeClient.stop()
            }
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
            val reconnect = withContext(Dispatchers.IO) { client.tryAutoConnect(forceVerify = true) }
            state.isGatewayConnected = reconnect.connected
            state.isReconnecting = false
            state.connectionStatusText = if (reconnect.connected) "Connected" else "Gateway unreachable"
            if (reconnect.connected) {
                state.connectionBannerText = ""
            } else if (state.connectionBannerText.isBlank()) {
                state.connectionBannerText = reconnect.message.ifBlank { "Gateway is unreachable. Searching for a Pi Speak server." }
            }
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
                    val elapsedMs = System.currentTimeMillis() - recordingStartedAtMs
                    if (elapsedMs in 0 until minimumVoiceCaptureMs) {
                        delay(minimumVoiceCaptureMs - elapsedMs)
                    }
                    val stoppedCleanly = audioHelper.stopRecording()
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top
    ) {
        // Minimal status pill at top
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = when {
                    state.isRealtimeActive -> {
                        if (state.isRealtimeConnected) "● Live Connected" else "● Live Connecting..."
                    }
                    state.isRecording -> "● Recording"
                    state.stopStatusText == "Stopping..." -> "● Stopping..."
                    state.isProcessing -> "● Agent working..."
                    else -> "● Idle"
                },
                color = when {
                    state.isRealtimeActive -> if (state.isRealtimeConnected) Color(0xFF2E7D52) else Color(0xFFC97E1A)
                    state.isRecording -> Color(0xFFC2542F)
                    else -> Color(0xFF6E665A)
                },
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 8.dp)
            )
            if (state.chatMessages.isNotEmpty()) {
                TextButton(
                    onClick = {
                        prefs.clearChatMessages(state.conversationKey)
                        state.chatMessages = emptyList()
                        state.transcription = ""
                        state.latestReply = ""
                        state.progressText = ""
                    },
                    enabled = !state.isProcessing,
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                ) {
                    Text("Clear", color = Color(0xFF8E9199), fontSize = 11.sp)
                }
            }
        }

        // Live Real-Time Transcribe & Response View Card
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(top = 8.dp, bottom = 10.dp)
        ) {
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(24.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    if (state.chatMessages.isNotEmpty()) {
                        item {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "CONVERSATION LOG",
                                    color = Color(0xFFC2542F),
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 1.sp
                                )
                                TextButton(
                                    onClick = {
                                        prefs.clearChatMessages(state.conversationKey)
                                        state.chatMessages = emptyList()
                                        state.transcription = ""
                                        state.latestReply = ""
                                        state.progressText = ""
                                    },
                                    enabled = !state.isProcessing,
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                                ) {
                                    Text("Clear", color = Color(0xFF6E665A), fontSize = 10.sp)
                                }
                            }
                        }
                        items(state.chatMessages, key = { it.id }) { message ->
                            val isUser = message.role == "user"
                            val isProgress = message.role == "progress"
                            val isPlayingThisMessage = state.playingMessageId == message.id
                            Column(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalAlignment = if (isUser) Alignment.End else Alignment.Start
                            ) {
                                Text(
                                    text = when (message.role) {
                                        "user" -> "YOU"
                                        "assistant" -> prefs.activeAgent.uppercase()
                                        "progress" -> "PROGRESS"
                                        else -> "SYSTEM"
                                    },
                                    color = when (message.role) {
                                        "user" -> Color(0xFFC2542F)
                                        "assistant" -> Color(0xFF2E7D52)
                                        "progress" -> Color(0xFF6E665A)
                                        else -> Color(0xFFB3261E)
                                    },
                                    fontSize = 9.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 0.5.sp
                                )
                                Spacer(modifier = Modifier.height(3.dp))
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth(if (isUser) 0.86f else 1f)
                                        .background(
                                            when {
                                                isUser -> Color(0xFFFBF1EC)
                                                isProgress -> Color(0xFFF0ECE2)
                                                else -> Color(0xFFF0ECE2)
                                            },
                                            RoundedCornerShape(8.dp)
                                        )
                                        .border(
                                            1.dp,
                                            if (isProgress) Color(0xFFE3DCCC) else Color(0xFFE3DCCC),
                                            RoundedCornerShape(8.dp)
                                        )
                                        .padding(10.dp)
                                ) {
                                    Column {
                                        Text(
                                            text = message.text,
                                            color = if (isProgress) Color(0xFF6E665A) else Color(0xFF211C16),
                                            fontSize = if (isProgress) 11.sp else 13.sp,
                                            lineHeight = if (isProgress) 16.sp else 19.sp,
                                            fontFamily = if (message.role == "assistant") FontFamily.Monospace else FontFamily.Default
                                        )
                                        if (!isProgress) {
                                            Spacer(modifier = Modifier.height(6.dp))
                                            Row(
                                                modifier = Modifier.fillMaxWidth(),
                                                horizontalArrangement = Arrangement.End,
                                                verticalAlignment = Alignment.CenterVertically
                                            ) {
                                                val clipboardManager = androidx.compose.ui.platform.LocalClipboardManager.current
                                                val context = androidx.compose.ui.platform.LocalContext.current
                                                Text(
                                                    text = "Copy",
                                                    color = Color(0xFF6E665A),
                                                    fontSize = 11.sp,
                                                    fontWeight = FontWeight.SemiBold,
                                                    modifier = Modifier.clickable {
                                                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                                        clipboardManager.setText(androidx.compose.ui.text.AnnotatedString(message.text))
                                                        android.widget.Toast.makeText(context, "Copied to clipboard", android.widget.Toast.LENGTH_SHORT).show()
                                                    }
                                                )
                                                Spacer(modifier = Modifier.width(16.dp))
                                                Text(
                                                    text = if (isPlayingThisMessage) "Stop" else "Play",
                                                    color = if (isPlayingThisMessage) Color(0xFFC2542F) else Color(0xFF6E665A),
                                                    fontSize = 11.sp,
                                                    fontWeight = FontWeight.SemiBold,
                                                    modifier = Modifier.clickable {
                                                        if (isPlayingThisMessage) {
                                                            audioHelper.stopPlayback()
                                                            ttsHelper.stop()
                                                            state.playingMessageId = null
                                                        } else {
                                                            audioHelper.stopPlayback()
                                                            ttsHelper.stop()
                                                            state.playingMessageId = message.id
                                                            val audioPath = message.audioPath
                                                            if (!audioPath.isNullOrBlank() && java.io.File(audioPath).exists()) {
                                                                audioHelper.startPlayback(audioPath) {
                                                                    if (state.playingMessageId == message.id) {
                                                                        state.playingMessageId = null
                                                                    }
                                                                }
                                                            } else {
                                                                ttsHelper.speak(message.text) {
                                                                    if (state.playingMessageId == message.id) {
                                                                        state.playingMessageId = null
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (state.transcription.isNotEmpty()) {
                        item {
                            Column {
                                Text(
                                    text = "TRANSCRIPT STREAM",
                                    color = Color(0xFFC2542F),
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 1.sp
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = "${state.transcription}...",
                                    color = Color(0xFF211C16),
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Medium
                                )
                            }
                        }
                    }

                    if (state.isProcessing) {
                        item {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 16.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                CircularProgressIndicator(
                                    color = Color(0xFFC2542F),
                                    strokeWidth = 2.dp,
                                    modifier = Modifier.size(24.dp)
                                )
                                if (prefs.showTurnProgress && state.progressText.isNotBlank()) {
                                    Spacer(modifier = Modifier.height(10.dp))
                                    Text(
                                        text = state.progressText,
                                        color = Color(0xFF211C16),
                                        fontSize = 12.sp,
                                        lineHeight = 17.sp,
                                        textAlign = TextAlign.Center
                                    )
                                }
                                Spacer(modifier = Modifier.height(12.dp))
                                OutlinedButton(
                                    onClick = { stopCurrentTurn() },
                                    enabled = state.stopStatusText != "Stopping...",
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFB3261E)),
                                    border = BorderStroke(1.dp, Color(0xFFC2542F)),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Text(
                                        if (state.stopStatusText == "Stopping...") "Stopping..." else "Stop turn",
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }

                    if (state.latestReply.isNotEmpty() && !state.isProcessing) {
                        item {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 8.dp)
                            ) {
                                Divider(color = Color(0xFFE3DCCC), modifier = Modifier.padding(vertical = 8.dp))
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.End,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "CODEX DEPLOYER REPLY",
                                        color = Color(0xFF2E7D52),
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold,
                                        letterSpacing = 1.sp
                                    )
                                    Text(
                                        text = prefs.activeAgent,
                                        color = Color(0xFF6E665A),
                                        fontSize = 10.sp
                                    )
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                if (prefs.showTurnProgress && state.progressText.isNotBlank()) {
                                    Text(
                                        text = state.progressText,
                                        color = Color(0xFF6E665A),
                                        fontSize = 11.sp,
                                        lineHeight = 16.sp
                                    )
                                    Spacer(modifier = Modifier.height(8.dp))
                                }
                                Text(
                                    text = "\"${state.latestReply}\"",
                                    color = Color(0xFF211C16),
                                    fontSize = 15.sp,
                                    lineHeight = 22.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                        }
                    }
                    // Empty State Guidelines
                    if (state.transcription.isEmpty() && state.latestReply.isEmpty()) {
                        item {
                            Column(
                                modifier = Modifier
                                    .fillParentMaxSize()
                                    .alpha(0.6f),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.Center
                            ) {
                                Text(
                                    text = "Ready for input transmission.",
                                    color = Color(0xFF6E665A),
                                    fontSize = 14.sp
                                )
                                Text(
                                    text = if (prefs.transmissionMode == "PTT")
                                        "Long press the tactical pad below to talk."
                                    else "Tap the tactical pad below to toggle mic.",
                                    color = Color(0xFF6E665A),
                                    fontSize = 12.sp,
                                    textAlign = TextAlign.Center
                                )
                            }
                        }
                    }
                }
            }
        }
        // Claude-style composer: rounded paper card with prompt + action row.
        val context = androidx.compose.ui.platform.LocalContext.current
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

                    // Try to fetch audio synthesized voice if using ElevenLabs
                    val replyVoiceFile = File(context.cacheDir, "elevenlabs_reply.mp3")
                    val path = if (replyVoiceFile.exists()) replyVoiceFile.absolutePath else null
                    if (result.progress.isNotEmpty()) {
                        appendChat("progress", finalProgressText, result.progress)
                    }
                    appendChat("assistant", result.replyText, result.progress, path)

                    // Save session record
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

        val canSend = state.textInputState.trim().isNotEmpty() && !state.isProcessing
        val quickCommands = listOf("/sess status", "/sess slots", "/sess ui", "/remote status", "/speak status")
        LazyRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            items(quickCommands) { cmd ->
                Surface(
                    color = Color(0xFFEDE7DB),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.clickable {
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        state.textInputState = cmd
                    }
                ) {
                    Text(
                        text = cmd,
                        color = Color(0xFF211C16),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                    )
                }
            }
        }
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 12.dp),
            color = Color(0xFFFFFFFF),
            shape = RoundedCornerShape(26.dp),
            border = BorderStroke(1.dp, Color(0xFFE3DCCC)),
            shadowElevation = 2.dp
        ) {
            Column(
                modifier = Modifier.padding(start = 18.dp, end = 12.dp, top = 14.dp, bottom = 10.dp)
            ) {
                BasicTextField(
                    value = state.textInputState,
                    onValueChange = { state.textInputState = it },
                    enabled = !state.isProcessing,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = Color(0xFF211C16)),
                    cursorBrush = SolidColor(Color(0xFFC2542F)),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 28.dp, max = 140.dp),
                    decorationBox = { inner ->
                        if (state.textInputState.isEmpty()) {
                            Text(
                                text = "Message Pi Speak…",
                                color = Color(0xFF6E665A),
                                style = MaterialTheme.typography.bodyLarge
                            )
                        }
                        inner()
                    }
                )

                Spacer(modifier = Modifier.height(10.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    // "</> Code" affordance — primes a slash command in the field.
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(16.dp))
                            .border(BorderStroke(1.dp, Color(0xFFE3DCCC)), RoundedCornerShape(16.dp))
                            .clickable(enabled = !state.isProcessing) {
                                if (!state.textInputState.startsWith("/")) {
                                    state.textInputState = "/" + state.textInputState
                                }
                            }
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("</>", color = Color(0xFF6E665A), fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Code", color = Color(0xFF211C16), fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        // Voice capture lives in the composer so the chat history keeps the screen.
                        if (state.isRealtimeActive) {
                            Box(
                                modifier = Modifier
                                    .height(44.dp)
                                    .widthIn(min = 72.dp)
                                    .clip(CircleShape)
                                    .background(Color(0xFFC2542F))
                                    .border(BorderStroke(1.dp, Color(0xFFE3DCCC)), CircleShape)
                                    .clickable {
                                        realtimeClient.interrupt()
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = "Interrupt",
                                    color = Color.White,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(horizontal = 8.dp)
                                )
                            }
                            Box(
                                modifier = Modifier
                                    .height(44.dp)
                                    .widthIn(min = 72.dp)
                                    .clip(CircleShape)
                                    .background(Color(0xFF2E7D52))
                                    .border(BorderStroke(1.dp, Color(0xFFE3DCCC)), CircleShape)
                                    .clickable {
                                        state.isRealtimeActive = false
                                        realtimeClient.stop()
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = "Live On",
                                    color = Color.White,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(horizontal = 8.dp)
                                )
                            }
                        } else {
                            Box(
                                modifier = Modifier
                                    .height(44.dp)
                                    .widthIn(min = 72.dp)
                                    .clip(CircleShape)
                                    .background(Color(0xFFF4F1E9))
                                    .border(BorderStroke(1.dp, Color(0xFFE3DCCC)), CircleShape)
                                    .clickable {
                                        if (!permissionState.status.isGranted) {
                                            permissionState.launchPermissionRequest()
                                        } else {
                                            state.isRealtimeActive = true
                                            realtimeClient.start()
                                        }
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = "Live Off",
                                    color = Color(0xFF211C16),
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(horizontal = 8.dp)
                                )
                            }
                            Box(
                                modifier = Modifier
                                    .height(44.dp)
                                    .widthIn(min = 72.dp)
                                    .scale(if (state.isRecording) recordingScale else 1f)
                                    .clip(CircleShape)
                                    .background(if (state.isRecording) Color(0xFFC2542F) else Color(0xFFF4F1E9))
                                    .border(BorderStroke(1.dp, Color(0xFFE3DCCC)), CircleShape)
                                    .pointerInput(prefs.transmissionMode, permissionState.status.isGranted, state.isProcessing) {
                                        detectTapGestures(
                                            onPress = {
                                                if (state.isProcessing) return@detectTapGestures
                                                if (!permissionState.status.isGranted) {
                                                    permissionState.launchPermissionRequest()
                                                    return@detectTapGestures
                                                }
                                                if (prefs.transmissionMode == "PTT") {
                                                    recordTriggerAction()
                                                    tryAwaitRelease()
                                                    stopAndSendAction()
                                                }
                                            },
                                            onTap = {
                                                if (state.isProcessing) return@detectTapGestures
                                                if (!permissionState.status.isGranted) {
                                                    permissionState.launchPermissionRequest()
                                                } else if (prefs.transmissionMode == "TOGGLE") {
                                                    if (state.isRecording) stopAndSendAction() else recordTriggerAction()
                                                }
                                            }
                                        )
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = if (state.isRecording) "Stop" else "Talk",
                                    color = if (state.isRecording) Color.White else Color(0xFF211C16),
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                        // Round terracotta send button.
                        Box(
                            modifier = Modifier
                                .size(44.dp)
                                .clip(CircleShape)
                                .background(if (canSend) Color(0xFFC2542F) else Color(0xFFE9E3D6))
                                .clickable(enabled = canSend) { sendTextAction() },
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = "↑",
                                color = if (canSend) Color(0xFFFFFFFF) else Color(0xFF6E665A),
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                }
            }
        }
    }
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
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text(
                        text = "Slash Command Connector",
                        color = Color(0xFF211C16),
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Gateway: ${prefs.machineProfileName}",
                        color = Color(0xFF6E665A),
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = customCommand,
                            onValueChange = { customCommand = it },
                            placeholder = { Text("/sess status", color = Color(0xFF6E665A), fontSize = 12.sp) },
                            singleLine = true,
                            enabled = !isRunning,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFFC2542F),
                                unfocusedBorderColor = Color(0xFFE3DCCC),
                                focusedTextColor = Color(0xFF211C16),
                                unfocusedTextColor = Color(0xFF211C16),
                                focusedContainerColor = Color(0xFFF0ECE2),
                                unfocusedContainerColor = Color(0xFFF0ECE2)
                            ),
                            modifier = Modifier.weight(1f)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = { runCommand(customCommand) },
                            enabled = customCommand.trim().isNotEmpty() && !isRunning,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color(0xFFC2542F),
                                contentColor = Color(0xFFFFFFFF)
                            ),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text("Run", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    if (statusText.isNotBlank()) {
                        Spacer(modifier = Modifier.height(10.dp))
                        Text(
                            text = statusText,
                            color = if (statusText.startsWith("Command failed")) Color(0xFFB3261E) else Color(0xFF211C16),
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
                    CircularProgressIndicator(color = Color(0xFFC2542F))
                }
            }
        }

        items(commands, key = { it.name }) { command ->
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text(
                        text = "/${command.name}",
                        color = Color(0xFFC2542F),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace
                    )
                    if (command.description.isNotBlank()) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = command.description,
                            color = Color(0xFF211C16),
                            fontSize = 12.sp
                        )
                    }
                    if (command.usage.isNotBlank()) {
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = command.usage,
                            color = Color(0xFF6E665A),
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
                                    modifier = Modifier.weight(1f),
                                    shape = RoundedCornerShape(8.dp),
                                    border = BorderStroke(1.dp, Color(0xFFE3DCCC))
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
                                containerColor = Color(0xFFC2542F),
                                contentColor = Color.White
                            ),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("Run /${command.name}", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun SessionsTabContent(
    client: VoiceAgentClient,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
    onRemoteSessionSelected: (GatewaySessionEntry, GatewaySessionDashboard) -> Unit
) {
    var selectedPane by remember { mutableStateOf("gateway") }

    Column(
        modifier = Modifier.fillMaxSize()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { selectedPane = "gateway" },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (selectedPane == "gateway") Color(0xFF2E7D52) else Color(0xFFE9E3D6),
                    contentColor = if (selectedPane == "gateway") Color.White else Color(0xFF211C16)
                ),
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(10.dp)
            ) {
                Text("Gateway Sessions", fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Button(
                onClick = { selectedPane = "history" },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (selectedPane == "history") Color(0xFF2E7D52) else Color(0xFFE9E3D6),
                    contentColor = if (selectedPane == "history") Color.White else Color(0xFF211C16)
                ),
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(10.dp)
            ) {
                Text("Local Turn History", fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }

        if (selectedPane == "gateway") {
            GatewaySessionsPane(
                client = client,
                prefs = prefs,
                onRemoteSessionSelected = onRemoteSessionSelected,
                modifier = Modifier.weight(1f)
            )
        } else {
            LocalTurnHistoryPane(
                audioHelper = audioHelper,
                ttsHelper = ttsHelper,
                prefs = prefs,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
fun GatewaySessionsPane(
    client: VoiceAgentClient,
    prefs: AppPreferences,
    onRemoteSessionSelected: (GatewaySessionEntry, GatewaySessionDashboard) -> Unit,
    modifier: Modifier = Modifier
) {
    var state by remember { mutableStateOf<GatewaySessionsUiState>(GatewaySessionsUiState.Idle) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    fun refresh() {
        state = GatewaySessionsUiState.Loading
        scope.launch {
            state = try {
                val dashboard = client.getSessionDashboard()
                if (dashboard.sessions.isEmpty()) GatewaySessionsUiState.Empty else GatewaySessionsUiState.Loaded(dashboard)
            } catch (e: GatewaySessionException) {
                when (e.kind) {
                    GatewaySessionErrorKind.Unauthorized -> GatewaySessionsUiState.Unauthorized
                    GatewaySessionErrorKind.Unsupported -> GatewaySessionsUiState.Unsupported
                    else -> GatewaySessionsUiState.Error(e.message ?: "Could not load gateway sessions.")
                }
            } catch (e: Exception) {
                GatewaySessionsUiState.Error(e.message ?: "Could not load gateway sessions.")
            }
        }
    }

    LaunchedEffect(prefs.targetIpAddress, prefs.remoteToken) {
        refresh()
    }

    Column(modifier = modifier.fillMaxSize()) {
        GatewaySessionsHeader(
            prefs = prefs,
            state = state,
            onRefresh = { refresh() }
        )

        when (val currentState = state) {
            GatewaySessionsUiState.Idle,
            GatewaySessionsUiState.Loading -> GatewaySessionsStatus("Loading gateway sessions...")
            GatewaySessionsUiState.Empty -> GatewaySessionsStatus("No gateway sessions found.")
            GatewaySessionsUiState.Unauthorized -> GatewaySessionsStatus("Gateway token required or invalid. Check Configure.")
            GatewaySessionsUiState.Unsupported -> GatewaySessionsStatus("This gateway does not expose the session dashboard.")
            is GatewaySessionsUiState.Error -> GatewaySessionsStatus(currentState.message)
            is GatewaySessionsUiState.Loaded -> LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(bottom = 12.dp)
            ) {
                items(currentState.dashboard.sessions, key = { it.canonicalSessionPath ?: it.name }) { entry ->
                    GatewaySessionRow(
                        entry = entry,
                        dashboard = currentState.dashboard,
                        prefs = prefs,
                        onUse = {
                            onRemoteSessionSelected(entry, currentState.dashboard)
                            android.widget.Toast.makeText(
                                context,
                                if (entry.isRouteCapableIn(currentState.dashboard)) "Gateway session target selected." else "Gateway workspace selected.",
                                android.widget.Toast.LENGTH_SHORT
                            ).show()
                        },
                        onResume = if (entry.resumable) {
                            {
                                scope.launch {
                                    val message = client.resumeGatewaySession(entry)
                                    refresh()
                                    android.widget.Toast.makeText(
                                        context,
                                        message,
                                        android.widget.Toast.LENGTH_SHORT
                                    ).show()
                                }
                            }
                        } else {
                            null
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun GatewaySessionsHeader(
    prefs: AppPreferences,
    state: GatewaySessionsUiState,
    onRefresh: () -> Unit
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 10.dp),
        color = Color(0xFFFFFFFF),
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, Color(0xFFE3DCCC))
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("GATEWAY SESSIONS", color = Color(0xFFC2542F), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(4.dp))
                Text("Gateway: ${prefs.targetIpAddress.ifBlank { "not configured" }}", color = Color(0xFF211C16), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Target: ${prefs.codexSessionName}", color = Color(0xFF6E665A), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Workspace: ${prefs.workspacePath}", color = Color(0xFF6E665A), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (state is GatewaySessionsUiState.Loaded) {
                    val dashboard = state.dashboard
                    Text(
                        "Current: ${dashboard.current.ifBlank { "none" }} | Ready: ${dashboard.ready.size} | Store: ${dashboard.storePath ?: "unknown"}",
                        color = Color(0xFF6E665A),
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            OutlinedButton(
                onClick = onRefresh,
                enabled = state !is GatewaySessionsUiState.Loading,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)
            ) {
                Text("Refresh", fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
fun GatewaySessionsStatus(message: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = message,
            color = Color(0xFF6E665A),
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(24.dp)
        )
    }
}

@Composable
fun GatewaySessionRow(
    entry: GatewaySessionEntry,
    dashboard: GatewaySessionDashboard,
    prefs: AppPreferences,
    onUse: () -> Unit,
    onResume: (() -> Unit)? = null
) {
    val isRouteCapable = entry.isRouteCapableIn(dashboard)
    val isSelectedFile = prefs.selectedGatewaySessionPath.isNotBlank() && prefs.selectedGatewaySessionPath == entry.canonicalSessionPath
    val isSelectedTarget = isRouteCapable && prefs.codexSessionName == entry.name
    val borderColor = when {
        isSelectedTarget -> Color(0xFF2E7D52)
        isSelectedFile -> Color(0xFFC2542F)
        else -> Color(0xFFE3DCCC)
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Color.White,
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, borderColor)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = entry.name.ifBlank { "Unnamed session" },
                        color = Color(0xFF211C16),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(3.dp))
                    Text(
                        text = entry.displayCwd,
                        color = Color(0xFF6E665A),
                        fontSize = 12.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Text(
                    text = entry.activity ?: "saved",
                    color = if (isRouteCapable) Color(0xFF2E7D52) else Color(0xFF6E665A),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(Color(0xFFF0ECE2), RoundedCornerShape(6.dp))
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (entry.isCurrentIn(dashboard)) GatewaySessionBadge("current", Color(0xFF2E7D52))
                if (entry.isReadyIn(dashboard)) GatewaySessionBadge("ready", Color(0xFFC97E1A))
                entry.provider?.takeIf { it.isNotBlank() }?.let { GatewaySessionBadge(it, Color(0xFF3C6E71)) }
                entry.sessionId?.takeIf { it.isNotBlank() }?.let { GatewaySessionBadge("resume id", Color(0xFF6E665A)) }
                if (entry.aliases.isNotEmpty()) GatewaySessionBadge("aliases: ${entry.aliases.joinToString(", ")}", Color(0xFF6E665A))
                if (!isRouteCapable) GatewaySessionBadge("workspace only", Color(0xFF6E665A))
                if (entry.resumable) GatewaySessionBadge("resumable", Color(0xFF2E7D52))
            }

            val path = entry.canonicalSessionPath
            if (!path.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "sessionPath: $path",
                    color = Color(0xFF8A8174),
                    fontSize = 10.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            Spacer(modifier = Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onUse,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isRouteCapable) Color(0xFF2E7D52) else Color(0xFFC2542F),
                        contentColor = Color.White
                    ),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 5.dp),
                    modifier = Modifier.height(34.dp)
                ) {
                    Text(if (isRouteCapable) "Use as target" else "Use workspace", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
                if (onResume != null) {
                    OutlinedButton(
                        onClick = onResume,
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 5.dp),
                        modifier = Modifier.height(34.dp)
                    ) {
                        Text("Resume", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
fun GatewaySessionBadge(text: String, color: Color) {
    Text(
        text = text,
        color = color,
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .background(color.copy(alpha = 0.10f), RoundedCornerShape(6.dp))
            .border(1.dp, color.copy(alpha = 0.45f), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 3.dp)
    )
}

sealed interface GatewaySessionsUiState {
    data object Idle : GatewaySessionsUiState
    data object Loading : GatewaySessionsUiState
    data class Loaded(val dashboard: GatewaySessionDashboard) : GatewaySessionsUiState
    data object Empty : GatewaySessionsUiState
    data object Unauthorized : GatewaySessionsUiState
    data object Unsupported : GatewaySessionsUiState
    data class Error(val message: String) : GatewaySessionsUiState
}

fun applyGatewaySessionSelection(
    entry: GatewaySessionEntry,
    dashboard: GatewaySessionDashboard,
    prefs: AppPreferences
) {
    val cwd = entry.workingDirectory?.takeIf { it.isNotBlank() }
        ?: entry.cwd?.takeIf { it.isNotBlank() }
    prefs.selectedGatewaySessionPath = entry.canonicalSessionPath.orEmpty()
    if (!cwd.isNullOrBlank()) {
        prefs.workspacePath = cwd
    }
    if (entry.isRouteCapableIn(dashboard) && entry.name.isNotBlank()) {
        prefs.codexSessionName = entry.name
    }
}

@Composable
fun LocalTurnHistoryPane(
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
    modifier: Modifier = Modifier
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    var sessionsList by remember { mutableStateOf(prefs.getRecordedSessions()) }
    var activePlaybackId by remember { mutableStateOf<String?>(null) }

    fun refreshList() {
        sessionsList = prefs.getRecordedSessions()
    }

    if (sessionsList.isEmpty()) {
        Box(
            modifier = modifier.fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = "No local turn history yet.",
                    color = Color(0xFF6E665A),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Transmit a voice or text turn to start logging sessions.",
                    color = Color(0xFF6E665A),
                    fontSize = 12.sp
                )
            }
        }
    } else {
        LazyColumn(
            modifier = modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp)
        ) {
            items(sessionsList, key = { it.id }) { item ->
                val isPlaying = activePlaybackId == item.id
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    color = Color(0xFFFFFFFF),
                    shape = RoundedCornerShape(16.dp),
                    border = BorderStroke(1.dp, if (isPlaying) Color(0xFF2E7D52) else Color(0xFFE3DCCC))
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "SESSION TURN #${item.id.take(4).uppercase()}",
                                color = Color(0xFFC2542F),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = 0.5.sp
                            )
                            Text(
                                text = item.voiceAgent,
                                color = Color(0xFF6E665A),
                                fontSize = 10.sp
                            )
                        }

                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Prompt: \"${item.transcriptionText}\"",
                            color = Color(0xFF211C16),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium
                        )

                        Spacer(modifier = Modifier.height(4.dp))
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color(0xFFF0ECE2), RoundedCornerShape(8.dp))
                                .padding(8.dp)
                        ) {
                            Text(
                                text = item.replyText,
                                color = Color(0xFF211C16),
                                fontSize = 13.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 4,
                                overflow = TextOverflow.Ellipsis
                            )
                        }

                        Spacer(modifier = Modifier.height(12.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                // Real-time Tape Playback action
                                Button(
                                    onClick = {
                                        if (isPlaying) {
                                            audioHelper.stopPlayback()
                                            activePlaybackId = null
                                        } else {
                                            activePlaybackId = item.id
                                            audioHelper.startPlayback(item.recordingPath) {
                                                activePlaybackId = null
                                            }
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = if (isPlaying) Color(0xFFB3261E) else Color(0xFFC2542F),
                                        contentColor = if (isPlaying) Color.White else Color(0xFFFFFFFF)
                                    ),
                                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                                    modifier = Modifier.height(32.dp)
                                ) {
                                    Text(
                                        text = if (isPlaying) "Stop Tape" else "Play Tape",
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }

                                if (item.replyAudioPath != null) {
                                    Button(
                                        onClick = {
                                            if (isPlaying) {
                                                audioHelper.stopPlayback()
                                                activePlaybackId = null
                                            } else {
                                                activePlaybackId = item.id
                                                audioHelper.startPlayback(item.replyAudioPath) {
                                                    activePlaybackId = null
                                                }
                                            }
                                        },
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = Color(0xFF1B7A5A),
                                            contentColor = Color.White
                                        ),
                                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                                        modifier = Modifier.height(32.dp)
                                    ) {
                                        Text(
                                            text = "Play Synthetic Response",
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                } else {
                                    Button(
                                        onClick = {
                                            ttsHelper.speak(item.replyText)
                                        },
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = Color(0xFFC2542F),
                                            contentColor = Color.White
                                        ),
                                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                                        modifier = Modifier.height(32.dp)
                                    ) {
                                        Text(
                                            text = "Speak Reply",
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                }
                            }

                            // Copy Action
                            val clipboardManager = androidx.compose.ui.platform.LocalClipboardManager.current
                            IconButton(
                                onClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    val textToCopy = "Prompt: ${item.transcriptionText}\nReply: ${item.replyText}"
                                    clipboardManager.setText(androidx.compose.ui.text.AnnotatedString(textToCopy))
                                    android.widget.Toast.makeText(context, "Turn copied to clipboard", android.widget.Toast.LENGTH_SHORT).show()
                                },
                                modifier = Modifier.size(32.dp)
                            ) {
                                Text("📋", color = Color(0xFF6E665A), fontSize = 16.sp)
                            }
                            Spacer(modifier = Modifier.width(4.dp))

                            // Delete Action
                            IconButton(
                                onClick = {
                                    prefs.deleteRecordedSession(item.id)
                                    refreshList()
                                },
                                modifier = Modifier.size(32.dp)
                            ) {
                                Text("🗑", color = Color(0xFFB3261E), fontSize = 16.sp)
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsTabContent(
    prefs: AppPreferences,
    onConfigChanged: () -> Unit
) {
    var agentType by remember(prefs.activeAgent) { mutableStateOf(prefs.activeAgent) }
    var codexSessionName by remember(prefs.codexSessionName) { mutableStateOf(prefs.codexSessionName) }
    var machineProfileName by remember(prefs.machineProfileName) { mutableStateOf(prefs.machineProfileName) }
    var elevenLabsApiKey by remember(prefs.elevenLabsApiKey) { mutableStateOf(prefs.elevenLabsApiKey) }
    var elevenLabsVoiceId by remember(prefs.elevenLabsVoiceId) { mutableStateOf(prefs.elevenLabsVoiceId) }
    var transmissionMode by remember(prefs.transmissionMode) { mutableStateOf(prefs.transmissionMode) }
    var targetIpAddress by remember(prefs.targetIpAddress) { mutableStateOf(prefs.targetIpAddress) }
    var remoteToken by remember(prefs.remoteToken) { mutableStateOf(prefs.remoteToken) }
    var connectionMode by remember(prefs.connectionMode) { mutableStateOf(prefs.connectionMode) }
    var showTurnProgress by remember(prefs.showTurnProgress) { mutableStateOf(prefs.showTurnProgress) }
    var speakTurnProgress by remember(prefs.speakTurnProgress) { mutableStateOf(prefs.speakTurnProgress) }
    var workspaceRoot by remember(prefs.workspaceRoot) { mutableStateOf(prefs.workspaceRoot) }
    var workspacePath by remember(prefs.workspacePath) { mutableStateOf(prefs.workspacePath) }
    var workspaceEntries by remember { mutableStateOf<List<com.example.api.WorkspaceEntry>>(emptyList()) }
    var workspaceParent by remember { mutableStateOf<String?>(null) }
    var workspaceLoading by remember { mutableStateOf(false) }
    var connectionTesting by remember { mutableStateOf(false) }
    var connectionReport by remember { mutableStateOf<com.example.api.ConnectionTestReport?>(null) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    val agents = listOf("Local Codex (Pi)", "Gateway Claude (Claude Code)", "Gateway Voice (ElevenLabs)", "Gateway Gemini (Vertex AI)")

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 12.dp)
    ) {
        item {
            Text(
                text = "VOICE ENGINE CONTROL MATRIX",
                color = Color(0xFF6E665A),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
        }

        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(
                    1.dp,
                    when {
                        connectionReport?.ok == true -> Color(0xFF2E7D52)
                        connectionReport != null -> Color(0xFFC2542F)
                        else -> Color(0xFFE3DCCC)
                    }
                )
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Connection Test",
                                color = Color(0xFF211C16),
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(3.dp))
                            Text(
                                text = connectionReport?.summary ?: "Check gateway reachability, setup token, workspace, and capabilities.",
                                color = when {
                                    connectionReport?.ok == true -> Color(0xFF2E7D52)
                                    connectionReport != null -> Color(0xFFB3261E)
                                    else -> Color(0xFF6E665A)
                                },
                                fontSize = 11.sp,
                                lineHeight = 15.sp
                            )
                        }
                        Button(
                            onClick = {
                                scope.launch {
                                    connectionTesting = true
                                    connectionReport = com.example.api.VoiceAgentClient(context, prefs).testConnection()
                                    connectionTesting = false
                                }
                            },
                            enabled = !connectionTesting,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color(0xFFC2542F),
                                contentColor = Color(0xFFFFFFFF)
                            ),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text(if (connectionTesting) "Testing" else "Test", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }

                    val report = connectionReport
                    if (report != null) {
                        Spacer(modifier = Modifier.height(12.dp))
                        report.checks.forEach { check ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.Top
                            ) {
                                Box(
                                    modifier = Modifier
                                        .padding(top = 4.dp)
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(
                                            when (check.status) {
                                                "ok" -> Color(0xFF2E7D52)
                                                "warn" -> Color(0xFFC97E1A)
                                                else -> Color(0xFFC2542F)
                                            }
                                        )
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = check.label,
                                        color = Color(0xFF211C16),
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Text(
                                        text = check.detail,
                                        color = Color(0xFF6E665A),
                                        fontSize = 10.sp,
                                        lineHeight = 14.sp
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // Active Voice Agent Matrix Config
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Active Voice Agent",
                        color = Color(0xFF211C16),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    agents.forEach { agent ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(40.dp)
                                .clickable {
                                    agentType = agent
                                    prefs.activeAgent = agent
                                    onConfigChanged()
                                }
                        ) {
                            RadioButton(
                                selected = (agentType == agent),
                                onClick = {
                                    agentType = agent
                                    prefs.activeAgent = agent
                                    onConfigChanged()
                                },
                                colors = RadioButtonDefaults.colors(
                                    selectedColor = Color(0xFFC2542F),
                                    unselectedColor = Color(0xFF6E665A)
                                )
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = agent, color = Color(0xFF211C16), fontSize = 14.sp)
                        }
                    }
                }
            }
        }

        // Tactical Trigger Setup
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Microphone Action Strategy",
                        color = Color(0xFF211C16),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        listOf("PTT" to "Hold To Talk", "TOGGLE" to "Click To mic Toggle").forEach { (mode, label) ->
                            val isSelected = transmissionMode == mode
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(horizontal = 4.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(if (isSelected) Color(0xFFF4F1E9) else Color(0x22B8AF9A))
                                    .clickable {
                                        transmissionMode = mode
                                        prefs.transmissionMode = mode
                                        onConfigChanged()
                                    }
                                    .padding(vertical = 10.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = label,
                                    color = if (isSelected) Color(0xFFC2542F) else Color(0xFF6E665A),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Checkbox(
                            checked = showTurnProgress,
                            onCheckedChange = {
                                showTurnProgress = it
                                prefs.showTurnProgress = it
                                onConfigChanged()
                            }
                        )
                        Text(text = "Show turn progress text", color = Color(0xFF211C16), fontSize = 13.sp)
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Checkbox(
                            checked = speakTurnProgress,
                            onCheckedChange = {
                                speakTurnProgress = it
                                prefs.speakTurnProgress = it
                                onConfigChanged()
                            }
                        )
                        Text(text = "Speak periodic progress updates", color = Color(0xFF211C16), fontSize = 13.sp)
                    }
                }
            }
        }

        // Connection IP & Codex Session Targets Configuration
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Remote Codex Matrix Profile",
                        color = Color(0xFF211C16),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // Machine profile label
                    Text(text = "Machine Profile Name", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = machineProfileName,
                        onValueChange = {
                            machineProfileName = it
                            prefs.machineProfileName = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Session tag
                    Text(text = "Target Session Name", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = codexSessionName,
                        onValueChange = {
                            codexSessionName = it
                            prefs.codexSessionName = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Gateway IP Address
                    Text(text = "Local Gateway URL host", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = targetIpAddress,
                        onValueChange = {
                            targetIpAddress = it
                            prefs.targetIpAddress = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Text(text = "Workspace Folder", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = workspacePath,
                        onValueChange = {
                            workspacePath = it
                            prefs.workspacePath = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(workspaceRoot, color = Color(0xFF6E665A)) }
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        TextButton(
                            onClick = {
                                scope.launch {
                                    workspaceLoading = true
                                    val listing = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                        com.example.api.VoiceAgentClient(context, prefs).listWorkspace(workspaceRoot)
                                    }
                                    if (listing != null) {
                                        workspaceRoot = listing.root
                                        workspacePath = listing.current
                                        workspaceParent = listing.parent
                                        workspaceEntries = listing.entries
                                        prefs.workspaceRoot = listing.root
                                        prefs.workspacePath = listing.current
                                        onConfigChanged()
                                    }
                                    workspaceLoading = false
                                }
                            }
                        ) { Text("Browse root") }
                        TextButton(
                            enabled = workspaceParent != null,
                            onClick = {
                                val parent = workspaceParent ?: return@TextButton
                                scope.launch {
                                    workspaceLoading = true
                                    val listing = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                        com.example.api.VoiceAgentClient(context, prefs).listWorkspace(parent)
                                    }
                                    if (listing != null) {
                                        workspacePath = listing.current
                                        workspaceParent = listing.parent
                                        workspaceEntries = listing.entries
                                        prefs.workspacePath = listing.current
                                        onConfigChanged()
                                    }
                                    workspaceLoading = false
                                }
                            }
                        ) { Text("Up") }
                    }
                    if (workspaceLoading) {
                        Text(text = "Loading folders...", color = Color(0xFF6E665A), fontSize = 11.sp)
                    }
                    workspaceEntries.take(12).forEach { entry ->
                        Text(
                            text = entry.name,
                            color = Color(0xFFC2542F),
                            fontSize = 12.sp,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    scope.launch {
                                        workspaceLoading = true
                                        val listing = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                            com.example.api.VoiceAgentClient(context, prefs).listWorkspace(entry.path)
                                        }
                                        if (listing != null) {
                                            workspacePath = listing.current
                                            workspaceParent = listing.parent
                                            workspaceEntries = listing.entries
                                            prefs.workspacePath = listing.current
                                            onConfigChanged()
                                        }
                                        workspaceLoading = false
                                    }
                                }
                                .padding(vertical = 6.dp)
                        )
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Gateway Auth Token
                    Text(text = "Gateway Authentication Token", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = remoteToken,
                        onValueChange = {
                            remoteToken = it
                            prefs.remoteToken = it
                            onConfigChanged()
                        },
                        visualTransformation = PasswordVisualTransformation(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Default Gateway Network Interface
                    Text(text = "Default Gateway Network Interface", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        listOf("Tailscale" to "Tailscale", "Bluetooth" to "Bluetooth", "Manual" to "Manual").forEach { (mode, label) ->
                            val isSelected = connectionMode == mode
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(horizontal = 4.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(if (isSelected) Color(0xFFF4F1E9) else Color(0x22B8AF9A))
                                    .clickable {
                                        connectionMode = mode
                                        prefs.connectionMode = mode
                                        onConfigChanged()
                                    }
                                    .padding(vertical = 10.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = label,
                                    color = if (isSelected) Color(0xFFC2542F) else Color(0xFF6E665A),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }
                }
            }
        }

        // ElevenLabs API Security and voice synthesis wiring fields (Requested)
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "ElevenLabs API Wiring Hub",
                        color = Color(0xFF211C16),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // api key input fields (Must be masked unless requested)
                    Text(text = "ElevenLabs API Key", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = elevenLabsApiKey,
                        onValueChange = {
                            elevenLabsApiKey = it
                            prefs.elevenLabsApiKey = it
                            onConfigChanged()
                        },
                        visualTransformation = PasswordVisualTransformation(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("Unset / Local Built-In Only", color = Color(0xFF6E665A)) }
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // voice id selector input
                    Text(text = "ElevenLabs Custom Voice ID", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = elevenLabsVoiceId,
                        onValueChange = {
                            elevenLabsVoiceId = it
                            prefs.elevenLabsVoiceId = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        // Tactical Voice Synthesis Feedback Control
        item {
            var autoSpeak by remember(prefs.autoSpeakEnabled) { mutableStateOf(prefs.autoSpeakEnabled) }
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "System Voice Feedback Loop",
                        color = Color(0xFF211C16),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Auto-Speak Audio Replies",
                                color = Color(0xFF211C16),
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Spacer(modifier = Modifier.height(2.dp))
                            Text(
                                text = "Instantly synthesize incoming responses out loud via phone speakers or active synthesizer node.",
                                color = Color(0xFF6E665A),
                                fontSize = 11.sp
                            )
                        }
                        Switch(
                            checked = autoSpeak,
                            onCheckedChange = {
                                autoSpeak = it
                                prefs.autoSpeakEnabled = it
                                onConfigChanged()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Color(0xFFC2542F),
                                checkedTrackColor = Color(0xFFC2542F),
                                uncheckedThumbColor = Color(0xFF6E665A),
                                uncheckedTrackColor = Color(0xFFF4F1E9)
                            )
                        )
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
                    colors = listOf(Color(0xFFC2542F), Color(0xFFFF9E74)),
                    startY = topY,
                    endY = topY + barHeight
                )
            } else {
                androidx.compose.ui.graphics.Brush.linearGradient(
                    colors = listOf(Color(0x33C2542F), Color(0x1AC2542F))
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
            color = Color(0xFFC2542F).copy(alpha = 0.15f),
            radius = maxRadius * 0.4f,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )
        drawCircle(
            color = Color(0xFFC2542F).copy(alpha = 0.15f),
            radius = maxRadius * 0.7f,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )
        drawCircle(
            color = Color(0xFFC2542F).copy(alpha = 0.15f),
            radius = maxRadius,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )

        // Pulsating wave line
        drawCircle(
            color = Color(0xFFC2542F).copy(alpha = opacity),
            radius = maxRadius * radiusRatio,
            center = center,
            style = Stroke(width = 2.dp.toPx())
        )

        // Center beacon dot
        drawCircle(
            color = Color(0xFFC2542F),
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
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Pi Speak Server Discovery",
                            color = Color(0xFF211C16),
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = if (isScanning) "Finding Pi Speak gateways on LAN and Tailscale..." else "Discovery finds machines. Scan the setup QR once to pair.",
                            color = if (isScanning) Color(0xFFC2542F) else Color(0xFF6E665A),
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
                                containerColor = Color(0xFFC2542F),
                                contentColor = Color.White
                            ),
                            shape = RoundedCornerShape(10.dp)
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
                    text = "DETECTED PI SPEAK SERVERS",
                    color = Color(0xFF6E665A),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.8.sp
                )
                Text(
                    text = "Active Gateway: ${prefs.targetIpAddress}",
                    color = Color(0xFFC2542F),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold
                )
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
                    CircularProgressIndicator(color = Color(0xFFC2542F))
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
                        color = if (isMachineSelected) Color(0xFFFBF1EC) else Color(0xFFFFFFFF),
                        shape = RoundedCornerShape(14.dp),
                        border = BorderStroke(
                            width = 1.dp,
                            color = if (isMachineSelected) Color(0xFFC2542F) else Color(0xFFE3DCCC)
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
                                            .background(if (isOnline) Color(0xFF2E7D52) else Color(0xFF6E665A))
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = machine.name,
                                        color = if (isOnline) Color(0xFF211C16) else Color(0xFF6E665A),
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (isOnline) Color(0xFFDCEEE0) else Color(0xFFE9E3D6))
                                        .padding(horizontal = 6.dp, vertical = 2.dp)
                                ) {
                                    Text(
                                        text = if (isOnline) "${machine.latencyMs}ms" else "OFFLINE",
                                        color = if (isOnline) Color(0xFF2E7D52) else Color(0xFF6E665A),
                                        fontSize = 9.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "Endpoint: ${machine.ip}",
                                color = Color(0xFF6E665A),
                                fontSize = 11.sp
                            )
                            if (needsSetupQr) {
                                Spacer(modifier = Modifier.height(6.dp))
                                Text(
                                    text = "Setup required: scan the QR from /pk-remote on this computer.",
                                    color = Color(0xFFC2542F),
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
                                    color = Color(0xFF6E665A),
                                    fontSize = 11.sp
                                )

                                if (needsSetupQr) {
                                    Text(
                                        text = "PAIR WITH QR",
                                        color = Color(0xFFC2542F),
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
                                                    .background(Color(0xFF2E7D52)),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(
                                                    text = "✓",
                                                    color = Color.Black,
                                                    fontSize = 8.sp,
                                                    fontWeight = FontWeight.Bold
                                                )
                                            }
                                            Spacer(modifier = Modifier.width(6.dp))
                                            Text(
                                                text = "ACTIVE GATEWAY",
                                                color = Color(0xFF2E7D52),
                                                fontSize = 10.sp,
                                                fontWeight = FontWeight.Bold
                                            )
                                        }
                                    } else {
                                        Text(
                                            text = "TAP TO ROTATE GATEWAY",
                                            color = Color(0xFFC2542F),
                                            fontSize = 9.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                } else {
                                    Text(
                                        text = "HOST UNREACHABLE",
                                        color = Color(0xFFB3261E),
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
                    text = "RUNNING SESSIONS ON ${currentMachine.name.uppercase()}",
                    color = Color(0xFF6E665A),
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
                        "CODEX" -> Color(0xFF2E7D52)
                        "AGY" -> Color(0xFFC97E1A)
                        "CLAUDE" -> Color(0xFFA855F7)
                        "KIMI" -> Color(0xFF3B82F6)
                        else -> Color(0xFF6E665A)
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
                        color = if (isSessionActive) Color(0xFFDCEEE0) else Color(0xFFF0ECE2),
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(
                            width = 1.dp,
                            color = if (isSessionActive) Color(0xFF2E7D52) else Color(0xFFE3DCCC)
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
                                            .clip(RoundedCornerShape(4.dp))
                                            .background(badgeColor.copy(alpha = 0.15f))
                                            .border(1.dp, badgeColor, RoundedCornerShape(4.dp))
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
                                        color = Color(0xFF211C16),
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = session.description,
                                    color = Color(0xFF6E665A),
                                    fontSize = 11.sp
                                )
                            }

                            if (isSessionActive) {
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(Color(0xFFDCEEE0))
                                        .border(1.dp, Color(0xFF2E7D52), RoundedCornerShape(6.dp))
                                        .padding(horizontal = 8.dp, vertical = 4.dp)
                                ) {
                                    Text(
                                        text = "✓ MOUNTED",
                                        color = Color(0xFF2E7D52),
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
                                        containerColor = Color(0xFFE9E3D6),
                                        contentColor = Color(0xFF6E665A)
                                    ),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.height(28.dp)
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
                        color = Color(0xFFB3261E),
                        fontSize = 12.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}
