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
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
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
        val setup = parseSetupDeepLink(intent?.data) ?: return
        applySetupDeepLink(appPreferences, setup)
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
            DrawerRow(glyph = "≣", label = "Agent Hub", selected = activeTab == "sessions") { onSelect("sessions") }
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
private fun TerminalApprovalCard(
    approval: TerminalApprovalPrompt,
    onApprove: () -> Unit,
    onReject: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Color(0xFFFFF7ED),
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, Color(0xFFE8B56B))
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = "TERMINAL APPROVAL",
                color = Color(0xFFC2542F),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
            Text(
                text = approval.command.ifBlank { "(unknown command)" },
                color = Color(0xFF211C16),
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
                    color = Color(0xFF6E665A),
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
                    border = BorderStroke(1.dp, Color(0xFFC2542F)),
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                ) {
                    Text("Reject", color = Color(0xFFC2542F), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(modifier = Modifier.width(8.dp))
                Button(
                    onClick = onApprove,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D52)),
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                ) {
                    Text("Approve", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
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
            liveRecorderRef.value?.stop()
            liveSessionRef.value?.disconnect()
            livePlayerRef.value?.stop()
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
        val session = RealtimeVoiceSession(
            prefs = prefs,
            listener = object : RealtimeVoiceSessionListener {
                override fun onConnected(sessionId: String) {
                    player.start()
                    try {
                        recorder.start { seqId, pcm ->
                            liveSessionRef.value?.sendAudioChunk(seqId, pcm)
                            // Client-side VAD barge-in: interrupt assistant speech when the
                            // user starts talking over it (configurable in Settings).
                            if (player.isPlaying && sharedPrefs.getBoolean("vad_enabled", true)) {
                                val threshold = sharedPrefs.getFloat("vad_threshold", 1500f).toInt()
                                if (pcmPeakAmplitude(pcm) > threshold) {
                                    liveSessionRef.value?.sendInterrupt()
                                    player.stop()
                                    player.start()
                                }
                            }
                        }
                    } catch (e: Exception) {
                        scope.launch {
                            appendChat("system", "[live] Mic failed to start: ${e.message}")
                        }
                    }
                    scope.launch {
                        state.isRealtimeConnected = true
                        appendChat("system", "[live] Connected: $sessionId")
                    }
                }

                override fun onAudioChunk(seqId: Int, pcm: ByteArray) {
                    player.write(seqId, pcm)
                }

                override fun onTranscript(text: String) {
                    scope.launch { state.transcription = text }
                }

                override fun onInterrupt() {
                    player.stop()
                    player.start()
                }

                override fun onToolStart(name: String) {
                    scope.launch { appendChat("system", "[tool] $name") }
                }

                override fun onToolComplete(name: String, output: String) {
                    scope.launch { appendChat("system", "[tool done] $name: ${output.take(200)}") }
                }

                override fun onApprovalRequired(
                    approvalId: String,
                    command: String,
                    reason: String,
                    cwd: String,
                    timeoutMs: Int
                ) {
                    scope.launch {
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
                        state.pendingTerminalApprovals.removeAll { it.approvalId == approvalId }
                    }
                }

                override fun onError(message: String) {
                    scope.launch {
                        state.latestReply = "Realtime error: $message"
                        appendChat("system", "[live error] $message")
                        recorder.stop()
                        player.stop()
                        liveSessionRef.value = null
                        liveRecorderRef.value = null
                        livePlayerRef.value = null
                        state.isRealtimeActive = false
                        state.isRealtimeConnected = false
                    }
                }

                override fun onDisconnected() {
                    scope.launch {
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
                                }
                            )
                        }
                    }

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
        val quickCommands = listOf("/sess status", "/sess slots", "/skills", "/model", "/remote status", "/speak status")
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
                                        liveSessionRef.value?.sendInterrupt()
                                        livePlayerRef.value?.stop()
                                        livePlayerRef.value?.start()
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
                                        stopLiveSession()
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
                                            startLiveSession()
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
            SessionsPaneToggle("gateway", "HUB", selectedPane, Modifier.weight(1f)) { selectedPane = it }
            SessionsPaneToggle("ops", "OPS", selectedPane, Modifier.weight(1f)) { selectedPane = it }
            SessionsPaneToggle("history", "HISTORY", selectedPane, Modifier.weight(1f)) { selectedPane = it }
        }

        when (selectedPane) {
            "gateway" -> GatewaySessionsPane(
                client = client,
                prefs = prefs,
                onRemoteSessionSelected = onRemoteSessionSelected,
                modifier = Modifier.weight(1f)
            )
            "ops" -> GatewayOpsPane(
                client = client,
                prefs = prefs,
                modifier = Modifier.weight(1f)
            )
            else -> LocalTurnHistoryPane(
                audioHelper = audioHelper,
                ttsHelper = ttsHelper,
                prefs = prefs,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
private fun SessionsPaneToggle(
    pane: String,
    label: String,
    selectedPane: String,
    modifier: Modifier = Modifier,
    onSelect: (String) -> Unit
) {
    val selected = selectedPane == pane
    OutlinedButton(
        onClick = { onSelect(pane) },
        border = BorderStroke(if (selected) 2.dp else 1.dp, Color(0xFF111111)),
        modifier = modifier,
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 8.dp)
    ) {
        Text(
            if (selected) "[*] $label" else "[ ] $label",
            color = Color(0xFF111111),
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            maxLines = 1
        )
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
    var filterText by remember { mutableStateOf("") }
    var pendingRemoveKey by remember { mutableStateOf<String?>(null) }
    var launchStatus by remember { mutableStateOf("") }
    var launchingHub by remember { mutableStateOf(false) }
    var launchingColab by remember { mutableStateOf(false) }
    var joiningCollab by remember { mutableStateOf(false) }
    var showAllSessions by remember { mutableStateOf(false) }
    var selectedOmpSessionPath by remember { mutableStateOf<String?>(null) }
    val expandedLanes = remember { mutableStateMapOf<String, Boolean>() }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    fun refresh() {
        state = GatewaySessionsUiState.Loading
        pendingRemoveKey = null
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
        selectedOmpSessionPath = client.getSelectedOmpSession()
    }

    LaunchedEffect(pendingRemoveKey) {
        val key = pendingRemoveKey ?: return@LaunchedEffect
        delay(3_000)
        if (pendingRemoveKey == key) {
            pendingRemoveKey = null
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        GatewaySessionsHeader(
            prefs = prefs,
            state = state,
            filterText = filterText,
            onFilterTextChange = { filterText = it },
            launchingHub = launchingHub,
            launchingColab = launchingColab,
            joiningCollab = joiningCollab,
            onLaunchHub = {
                if (!launchingHub) {
                    launchingHub = true
                    launchStatus = "Launching OMPK hub..."
                    prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
                    scope.launch {
                        launchStatus = client.launchOmpHub()
                        launchingHub = false
                        refresh()
                    }
                }
            },
            onLaunchColab = {
                if (!launchingColab) {
                    launchingColab = true
                    launchStatus = "Launching Colab..."
                    scope.launch {
                        launchStatus = client.launchColabWorkspace(prefs.workspacePath)
                        launchingColab = false
                        refresh()
                    }
                }
            },
            onJoinCollab = {
                if (!joiningCollab) {
                    joiningCollab = true
                    launchStatus = "Checking collab..."
                    scope.launch {
                        val collab = client.getCollabLink()
                        if (collab.active && !collab.webLink.isNullOrBlank()) {
                            try {
                                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(collab.webLink)).apply {
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                                context.startActivity(intent)
                                launchStatus = "Opening collab in browser..."
                            } catch (e: Exception) {
                                launchStatus = "Couldn't open collab link: ${e.message}"
                            }
                        } else {
                            launchStatus = "No active collab. Run /collab in the OMPK hub on the host."
                        }
                        joiningCollab = false
                    }
                }
            },
            onRefresh = { refresh() },
            showAllSessions = showAllSessions,
            onToggleShowAll = { showAllSessions = !showAllSessions }
        )
        if (launchStatus.isNotBlank()) {
            Text(
                text = launchStatus,
                color = Color(0xFF111111),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 4.dp, end = 4.dp, bottom = 8.dp)
            )
        }

        when (val currentState = state) {
            GatewaySessionsUiState.Idle,
            GatewaySessionsUiState.Loading -> GatewaySessionsStatus("Loading gateway sessions...")
            GatewaySessionsUiState.Empty -> GatewaySessionsStatus("No gateway sessions found.")
            GatewaySessionsUiState.Unauthorized -> GatewaySessionsStatus("Gateway token required or invalid. Check Configure.")
            GatewaySessionsUiState.Unsupported -> GatewaySessionsStatus("This gateway does not expose the session dashboard.")
            is GatewaySessionsUiState.Error -> GatewaySessionsStatus(currentState.message)
            is GatewaySessionsUiState.Loaded -> {
                val groups = buildGatewayAgentHubGroups(
                    dashboard = currentState.dashboard,
                    currentWorkspace = prefs.workspacePath,
                    query = filterText,
                    ompOnly = !showAllSessions
                )
                if (groups.isEmpty()) {
                    GatewaySessionsStatus(
                        when {
                            filterText.isNotBlank() -> "No sessions match \"$filterText\"."
                            showAllSessions -> "No gateway sessions found."
                            else -> "No oh-my-pk background lanes found."
                        }
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        contentPadding = PaddingValues(bottom = 12.dp)
                    ) {
                        groups.forEach { group ->
                            item(key = "folder:${group.key}") {
                                GatewayAgentHubFolderHeader(group)
                            }
                            items(
                                group.sessions,
                                key = { entry -> "${group.key}:${gatewaySessionKey(entry)}" }
                            ) { entry ->
                                val laneKey = gatewaySessionKey(entry)
                                val defaultExpanded = entry.isCurrentIn(currentState.dashboard)
                                val expanded = expandedLanes[laneKey] ?: defaultExpanded
                                GatewaySessionRow(
                                    entry = entry,
                                    dashboard = currentState.dashboard,
                                    prefs = prefs,
                                    expanded = expanded,
                                    pendingRemove = pendingRemoveKey == laneKey,
                                    selectedOmpSessionPath = selectedOmpSessionPath,
                                    onToggleExpanded = {
                                        expandedLanes[laneKey] = !expanded
                                    },
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
                                                onRemoteSessionSelected(entry, currentState.dashboard)
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
                                    },
                                    onRemove = if (!entry.canonicalSessionPath.isNullOrBlank()) {
                                        {
                                            if (pendingRemoveKey == laneKey) {
                                                scope.launch {
                                                    val message = client.removeGatewaySession(entry)
                                                    pendingRemoveKey = null
                                                    refresh()
                                                    android.widget.Toast.makeText(
                                                        context,
                                                        message,
                                                        android.widget.Toast.LENGTH_SHORT
                                                    ).show()
                                                }
                                            } else {
                                                pendingRemoveKey = laneKey
                                                android.widget.Toast.makeText(
                                                    context,
                                                    "Tap Remove again to remove this lane.",
                                                    android.widget.Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    } else {
                                        null
                                    },
                                    onRouteOmpSession = gatewaySessionOmpRoutePath(entry)?.let {
                                        { sessionPath ->
                                            scope.launch {
                                                val message = client.selectOmpSession(sessionPath)
                                                selectedOmpSessionPath = sessionPath
                                                prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
                                                onRemoteSessionSelected(entry, currentState.dashboard)
                                                launchStatus = message
                                                refresh()
                                                android.widget.Toast.makeText(
                                                    context,
                                                    message,
                                                    android.widget.Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    },
                                    onRename = entry.canonicalSessionPath?.let { sessionPath ->
                                        { newName ->
                                            scope.launch {
                                                val message = client.renameGatewaySession(sessionPath, newName)
                                                refresh()
                                                android.widget.Toast.makeText(
                                                    context,
                                                    message,
                                                    android.widget.Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    },
                                    onAlias = entry.canonicalSessionPath?.let { sessionPath ->
                                        { alias ->
                                            scope.launch {
                                                val message = client.aliasGatewaySession(sessionPath, alias)
                                                refresh()
                                                android.widget.Toast.makeText(
                                                    context,
                                                    message,
                                                    android.widget.Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    },
                                    onArchive = entry.canonicalSessionPath?.let { sessionPath ->
                                        {
                                            scope.launch {
                                                val message = client.archiveGatewaySession(sessionPath)
                                                refresh()
                                                android.widget.Toast.makeText(
                                                    context,
                                                    message,
                                                    android.widget.Toast.LENGTH_SHORT
                                                ).show()
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
}

@Composable
fun GatewaySessionsHeader(
    prefs: AppPreferences,
    state: GatewaySessionsUiState,
    filterText: String,
    onFilterTextChange: (String) -> Unit,
    launchingHub: Boolean,
    launchingColab: Boolean,
    joiningCollab: Boolean,
    onLaunchHub: () -> Unit,
    onLaunchColab: () -> Unit,
    onJoinCollab: () -> Unit,
    onRefresh: () -> Unit,
    showAllSessions: Boolean = false,
    onToggleShowAll: (() -> Unit)? = null
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 10.dp)
            .border(1.dp, Color(0xFFB8B8B8), RoundedCornerShape(4.dp))
            .background(Color.White, RoundedCornerShape(4.dp))
            .padding(10.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("OMPK AGENT HUB", color = Color(0xFF111111), fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Spacer(modifier = Modifier.height(3.dp))
                Text(
                    "Persistent oh-my-pk sessions on the host. Route voice/text turns into a lane or launch a new hub.",
                    color = Color(0xFF555555),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    lineHeight = 14.sp
                )
                Spacer(modifier = Modifier.height(5.dp))
                Text("Gateway: ${prefs.targetIpAddress.ifBlank { "(no gateway)" }}", color = Color(0xFF111111), fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Target: ${prefs.codexSessionName.ifBlank { "default" }}", color = Color(0xFF111111), fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Workspace: ${prefs.workspacePath}", color = Color(0xFF555555), fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (state is GatewaySessionsUiState.Loaded) {
                    val dashboard = state.dashboard
                    val ompLaneCount = dashboard.sessions.count { gatewaySessionIsOmpLane(it) }
                    Text(
                        "Current: ${dashboard.current.ifBlank { "none" }} | Ready: ${dashboard.ready.size} | OMPK lanes: $ompLaneCount",
                        color = Color(0xFF555555),
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            OutlinedButton(
                onClick = onRefresh,
                enabled = state !is GatewaySessionsUiState.Loading,
                border = BorderStroke(1.dp, Color(0xFF111111)),
                shape = RoundedCornerShape(4.dp),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 7.dp)
            ) {
                Text("REFRESH", color = Color(0xFF111111), fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            }
        }
        Spacer(modifier = Modifier.height(8.dp))
        GatewayHubCommandButton(
            text = if (launchingHub) "LAUNCHING..." else "LAUNCH OMPK HUB",
            enabled = !launchingHub,
            onClick = onLaunchHub
        )
        Spacer(modifier = Modifier.height(6.dp))
        GatewayHubCommandButton(
            text = if (launchingColab) "LAUNCHING..." else "LAUNCH COLAB",
            enabled = !launchingColab,
            onClick = onLaunchColab
        )
        Spacer(modifier = Modifier.height(6.dp))
        GatewayHubCommandButton(
            text = if (joiningCollab) "JOINING..." else "JOIN COLLAB",
            enabled = !joiningCollab,
            onClick = onJoinCollab
        )
        if (onToggleShowAll != null) {
            Spacer(modifier = Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = { if (showAllSessions) onToggleShowAll() },
                    border = BorderStroke(if (!showAllSessions) 2.dp else 1.dp, Color(0xFF111111)),
                    shape = RoundedCornerShape(4.dp),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Text(
                        if (!showAllSessions) "[*] OMPK LANES" else "[ ] OMPK LANES",
                        color = Color(0xFF111111),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace
                    )
                }
                OutlinedButton(
                    onClick = { if (!showAllSessions) onToggleShowAll() },
                    border = BorderStroke(if (showAllSessions) 2.dp else 1.dp, Color(0xFF111111)),
                    shape = RoundedCornerShape(4.dp),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Text(
                        if (showAllSessions) "[*] ALL SESSIONS" else "[ ] ALL SESSIONS",
                        color = Color(0xFF111111),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(10.dp))
        OutlinedTextField(
            value = filterText,
            onValueChange = onFilterTextChange,
            modifier = Modifier.fillMaxWidth(),
            leadingIcon = {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = Color(0xFF555555)
                )
            },
            placeholder = { Text("Filter sessions, paths, aliases", fontSize = 12.sp, fontFamily = FontFamily.Monospace) },
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontSize = 12.sp, color = Color(0xFF111111), fontFamily = FontFamily.Monospace),
            shape = RoundedCornerShape(4.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Color(0xFF111111),
                unfocusedBorderColor = Color(0xFFB8B8B8),
                cursorColor = Color(0xFF111111),
                focusedTextColor = Color(0xFF111111),
                unfocusedTextColor = Color(0xFF111111)
            )
        )
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
fun GatewayOpsPane(
    client: VoiceAgentClient,
    prefs: AppPreferences,
    modifier: Modifier = Modifier
) {
    var route by remember { mutableStateOf<com.example.api.GatewayRoute?>(null) }
    var slots by remember { mutableStateOf<List<com.example.api.GatewayRouteSlot>>(emptyList()) }
    var inventory by remember { mutableStateOf<com.example.api.AgentInventory?>(null) }
    var opsStatus by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    val events = remember { mutableStateListOf<com.example.api.GatewayEvent>() }
    var eventStreamConnected by remember { mutableStateOf(false) }
    var eventStreamDetail by remember { mutableStateOf("Connecting…") }
    val scope = rememberCoroutineScope()

    fun refresh() {
        if (loading) return
        loading = true
        scope.launch {
            try {
                route = client.getRoute()
                slots = client.getRouteSlots() ?: emptyList()
                inventory = client.getAgentInventory()
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(prefs.targetIpAddress, prefs.remoteToken) { refresh() }

    DisposableEffect(prefs.targetIpAddress, prefs.remoteToken) {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val stream = client.openEventStream(
            onEvent = { event ->
                handler.post {
                    events.add(0, event)
                    while (events.size > 100) events.removeAt(events.size - 1)
                }
            },
            onStateChange = { connected, detail ->
                handler.post {
                    eventStreamConnected = connected
                    eventStreamDetail = detail
                }
            }
        )
        onDispose { stream.stop() }
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(bottom = 12.dp)
    ) {
        item(key = "ops-routing") {
            GatewayOpsCard(title = "ROUTING", trailing = {
                OutlinedButton(
                    onClick = { refresh() },
                    enabled = !loading,
                    border = BorderStroke(1.dp, Color(0xFF111111)),
                    shape = RoundedCornerShape(4.dp),
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp)
                ) {
                    Text("REFRESH", color = Color(0xFF111111), fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                }
            }) {
                val currentRoute = route
                if (currentRoute == null) {
                    GatewayOpsMutedLine(if (loading) "Loading route…" else "Route status unavailable on this gateway.")
                } else {
                    GatewayOpsMutedLine("Default target: ${currentRoute.defaultTarget ?: "current session"}")
                    GatewayOpsMutedLine("Current session: ${currentRoute.currentSession ?: "unknown"}")
                    Spacer(modifier = Modifier.height(6.dp))
                    if (currentRoute.availableTargets.isEmpty()) {
                        GatewayOpsMutedLine("No named targets available.")
                    } else {
                        currentRoute.availableTargets.forEach { target ->
                            val active = target == currentRoute.defaultTarget || (currentRoute.defaultTarget == null && target == currentRoute.currentSession)
                            Text(
                                text = "${if (active) "[*]" else "[ ]"} $target",
                                color = Color(0xFF111111),
                                fontSize = 12.sp,
                                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(3.dp))
                                    .clickable {
                                        scope.launch {
                                            val update = client.setRoute(target)
                                            opsStatus = update.message
                                            update.route?.let { route = it }
                                            applyGatewayRouteUpdateToPrefs(update, target, prefs)
                                        }
                                    }
                                    .padding(horizontal = 4.dp, vertical = 7.dp)
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(6.dp))
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                val update = client.setRoute("")
                                opsStatus = update.message
                                update.route?.let { route = it }
                                applyGatewayRouteUpdateToPrefs(update, "", prefs)
                            }
                        },
                        border = BorderStroke(1.dp, Color(0xFF111111)),
                        shape = RoundedCornerShape(4.dp),
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("USE CURRENT SESSION", color = Color(0xFF111111), fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    }
                }
                if (opsStatus.isNotBlank()) {
                    Spacer(modifier = Modifier.height(4.dp))
                    GatewayOpsMutedLine(opsStatus)
                }
            }
        }

        item(key = "ops-slots") {
            GatewayOpsCard(title = "ROUTE SLOTS") {
                if (slots.isEmpty()) {
                    GatewayOpsMutedLine(if (loading) "Loading slots…" else "No compact route slots reported.")
                } else {
                    slots.forEach { slot ->
                        val detail = when (slot.status) {
                            "mapped" -> slot.sessionName ?: "unknown"
                            "ambiguous" -> "ambiguous: ${slot.labels.joinToString(", ")}"
                            else -> "unassigned"
                        }
                        Text(
                            text = "PK${slot.family} → $detail",
                            color = Color(0xFF111111),
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(vertical = 3.dp)
                        )
                        if (slot.status == "mapped" && slot.labels.isNotEmpty()) {
                            GatewayOpsMutedLine("say: ${slot.labels.joinToString(", ")}")
                        }
                    }
                }
            }
        }

        item(key = "ops-agents") {
            GatewayOpsCard(title = "DISCOVERED AGENTS") {
                val agentInventory = inventory
                if (agentInventory == null) {
                    GatewayOpsMutedLine(if (loading) "Scanning agents…" else "Agent discovery unavailable on this gateway.")
                } else {
                    if (agentInventory.running.isEmpty() && agentInventory.recent.isEmpty()) {
                        GatewayOpsMutedLine("No running or recent agents found on the host.")
                    }
                    if (agentInventory.running.isNotEmpty()) {
                        GatewayOpsMutedLine("RUNNING — tap to target")
                        agentInventory.running.forEach { agent ->
                            GatewayOpsRow(
                                title = agent.target,
                                subtitle = listOfNotNull(agent.provider, agent.cwd ?: agent.cwdBasename).joinToString(" | "),
                                onClick = {
                                    scope.launch {
                                        val update = client.setRoute(agent.target)
                                        opsStatus = update.message
                                        update.route?.let { route = it }
                                        applyGatewayRouteUpdateToPrefs(update, agent.target, prefs)
                                    }
                                }
                            )
                        }
                    }
                    if (agentInventory.recent.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(6.dp))
                        GatewayOpsMutedLine("RECENT SESSIONS — tap to mount workspace")
                        agentInventory.recent.take(10).forEach { session ->
                            GatewayOpsRow(
                                title = session.title ?: session.path.substringAfterLast('/').substringAfterLast('\\'),
                                subtitle = listOfNotNull(session.provider, session.cwd ?: session.cwdBasename).joinToString(" | "),
                                onClick = {
                                    val cwd = session.cwd
                                    if (!cwd.isNullOrBlank()) {
                                        prefs.workspacePath = cwd
                                        opsStatus = "Workspace mounted: $cwd"
                                    } else {
                                        opsStatus = "Session has no recorded workspace."
                                    }
                                }
                            )
                        }
                    }
                }
            }
        }

        item(key = "ops-events") {
            GatewayOpsCard(title = "EVENTS", trailing = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (eventStreamConnected) Color(0xFF22C55E) else Color(0xFFC97E1A))
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        eventStreamDetail,
                        color = Color(0xFF555555),
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }) {
                if (events.isEmpty()) {
                    GatewayOpsMutedLine("No session events yet. Voice and admin actions on the host appear here live.")
                } else {
                    events.forEach { event ->
                        val time = if (event.ts > 0L) {
                            java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(event.ts))
                        } else {
                            "--:--:--"
                        }
                        Column(modifier = Modifier.padding(vertical = 3.dp)) {
                            Text(
                                text = "$time ${event.source}/${event.kind}",
                                color = Color(0xFF111111),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            if (event.summary.isNotBlank()) {
                                Text(
                                    text = event.summary,
                                    color = Color(0xFF555555),
                                    fontSize = 10.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GatewayOpsCard(
    title: String,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Color(0xFFB8B8B8), RoundedCornerShape(4.dp))
            .background(Color.White, RoundedCornerShape(4.dp))
            .padding(10.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(title, color = Color(0xFF111111), fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            trailing?.invoke()
        }
        Spacer(modifier = Modifier.height(6.dp))
        content()
    }
}

@Composable
private fun GatewayOpsMutedLine(text: String) {
    Text(
        text = text,
        color = Color(0xFF555555),
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
        lineHeight = 14.sp,
        modifier = Modifier.padding(vertical = 1.dp)
    )
}

@Composable
private fun GatewayOpsRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(3.dp))
            .clickable { onClick() }
            .padding(horizontal = 4.dp, vertical = 6.dp)
    ) {
        Text(
            text = title,
            color = Color(0xFF111111),
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        if (subtitle.isNotBlank()) {
            Text(
                text = subtitle,
                color = Color(0xFF555555),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
fun GatewayHubCommandButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp),
        border = BorderStroke(1.dp, Color(0xFF111111)),
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = Color(0xFF111111),
            disabledContentColor = Color(0xFF555555)
        )
    ) {
        Text(
            text,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace
        )
    }
}

@Composable
fun GatewaySessionRow(
    entry: GatewaySessionEntry,
    dashboard: GatewaySessionDashboard,
    prefs: AppPreferences,
    expanded: Boolean,
    pendingRemove: Boolean,
    selectedOmpSessionPath: String?,
    onToggleExpanded: () -> Unit,
    onUse: () -> Unit,
    onResume: (() -> Unit)? = null,
    onRemove: (() -> Unit)? = null,
    onRouteOmpSession: ((String) -> Unit)? = null,
    onRename: ((String) -> Unit)? = null,
    onAlias: ((String) -> Unit)? = null,
    onArchive: (() -> Unit)? = null
) {
    val isRouteCapable = entry.isRouteCapableIn(dashboard)
    val isSelectedFile = prefs.selectedGatewaySessionPath.isNotBlank() && prefs.selectedGatewaySessionPath == entry.canonicalSessionPath
    val isSelectedTarget = isRouteCapable && prefs.codexSessionName == entry.name
    val isCurrent = entry.isCurrentIn(dashboard)
    val isReady = entry.isReadyIn(dashboard)
    val statusText = gatewaySessionStatusText(entry, dashboard)
    val statusGlyph = when {
        isCurrent -> "[+]"
        isReady -> "[+]"
        entry.activity.equals("busy", ignoreCase = true) -> "[*]"
        entry.activity.equals("idle", ignoreCase = true) -> "[~]"
        entry.activity.isNullOrBlank() -> "[ ]"
        else -> "[!]"
    }
    val statusBorderWeight = if (isCurrent || isReady) 2.dp else 1.dp
    val borderColor = when {
        isSelectedTarget || isSelectedFile || isReady || isCurrent -> Color(0xFF111111)
        else -> Color(0xFFE2E2E2)
    }
    val ompRoutePath = gatewaySessionOmpRoutePath(entry)
    val isOmpRouteSelected = !ompRoutePath.isNullOrBlank() && ompRoutePath == selectedOmpSessionPath

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = if (isOmpRouteSelected) Color(0xFFE8E8E8) else Color.White,
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(if (isOmpRouteSelected || isSelectedTarget || isSelectedFile) 2.dp else 1.dp, borderColor)
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onToggleExpanded() },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                    contentDescription = if (expanded) "Collapse session lane" else "Expand session lane",
                    tint = Color(0xFF555555),
                    modifier = Modifier.size(22.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = entry.name.ifBlank { "Unnamed session" },
                        color = Color(0xFF111111),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(3.dp))
                    Text(
                        text = gatewaySessionSubtitle(entry, dashboard),
                        color = Color(0xFF555555),
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Text(
                    text = "$statusGlyph $statusText",
                    color = Color(0xFF111111),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .border(statusBorderWeight, Color(0xFF111111), RoundedCornerShape(2.dp))
                        .padding(horizontal = 4.dp, vertical = 1.dp)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (isCurrent) item { GatewaySessionBadge("current", Color(0xFF2E7D52)) }
                if (isReady) item { GatewaySessionBadge("ready", Color(0xFFC97E1A)) }
                item { GatewaySessionBadge(if (isCurrent) "current session" else "background lane", Color(0xFF3C6E71)) }
                gatewaySessionSourceLabel(entry)?.let { source ->
                    item { GatewaySessionBadge(source, Color(0xFF3C6E71)) }
                }
                entry.provider?.takeIf { it.isNotBlank() }?.let { provider ->
                    item { GatewaySessionBadge(provider, Color(0xFF3C6E71)) }
                }
                entry.model?.takeIf { it.isNotBlank() }?.let { model ->
                    item { GatewaySessionBadge(model, Color(0xFF6E665A)) }
                }
                entry.role?.takeIf { it.isNotBlank() }?.let { role ->
                    item { GatewaySessionBadge(role, Color(0xFF6E665A)) }
                }
                if (entry.aliases.isNotEmpty()) {
                    item { GatewaySessionBadge("aliases: ${entry.aliases.joinToString(", ")}", Color(0xFF6E665A)) }
                }
                if (entry.subagents.isNotEmpty()) {
                    item { GatewaySessionBadge("${entry.subagents.size} subagents", Color(0xFFC97E1A)) }
                }
                if (!isRouteCapable) item { GatewaySessionBadge("workspace only", Color(0xFF6E665A)) }
                if (entry.resumable) item { GatewaySessionBadge("resumable", Color(0xFF2E7D52)) }
                if (entry.stale) item { GatewaySessionBadge("stale", Color(0xFF6E665A)) }
            }

            if (!ompRoutePath.isNullOrBlank() && onRouteOmpSession != null) {
                Spacer(modifier = Modifier.height(6.dp))
                OutlinedButton(
                    onClick = { onRouteOmpSession(ompRoutePath) },
                    border = BorderStroke(if (isOmpRouteSelected) 2.dp else 1.dp, Color(0xFF111111)),
                    shape = RoundedCornerShape(3.dp),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = if (isOmpRouteSelected) "[*] ROUTING TURNS HERE" else "[ ] ROUTE TURNS HERE",
                        color = Color(0xFF111111),
                        fontSize = 11.sp,
                        fontWeight = if (isOmpRouteSelected) FontWeight.Bold else FontWeight.Normal,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }

            AnimatedVisibility(visible = expanded) {
                Column {
                    Spacer(modifier = Modifier.height(10.dp))
                    GatewaySessionDetailLine("Workspace", entry.displayCwd)
                    entry.sessionId?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Resume id", it)
                    }
                    entry.canonicalSessionPath?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Session file", it)
                    }
                    if (entry.aliases.isNotEmpty()) {
                        GatewaySessionDetailLine("Voice aliases", entry.aliases.joinToString(", "))
                    }
                    entry.source?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Source", it)
                    }
                    entry.model?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Model", it)
                    }
                    entry.role?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Role", it)
                    }
                    if (entry.subagents.isNotEmpty()) {
                        GatewaySessionDetailLine(
                            "Subagents",
                            entry.subagents.joinToString(", ") { subagent -> subagent.name.ifBlank { subagent.id } }
                        )
                    }
                    if (entry.resumeCommand.isNotEmpty()) {
                        GatewaySessionDetailLine("Resume command", entry.resumeCommand.joinToString(" "))
                    }

                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Button(
                            onClick = onResume ?: onUse,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color(0xFF111111),
                                contentColor = Color.White
                            ),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 5.dp),
                            modifier = Modifier.height(34.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Filled.PlayArrow,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(if (onResume != null) "Resume" else if (isRouteCapable) "Focus" else "Workspace", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                        OutlinedButton(
                            onClick = onUse,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 5.dp),
                            modifier = Modifier.height(34.dp),
                            border = BorderStroke(1.dp, Color(0xFF111111))
                        ) {
                            Text(
                                if (isRouteCapable) "Target" else "Mount",
                                color = Color(0xFF111111),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        if (onArchive != null) {
                            OutlinedButton(
                                onClick = onArchive,
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                modifier = Modifier.height(34.dp),
                                border = BorderStroke(1.dp, Color(0xFF111111))
                            ) {
                                Text("Archive", color = Color(0xFF111111), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                        if (onRemove != null) {
                            OutlinedButton(
                                onClick = onRemove,
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                modifier = Modifier.height(34.dp),
                                colors = ButtonDefaults.outlinedButtonColors(
                                    contentColor = Color(0xFF111111)
                                ),
                                border = BorderStroke(if (pendingRemove) 2.dp else 1.dp, Color(0xFF111111))
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Delete,
                                    contentDescription = null,
                                    modifier = Modifier.size(15.dp)
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Text(if (pendingRemove) "Confirm" else "Remove", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }

                    if (onRename != null || onAlias != null) {
                        Spacer(modifier = Modifier.height(10.dp))
                        var manageText by remember(gatewaySessionKey(entry)) { mutableStateOf("") }
                        OutlinedTextField(
                            value = manageText,
                            onValueChange = { manageText = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = { Text("New name or wake alias", fontSize = 11.sp, fontFamily = FontFamily.Monospace) },
                            singleLine = true,
                            textStyle = LocalTextStyle.current.copy(fontSize = 12.sp, color = Color(0xFF111111), fontFamily = FontFamily.Monospace),
                            shape = RoundedCornerShape(4.dp),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFF111111),
                                unfocusedBorderColor = Color(0xFFB8B8B8),
                                cursorColor = Color(0xFF111111),
                                focusedTextColor = Color(0xFF111111),
                                unfocusedTextColor = Color(0xFF111111)
                            )
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (onRename != null) {
                                OutlinedButton(
                                    onClick = {
                                        val value = manageText.trim()
                                        if (value.isNotEmpty()) {
                                            onRename(value)
                                            manageText = ""
                                        }
                                    },
                                    enabled = manageText.isNotBlank(),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                    modifier = Modifier.height(34.dp),
                                    border = BorderStroke(1.dp, Color(0xFF111111))
                                ) {
                                    Text("Rename", color = Color(0xFF111111), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                            if (onAlias != null) {
                                OutlinedButton(
                                    onClick = {
                                        val value = manageText.trim()
                                        if (value.isNotEmpty()) {
                                            onAlias(value)
                                            manageText = ""
                                        }
                                    },
                                    enabled = manageText.isNotBlank(),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                    modifier = Modifier.height(34.dp),
                                    border = BorderStroke(1.dp, Color(0xFF111111))
                                ) {
                                    Text("Add alias", color = Color(0xFF111111), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun GatewayAgentHubFolderHeader(group: GatewayAgentHubGroup) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp, bottom = 2.dp, start = 2.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = group.label,
                    color = Color(0xFF111111),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (group.isCurrentWorkspace) {
                    Spacer(modifier = Modifier.width(6.dp))
                    GatewaySessionBadge("current folder", Color(0xFF2E7D52))
                }
            }
            Text(
                text = group.cwd.ifBlank { "unknown workspace" },
                color = Color(0xFF555555),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Text(
            text = "${group.sessions.size} ${if (group.sessions.size == 1) "lane" else "lanes"}",
            color = Color(0xFF111111),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace
        )
    }
}

@Composable
fun GatewaySessionDetailLine(label: String, value: String) {
    if (value.isBlank()) return
    Column(modifier = Modifier.padding(bottom = 6.dp)) {
        Text(
            text = label.uppercase(),
            color = Color(0xFF111111),
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace
        )
        Text(
            text = value,
            color = Color(0xFF555555),
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

data class GatewayAgentHubGroup(
    val key: String,
    val label: String,
    val cwd: String,
    val isCurrentWorkspace: Boolean,
    val sessions: List<GatewaySessionEntry>
)

fun buildGatewayAgentHubGroups(
    dashboard: GatewaySessionDashboard,
    currentWorkspace: String,
    query: String,
    ompOnly: Boolean = true
): List<GatewayAgentHubGroup> {
    val normalizedQuery = query.trim().lowercase()
    val visibleSessions = dashboard.sessions
        .filter { entry -> !ompOnly || gatewaySessionIsOmpLane(entry) }
        .filter { entry -> normalizedQuery.isBlank() || gatewaySessionMatches(entry, dashboard, normalizedQuery) }
    val currentKey = gatewayFolderKey(currentWorkspace)
    return visibleSessions
        .groupBy { gatewayFolderKey(it.displayCwd) }
        .map { (key, entries) ->
            val cwd = entries.firstOrNull()?.displayCwd.orEmpty()
            GatewayAgentHubGroup(
                key = key,
                label = gatewayFolderLabel(cwd),
                cwd = cwd,
                isCurrentWorkspace = key == currentKey,
                sessions = entries.sortedWith(
                    compareByDescending<GatewaySessionEntry> { it.isCurrentIn(dashboard) }
                        .thenByDescending { it.isReadyIn(dashboard) }
                        .thenByDescending { it.resumable }
                        .thenBy { it.name.lowercase() }
                )
            )
        }
        .sortedWith(
            compareByDescending<GatewayAgentHubGroup> { it.isCurrentWorkspace }
                .thenByDescending { group -> group.sessions.any { it.isCurrentIn(dashboard) || it.isReadyIn(dashboard) } }
                .thenBy { it.label.lowercase() }
        )
}

fun gatewaySessionKey(entry: GatewaySessionEntry): String =
    entry.canonicalSessionPath?.takeIf { it.isNotBlank() }
        ?: entry.sessionId?.takeIf { it.isNotBlank() }
        ?: entry.name.ifBlank { "session-${entry.hashCode()}" }

fun gatewaySessionIsOmpLane(entry: GatewaySessionEntry): Boolean =
    entry.source.equals("oh-my-pk", ignoreCase = true) ||
        entry.source.equals("oh-my-pi", ignoreCase = true) ||
        entry.kind.equals("background", ignoreCase = true) ||
        entry.provider.equals("oh-my-pk", ignoreCase = true) ||
        entry.provider.equals("oh-my-pi", ignoreCase = true)

fun gatewaySessionOmpRoutePath(entry: GatewaySessionEntry): String? {
    if (!gatewaySessionIsOmpLane(entry)) return null
    return entry.canonicalSessionPath?.takeIf { it.isNotBlank() }
}

fun gatewaySessionMatches(entry: GatewaySessionEntry, dashboard: GatewaySessionDashboard, query: String): Boolean {
    val fields = listOfNotNull(
        entry.name,
        entry.displayCwd,
        entry.activity,
        entry.provider,
        entry.source,
        entry.model,
        entry.role,
        entry.sessionId,
        entry.canonicalSessionPath,
        gatewaySessionStatusText(entry, dashboard),
        entry.aliases.joinToString(" "),
        entry.subagents.joinToString(" ") { subagent ->
            listOfNotNull(subagent.name, subagent.status, subagent.activity, subagent.sessionPath).joinToString(" ")
        }
    )
    return fields.any { it.lowercase().contains(query) }
}

fun gatewayFolderKey(cwd: String): String =
    cwd.trim().replace('\\', '/').trimEnd('/').lowercase().ifBlank { "unknown" }

fun gatewayFolderLabel(cwd: String): String {
    val normalized = cwd.trim().replace('\\', '/').trimEnd('/')
    return normalized.substringAfterLast('/').ifBlank { normalized.ifBlank { "Unknown workspace" } }
}

fun gatewaySessionStatusText(entry: GatewaySessionEntry, dashboard: GatewaySessionDashboard): String = when {
    entry.isCurrentIn(dashboard) -> "current"
    entry.isReadyIn(dashboard) -> "ready"
    entry.activity.equals("busy", ignoreCase = true) -> "running"
    gatewaySessionIsOmpLane(entry) -> "parked"
    entry.resumable -> "parked"
    else -> entry.activity ?: "saved"
}

fun gatewaySessionSubtitle(entry: GatewaySessionEntry, dashboard: GatewaySessionDashboard): String {
    val kind = when {
        entry.isCurrentIn(dashboard) -> "current session"
        gatewaySessionIsOmpLane(entry) -> "background agent"
        else -> "background session"
    }
    val cwd = gatewayFolderLabel(entry.displayCwd)
    val provider = entry.provider?.takeIf { it.isNotBlank() }
    val source = gatewaySessionSourceLabel(entry)
    val model = entry.model?.takeIf { it.isNotBlank() }
    val role = entry.role?.takeIf { it.isNotBlank() }
    return listOfNotNull(kind, source, provider, model, role, cwd).distinct().joinToString(" | ")
}

fun gatewaySessionSourceLabel(entry: GatewaySessionEntry): String? = when (entry.source) {
    "oh-my-pk" -> "Oh-my-pk"
    "oh-my-pi" -> "Oh-my-pk"
    else -> entry.source?.takeIf { it.isNotBlank() }
}

@Composable
fun GatewaySessionBadge(text: String, color: Color) {
    val borderWidth = when (color) {
        Color(0xFF2E7D52), Color(0xFFC97E1A) -> 2.dp
        else -> 1.dp
    }
    Text(
        text = text,
        color = Color(0xFF111111),
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .border(borderWidth, Color(0xFFB8B8B8), RoundedCornerShape(2.dp))
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

fun applyGatewayRouteUpdateToPrefs(
    update: GatewayRouteUpdate,
    requestedTarget: String,
    prefs: AppPreferences
) {
    if (!update.ok) return
    val nextTarget = update.route?.defaultTarget?.takeIf { it.isNotBlank() }
        ?: update.route?.currentSession?.takeIf { it.isNotBlank() }
        ?: requestedTarget.takeIf { it.isNotBlank() }
        ?: return
    prefs.codexSessionName = nextTarget
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
    var agentModel by remember(prefs.agentModel) { mutableStateOf(prefs.agentModel) }
    var showTurnProgress by remember(prefs.showTurnProgress) { mutableStateOf(prefs.showTurnProgress) }
    var speakTurnProgress by remember(prefs.speakTurnProgress) { mutableStateOf(prefs.speakTurnProgress) }
    var workspaceRoot by remember(prefs.workspaceRoot) { mutableStateOf(prefs.workspaceRoot) }
    var workspacePath by remember(prefs.workspacePath) { mutableStateOf(prefs.workspacePath) }
    var workspaceEntries by remember { mutableStateOf<List<com.example.api.WorkspaceEntry>>(emptyList()) }
    var workspaceParent by remember { mutableStateOf<String?>(null) }
    var workspaceLoading by remember { mutableStateOf(false) }
    var filePreview by remember { mutableStateOf<com.example.api.WorkspaceFilePreview?>(null) }
    var filePreviewLoading by remember { mutableStateOf(false) }
    var connectionTesting by remember { mutableStateOf(false) }
    var connectionReport by remember { mutableStateOf<com.example.api.ConnectionTestReport?>(null) }
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    val agents = listOf("Local Codex (Pi)", "Gateway OMPK (oh-my-pk)", "Gateway Claude (Claude Code)", "Gateway Voice (ElevenLabs)", "Gateway Gemini (Vertex AI)")
    val workspacePresets = listOf(
        "C:/Dev" to AppPreferences.DEFAULT_WORKSPACE_PATH,
        "SPWR Daily" to AppPreferences.SPWR_DAILY_WORKSPACE_PATH
    )
    val modelPresets = listOf(
        "Gemini 3.1 Live" to "gemini-3.1-flash-live-preview",
        "Gemini 3.5 Flash" to "gemini-3.5-flash",
        "Server default" to "",
        "Legacy 2.5 Live" to "gemini-live-2.5-flash-native-audio"
    )

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

                    Text(text = "Agent Model", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = agentModel,
                        onValueChange = {
                            agentModel = it
                            prefs.agentModel = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFC2542F),
                            unfocusedBorderColor = Color(0xFFE3DCCC),
                            focusedTextColor = Color(0xFF211C16),
                            unfocusedTextColor = Color(0xFF211C16)
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("Server default", color = Color(0xFF6E665A)) },
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(text = "Model Presets", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        modelPresets.forEach { (label, model) ->
                            val selected = if (model.isBlank()) agentModel.isBlank() else agentModel.equals(model, ignoreCase = true)
                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .clickable {
                                        agentModel = model
                                        prefs.agentModel = model
                                        onConfigChanged()
                                    },
                                color = if (selected) Color(0xFFF4F1E9) else Color(0x22B8AF9A),
                                shape = RoundedCornerShape(10.dp),
                                border = BorderStroke(1.dp, if (selected) Color(0xFFC2542F) else Color(0xFFE3DCCC))
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(
                                        selected = selected,
                                        onClick = {
                                            agentModel = model
                                            prefs.agentModel = model
                                            onConfigChanged()
                                        },
                                        colors = RadioButtonDefaults.colors(
                                            selectedColor = Color(0xFFC2542F),
                                            unselectedColor = Color(0xFF6E665A)
                                        )
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(label, color = Color(0xFF211C16), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                        Text(if (model.isBlank()) "Gateway default" else model, color = Color(0xFF6E665A), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }

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
                    Text(text = "Workspace Presets", color = Color(0xFF6E665A), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        workspacePresets.forEach { (label, path) ->
                            val selected = workspacePath.equals(path, ignoreCase = true)
                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .clickable {
                                        workspaceRoot = path
                                        workspacePath = path
                                        prefs.workspaceRoot = path
                                        prefs.workspacePath = path
                                        onConfigChanged()
                                    },
                                color = if (selected) Color(0xFFF4F1E9) else Color(0x22B8AF9A),
                                shape = RoundedCornerShape(10.dp),
                                border = BorderStroke(1.dp, if (selected) Color(0xFFC2542F) else Color(0xFFE3DCCC))
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(
                                        selected = selected,
                                        onClick = {
                                            workspaceRoot = path
                                            workspacePath = path
                                            prefs.workspaceRoot = path
                                            prefs.workspacePath = path
                                            onConfigChanged()
                                        },
                                        colors = RadioButtonDefaults.colors(
                                            selectedColor = Color(0xFFC2542F),
                                            unselectedColor = Color(0xFF6E665A)
                                        )
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(label, color = Color(0xFF211C16), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                        Text(path, color = Color(0xFF6E665A), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }
                    Spacer(modifier = Modifier.height(4.dp))
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
                    if (filePreviewLoading) {
                        Text(text = "Loading file preview...", color = Color(0xFF6E665A), fontSize = 11.sp)
                    }
                    workspaceEntries.take(24).forEach { entry ->
                        if (entry.isFile) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        if (!filePreviewLoading) {
                                            scope.launch {
                                                filePreviewLoading = true
                                                filePreview = com.example.api.VoiceAgentClient(context, prefs).readWorkspaceFile(entry.path)
                                                filePreviewLoading = false
                                            }
                                        }
                                    }
                                    .padding(vertical = 6.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = entry.name,
                                    color = Color(0xFF211C16),
                                    fontSize = 12.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                Text(
                                    text = formatWorkspaceFileSize(entry.size),
                                    color = Color(0xFF6E665A),
                                    fontSize = 10.sp
                                )
                            }
                        } else {
                            Text(
                                text = "${entry.name}/",
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

        // Hardware Audio & VAD Settings
        item {
            val aecVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getBoolean("aec_enabled", true)) }
            val nsVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getBoolean("ns_enabled", true)) }
            val vadVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getBoolean("vad_enabled", true)) }
            val thresholdVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getFloat("vad_threshold", 1500f)) }

            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Hardware Audio & VAD Strategy",
                        color = Color(0xFF211C16),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Switch(
                            checked = aecVal.value,
                            onCheckedChange = {
                                aecVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putBoolean("aec_enabled", it).apply()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Color(0xFFC2542F),
                                checkedTrackColor = Color(0xFFF4F1E9)
                            )
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Column {
                            Text(text = "Acoustic Echo Cancellation (AEC)", color = Color(0xFF211C16), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(text = "Prevents speaker audio from leaking back into the mic", color = Color(0xFF6E665A), fontSize = 11.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Switch(
                            checked = nsVal.value,
                            onCheckedChange = {
                                nsVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putBoolean("ns_enabled", it).apply()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Color(0xFFC2542F),
                                checkedTrackColor = Color(0xFFF4F1E9)
                            )
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Column {
                            Text(text = "Noise Suppression (NS)", color = Color(0xFF211C16), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(text = "Reduces ambient background noise", color = Color(0xFF6E665A), fontSize = 11.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(16.dp))
                    Spacer(modifier = Modifier.height(1.dp).fillMaxWidth().background(Color(0xFFE3DCCC)))
                    Spacer(modifier = Modifier.height(16.dp))

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Switch(
                            checked = vadVal.value,
                            onCheckedChange = {
                                vadVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putBoolean("vad_enabled", it).apply()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Color(0xFFC2542F),
                                checkedTrackColor = Color(0xFFF4F1E9)
                            )
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Column {
                            Text(text = "Voice Activity Detection (VAD) Barge-in", color = Color(0xFF211C16), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(text = "Interrupts assistant speech when you start speaking", color = Color(0xFF6E665A), fontSize = 11.sp)
                        }
                    }

                    if (vadVal.value) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(text = "VAD Threshold: ${thresholdVal.value.toInt()}", color = Color(0xFF6E665A), fontSize = 11.sp)
                        Slider(
                            value = thresholdVal.value,
                            onValueChange = {
                                thresholdVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putFloat("vad_threshold", it).apply()
                            },
                            valueRange = 0f..5000f,
                            colors = SliderDefaults.colors(
                                thumbColor = Color(0xFFC2542F),
                                activeTrackColor = Color(0xFFC2542F),
                                inactiveTrackColor = Color(0xFFE3DCCC)
                            )
                        )
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

    filePreview?.let { preview ->
        WorkspaceFileViewerDialog(preview = preview, onDismiss = { filePreview = null })
    }
}

fun formatWorkspaceFileSize(size: Long?): String = when {
    size == null -> ""
    size >= 1_048_576L -> "%.1f MB".format(size / 1_048_576.0)
    size >= 1_024L -> "%.1f KB".format(size / 1_024.0)
    else -> "$size B"
}

@Composable
fun WorkspaceFileViewerDialog(
    preview: com.example.api.WorkspaceFilePreview,
    onDismiss: () -> Unit
) {
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.85f),
            color = Color(0xFFFFFFFF),
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, Color(0xFFE3DCCC))
        ) {
            Column(modifier = Modifier.padding(14.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.Top,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = preview.name.ifBlank { preview.path.substringAfterLast('/').substringAfterLast('\\') }.ifBlank { "File" },
                            color = Color(0xFF211C16),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Text(
                            text = listOfNotNull(
                                preview.path.takeIf { it.isNotBlank() },
                                formatWorkspaceFileSize(preview.size.takeIf { it > 0L }).takeIf { it.isNotBlank() }
                            ).joinToString(" · "),
                            color = Color(0xFF6E665A),
                            fontSize = 10.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    TextButton(onClick = onDismiss) {
                        Text("Close", color = Color(0xFFC2542F), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
                when {
                    preview.error != null -> {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(preview.error, color = Color(0xFFB3261E), fontSize = 12.sp)
                    }
                    preview.binary -> {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Binary file — no preview available.", color = Color(0xFF6E665A), fontSize = 12.sp)
                    }
                    else -> {
                        if (preview.truncated) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("Preview shows the first 512 KB of this file.", color = Color(0xFFC97E1A), fontSize = 10.sp)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .border(1.dp, Color(0xFFE3DCCC), RoundedCornerShape(8.dp))
                                .background(Color(0xFFFAF8F2), RoundedCornerShape(8.dp))
                                .padding(10.dp)
                                .verticalScroll(rememberScrollState())
                        ) {
                            Text(
                                text = preview.content.ifBlank { "(empty file)" },
                                color = Color(0xFF211C16),
                                fontSize = 11.sp,
                                lineHeight = 16.sp,
                                fontFamily = FontFamily.Monospace
                            )
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

        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFFFFFFFF),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFFE3DCCC))
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
                                color = Color(0xFF211C16),
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = warpStatusText,
                                color = if (warpSnapshot?.available == true) Color(0xFF2E7D52) else Color(0xFF6E665A),
                                fontSize = 11.sp,
                                lineHeight = 15.sp
                            )
                            warpSnapshot?.warpRemoteBaseUrl?.let { url ->
                                Text(
                                    text = "Warp relay: $url",
                                    color = Color(0xFF6E665A),
                                    fontSize = 10.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            warpSnapshot?.let { snapshot ->
                                Text(
                                    text = "Connection: ${if (snapshot.sameTailnet) "Tailscale" else "gateway"} • ${prefs.targetIpAddress} • ${snapshot.warpUriScheme}://",
                                    color = Color(0xFF6E665A),
                                    fontSize = 10.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                snapshot.psmuxError?.let { error ->
                                    Text(
                                        text = "psmux: $error",
                                        color = Color(0xFFC2542F),
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
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFC2542F), contentColor = Color.White),
                            shape = RoundedCornerShape(10.dp)
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
                            color = Color(0xFF211C16),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                        session.windows.take(4).forEach { window ->
                            Text(
                                text = "  tab ${window.index}: ${window.name}",
                                color = Color(0xFF6E665A),
                                fontSize = 11.sp
                            )
                            window.panes.take(8).forEach { pane ->
                                Text(
                                    text = "    pane ${pane.paneId.ifBlank { pane.pane }} ${if (pane.active) "• active" else ""} ${pane.command ?: ""}",
                                    color = if (pane.active) Color(0xFF2E7D52) else Color(0xFF6E665A),
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
