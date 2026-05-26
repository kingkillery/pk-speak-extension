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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import com.google.accompanist.permissions.PermissionState
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.api.VoiceAgentClient
import com.example.api.RemoteSlashCommand
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var audioHelper: AudioHelper
    private lateinit var ttsHelper: TtsHelper
    private lateinit var appPreferences: AppPreferences
    private lateinit var voiceAgentClient: VoiceAgentClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        audioHelper = AudioHelper(this)
        ttsHelper = TtsHelper(this)
        appPreferences = AppPreferences(this)
        voiceAgentClient = VoiceAgentClient(this, appPreferences)
        
        handleDeepLink(intent)
        
        enableEdgeToEdge()

        setContent {
            MyApplicationTheme {
                Scaffold(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color(0xFF1A1C1E))
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
                token?.let { appPreferences.remoteToken = it }
                profileName?.let { appPreferences.machineProfileName = it }
                defaultTarget?.takeIf { it.isNotBlank() }?.let { appPreferences.codexSessionName = it }
                workspaceRoot?.takeIf { it.isNotBlank() }?.let { appPreferences.workspaceRoot = it }
                workspacePath?.takeIf { it.isNotBlank() }?.let { appPreferences.workspacePath = it }
                connectionMode?.let { appPreferences.connectionMode = it }
                when (agentProvider?.lowercase()) {
                    "codex", "pi" -> appPreferences.activeAgent = "Local Codex (Pi)"
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

    // Synchronize agent state
    LaunchedEffect(selectedAgent) {
        prefs.activeAgent = selectedAgent
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xFF1A1C1E))
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
        ) {
            // Dynamic App Header (Professional Polish Design Guidelines)
            HeaderSection(
                sessionName = codexSessionName,
                onSettingsClick = { currentTab = "settings" }
            )

            // Horizontal Tab Selector
            TabSelector(
                activeTab = currentTab,
                onTabSelect = { currentTab = it }
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
                        client = client
                    )
                    "sessions" -> SessionsTabContent(
                        audioHelper = audioHelper,
                        ttsHelper = ttsHelper,
                        prefs = prefs
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
                        .background(Color(0xFF44474B))
                )
            }
        }
    }
}

@Composable
fun HeaderSection(
    sessionName: String,
    onSettingsClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.weight(1f)
        ) {
            // "π" Circular Branding Design
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .background(Color(0xFFD0E4FF)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "π",
                    color = Color(0xFF003355),
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                Text(
                    text = "Pi Speak",
                    color = Color(0xFFE2E2E6),
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.5.sp
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(Color(0xFF22C55E))
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = "Codex: $sessionName",
                        color = Color(0xFF8E9199),
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }

        // Configuration action setting icon
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(Color(0xFF2D2F33))
                .clickable { onSettingsClick() },
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "⚙",
                color = Color(0xFFE2E2E6),
                fontSize = 18.sp
            )
        }
    }
}

@Composable
fun TabSelector(
    activeTab: String,
    onTabSelect: (String) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 20.dp, bottom = 12.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF2D2F33))
            .padding(4.dp),
        horizontalArrangement = Arrangement.SpaceEvenly
    ) {
        listOf(
            "studio" to "Studio",
            "discovery" to "Discover",
            "commands" to "Commands",
            "sessions" to "Sessions",
            "settings" to "Configure"
        ).forEach { (id, label) ->
            val isSelected = activeTab == id
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (isSelected) Color(0xFF1A1C1E) else Color.Transparent)
                    .clickable { onTabSelect(id) }
                    .padding(vertical = 10.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = label,
                    color = if (isSelected) Color(0xFFD0E4FF) else Color(0xFF8E9199),
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                    fontSize = 13.sp
                )
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
    client: VoiceAgentClient
) {
    val permissionState = rememberPermissionState(permission = Manifest.permission.RECORD_AUDIO)
    val scope = rememberCoroutineScope()

    var isRecording by remember { mutableStateOf(false) }
    var isProcessing by remember { mutableStateOf(false) }
    var transcription by remember { mutableStateOf("") }
    var latestReply by remember { mutableStateOf("") }
    var progressText by remember { mutableStateOf("") }
    var currentRecordPath by remember { mutableStateOf<String?>(null) }
    var textInputState by remember { mutableStateOf("") }
    var activeTurnJob by remember { mutableStateOf<Job?>(null) }
    var turnGeneration by remember { mutableIntStateOf(0) }
    val conversationKey = prefs.conversationKey()
    var chatMessages by remember(conversationKey) { mutableStateOf(prefs.getChatMessages(conversationKey)) }

    // Live decibels state for custom drawing
    val amplitudeList = remember { mutableStateListOf<Float>().apply { addAll(List(16) { 0.1f }) } }
    var liveAmplitudeJob by remember { mutableStateOf<Job?>(null) }

    // Real-time synchronized simulated transcription stream
    var wordStreamJob by remember { mutableStateOf<Job?>(null) }
    var recordingStartedAtMs by remember { mutableLongStateOf(0L) }
    val minimumVoiceCaptureMs = 1200L

    fun setProgress(message: String) {
        if (prefs.showTurnProgress) {
            progressText = message
        }
    }

    fun persistChat(messages: List<ChatMessage>) {
        val capped = messages.takeLast(50)
        chatMessages = capped
        prefs.saveChatMessages(conversationKey, capped)
    }

    fun appendChat(role: String, text: String, progress: List<String> = emptyList(), audioPath: String? = null) {
        val trimmed = text.trim()
        if (trimmed.isBlank() && progress.isEmpty()) return
        persistChat(
            chatMessages + ChatMessage(
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

    fun stopCurrentTurn() {
        turnGeneration += 1
        activeTurnJob?.cancel()
        activeTurnJob = null
        setProgress("Stop requested. Asking gateway to cancel the current turn.")
        ttsHelper.stop()
        audioHelper.stopPlayback()
        scope.launch {
            val message = client.cancelTurn()
            setProgress(message)
            latestReply = message
            appendChat("system", message)
            isProcessing = false
        }
    }

    val startSimulatedTranscription = {
        wordStreamJob?.cancel()
        transcription = "Streaming wireless audio loop..."
    }

    val startAmplitudeSampling = {
        liveAmplitudeJob?.cancel()
        liveAmplitudeJob = scope.launch {
            while (isRecording) {
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
        if (!isRecording && !isProcessing) {
            ttsHelper.stop()
            audioHelper.stopPlayback()
            isRecording = true
            recordingStartedAtMs = System.currentTimeMillis()
            currentRecordPath = audioHelper.startRecording("turn.wav")
            Log.d("MainActivity", "Voice recording started: $currentRecordPath")
            startSimulatedTranscription()
            startAmplitudeSampling()
        }
    }

    val stopAndSendAction = {
        if (isRecording) {
            isRecording = false
            liveAmplitudeJob?.cancel()
            wordStreamJob?.cancel()
            turnGeneration += 1
            val myTurnGeneration = turnGeneration

            val job = scope.launch {
                isProcessing = true
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
                            while (isProcessing) {
                                delay(7000)
                                if (myTurnGeneration != turnGeneration) break
                                val message = updates[index.coerceAtMost(updates.lastIndex)]
                                setProgress(message)
                                if (prefs.speakTurnProgress) {
                                    ttsHelper.speak(message)
                                }
                                if (index < updates.lastIndex) index += 1
                            }
                        }
                        val result = client.sendVoiceTurnDetailed(file, transcription)
                        if (myTurnGeneration != turnGeneration) return@launch
                        progressJob?.cancel()
                        ttsHelper.stop()
                        transcription = result.transcript
                        val finalProgressText = result.progress.joinToString("\n")
                        progressText = finalProgressText
                        latestReply = result.replyText

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
                        } else if (prefs.autoSpeakEnabled && latestReply.isNotEmpty()) {
                            ttsHelper.speak(latestReply)
                        }
                    } else {
                        if (myTurnGeneration != turnGeneration) return@launch
                        transcription = "Failed to record voice correctly."
                        latestReply = "The audio clip was too short or could not be finalized. Hold the voice button a little longer and try again."
                        appendChat("system", latestReply)
                    }
                } catch (_: CancellationException) {
                    setProgress("Turn stopped.")
                } catch (e: Exception) {
                    if (myTurnGeneration == turnGeneration) {
                        latestReply = "System error contacting voice node: ${e.localizedMessage}"
                    }
                } finally {
                    progressJob?.cancel()
                    if (myTurnGeneration == turnGeneration) {
                        activeTurnJob = null
                        isProcessing = false
                    }
                }
            }
            activeTurnJob = job
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        // Core Visual Equalizer Graph Structure (Professional Polish spec)
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                text = when {
                    isRecording -> "MICROPHONE TRANSMITTING"
                    isProcessing -> "COMPILING CODEX SHARDS"
                    else -> "TACTICAL CONSOLE IDLE"
                },
                color = if (isRecording) Color(0xFFC95532) else Color(0xFF8E9199),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 8.dp)
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Adaptive spectrum canvas drawing
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(80.dp),
                contentAlignment = Alignment.Center
            ) {
                WaveformBars(amplitudes = amplitudeList, active = isRecording)
            }
        }

        // Live Real-Time Transcribe & Response View Card
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(vertical = 12.dp)
        ) {
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = Color(0xFF2D2F33),
                shape = RoundedCornerShape(24.dp),
                border = BorderStroke(1.dp, Color(0xFF44474B))
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    if (chatMessages.isNotEmpty()) {
                        item {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "CONVERSATION LOG",
                                    color = Color(0xFFD0E4FF),
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 1.sp
                                )
                                TextButton(
                                    onClick = {
                                        prefs.clearChatMessages(conversationKey)
                                        chatMessages = emptyList()
                                        transcription = ""
                                        latestReply = ""
                                        progressText = ""
                                    },
                                    enabled = !isProcessing,
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                                ) {
                                    Text("Clear", color = Color(0xFF8E9199), fontSize = 10.sp)
                                }
                            }
                        }
                        items(chatMessages, key = { it.id }) { message ->
                            val isUser = message.role == "user"
                            val isProgress = message.role == "progress"
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
                                        "user" -> Color(0xFFD0E4FF)
                                        "assistant" -> Color(0xFF22C55E)
                                        "progress" -> Color(0xFF8E9199)
                                        else -> Color(0xFFFFB4A8)
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
                                                isUser -> Color(0xFF1F3442)
                                                isProgress -> Color(0xFF202226)
                                                else -> Color(0xFF1F2022)
                                            },
                                            RoundedCornerShape(8.dp)
                                        )
                                        .border(
                                            1.dp,
                                            if (isProgress) Color(0xFF3A3D42) else Color(0xFF323438),
                                            RoundedCornerShape(8.dp)
                                        )
                                        .padding(10.dp)
                                ) {
                                    Text(
                                        text = message.text,
                                        color = if (isProgress) Color(0xFFB0B3BC) else Color(0xFFE2E2E6),
                                        fontSize = if (isProgress) 11.sp else 13.sp,
                                        lineHeight = if (isProgress) 16.sp else 19.sp,
                                        fontFamily = if (message.role == "assistant") FontFamily.Monospace else FontFamily.Default
                                    )
                                }
                            }
                        }
                    }

                    if (transcription.isNotEmpty()) {
                        item {
                            Column {
                                Text(
                                    text = "TRANSCRIPT STREAM",
                                    color = Color(0xFFD0E4FF),
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 1.sp
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = "$transcription...",
                                    color = Color(0xFFE2E2E6),
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Medium
                                )
                            }
                        }
                    }

                    if (isProcessing) {
                        item {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 16.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                CircularProgressIndicator(
                                    color = Color(0xFFD0E4FF),
                                    strokeWidth = 2.dp,
                                    modifier = Modifier.size(24.dp)
                                )
                                if (prefs.showTurnProgress && progressText.isNotBlank()) {
                                    Spacer(modifier = Modifier.height(10.dp))
                                    Text(
                                        text = progressText,
                                        color = Color(0xFFDCEAF3),
                                        fontSize = 12.sp,
                                        lineHeight = 17.sp,
                                        textAlign = TextAlign.Center
                                    )
                                }
                                Spacer(modifier = Modifier.height(12.dp))
                                OutlinedButton(
                                    onClick = { stopCurrentTurn() },
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFFFB4A8)),
                                    border = BorderStroke(1.dp, Color(0xFFC95532)),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Text("Stop turn", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }

                    if (latestReply.isNotEmpty() && !isProcessing) {
                        item {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 8.dp)
                            ) {
                                Divider(color = Color(0xFF44474B), modifier = Modifier.padding(vertical = 8.dp))
                                Row(
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Text(
                                        text = "CODEX DEPLOYER REPLY",
                                        color = Color(0xFF22C55E),
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold,
                                        letterSpacing = 1.sp
                                    )
                                    Text(
                                        text = prefs.activeAgent,
                                        color = Color(0xFF8E9199),
                                        fontSize = 10.sp
                                    )
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                if (prefs.showTurnProgress && progressText.isNotBlank()) {
                                    Text(
                                        text = progressText,
                                        color = Color(0xFF8E9199),
                                        fontSize = 11.sp,
                                        lineHeight = 16.sp
                                    )
                                    Spacer(modifier = Modifier.height(8.dp))
                                }
                                Text(
                                    text = "\"$latestReply\"",
                                    color = Color(0xFFDCEAF3),
                                    fontSize = 15.sp,
                                    lineHeight = 22.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                        }
                    }

                    // Empty State Guidelines
                    if (transcription.isEmpty() && latestReply.isEmpty()) {
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
                                    color = Color(0xFF8E9199),
                                    fontSize = 14.sp
                                )
                                Text(
                                    text = if (prefs.transmissionMode == "PTT") 
                                        "Long press the tactical pad below to talk." 
                                    else "Tap the tactical pad below to toggle mic.",
                                    color = Color(0xFF8E9199),
                                    fontSize = 12.sp,
                                    textAlign = TextAlign.Center
                                )
                            }
                        }
                    }
                }
            }
        }
        // Text Input Fallback Shard / Console Keyboard Turn Input
        val context = androidx.compose.ui.platform.LocalContext.current
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = textInputState,
                onValueChange = { textInputState = it },
                placeholder = { Text("Enter manual codex instruction...", color = Color(0xFF8E9199), fontSize = 13.sp) },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Color(0xFFD0E4FF),
                    unfocusedBorderColor = Color(0xFF44474B),
                    focusedTextColor = Color(0xFFE2E2E6),
                    unfocusedTextColor = Color(0xFFE2E2E6),
                    focusedContainerColor = Color(0xFF2D2F33),
                    unfocusedContainerColor = Color(0xFF2D2F33)
                ),
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, color = Color(0xFFE2E2E6)),
                singleLine = true,
                modifier = Modifier.weight(1f),
                enabled = !isProcessing
            )
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(
                onClick = {
                    if (textInputState.trim().isNotEmpty() && !isProcessing) {
                        val promptText = textInputState.trim()
                        textInputState = ""
                        turnGeneration += 1
                        val myTurnGeneration = turnGeneration
                        val job = scope.launch {
                            isProcessing = true
                            transcription = promptText
                            setProgress("Sending text to gateway.")
                            appendChat("user", promptText)
                            try {
                                val result = client.sendTextTurnDetailed(promptText)
                                if (myTurnGeneration != turnGeneration) return@launch
                                ttsHelper.stop()
                                transcription = result.transcript
                                val finalProgressText = result.progress.joinToString("\n")
                                progressText = finalProgressText
                                latestReply = result.replyText

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
                                } else if (prefs.autoSpeakEnabled && latestReply.isNotEmpty()) {
                                    ttsHelper.speak(latestReply)
                                }
                            } catch (_: CancellationException) {
                                setProgress("Turn stopped.")
                            } catch (e: Exception) {
                                if (myTurnGeneration == turnGeneration) {
                                    latestReply = "System error contacting local node: ${e.localizedMessage}"
                                }
                            } finally {
                                if (myTurnGeneration == turnGeneration) {
                                    activeTurnJob = null
                                    isProcessing = false
                                }
                            }
                        }
                        activeTurnJob = job
                    }
                },
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF2D2F33))
                    .border(BorderStroke(1.dp, Color(0xFF44474B)), RoundedCornerShape(8.dp)),
                enabled = textInputState.trim().isNotEmpty() && !isProcessing
            ) {
                Text("⚡", color = if (textInputState.trim().isNotEmpty()) Color(0xFFD0E4FF) else Color(0xFF8E9199))
            }
        }

        // Active Voice Agent Target Indicator Strip
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF2D2F33))
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "AGENT PREFERENCE:",
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = Color(0xFF8E9199)
            )
            Text(
                text = prefs.activeAgent.uppercase(),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = Color(0xFFD0E4FF)
            )
        }

        // Tactical Record Pad Control Section
        if (permissionState.status.isGranted) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(bottom = 16.dp)
            ) {
                // Large Tactical Round Button with Pulse Glow Backing
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.size(140.dp)
                ) {
                    val scaleFactor by animateFloatAsState(
                        targetValue = if (isRecording) 1.2f else 1.0f,
                        animationSpec = spring(dampingRatio = 0.6f, stiffness = 80f)
                    )

                    // Glow background pulses visually
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .scale(scaleFactor)
                            .clip(CircleShape)
                            .background(
                                color = if (isRecording) Color(0x33B3261E) else Color(0x1AD0E4FF)
                            )
                            .blur(if (isRecording) 16.dp else 4.dp)
                    )

                    // Actual Button
                    Box(
                        modifier = Modifier
                            .size(100.dp)
                            .scale(scaleFactor)
                            .clip(CircleShape)
                            .background(
                                brush = Brush.radialGradient(
                                    colors = if (isRecording) {
                                        listOf(Color(0xFFE04F2A), Color(0xFFB3261E))
                                    } else {
                                        listOf(Color(0xFFD0E4FF), Color(0xFF76A8FF))
                                    }
                                )
                            )
                            .border(BorderStroke(6.dp, Color(0xFF1A1C1E)), CircleShape)
                            .pointerInput(prefs.transmissionMode) {
                                detectTapGestures(
                                    onPress = {
                                        if (prefs.transmissionMode == "PTT") {
                                            recordTriggerAction()
                                            tryAwaitRelease()
                                            stopAndSendAction()
                                        }
                                    },
                                    onTap = {
                                        if (prefs.transmissionMode == "TOGGLE") {
                                            if (isRecording) stopAndSendAction() else recordTriggerAction()
                                        }
                                    }
                                )
                            },
                        contentAlignment = Alignment.Center
                    ) {
                        // Tactical Mic Icon
                        Text(
                            text = if (isRecording) "🎙" else "π",
                            fontSize = 32.sp,
                            color = if (isRecording) Color.White else Color(0xFF003355),
                            fontWeight = FontWeight.Black
                        )
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = if (prefs.transmissionMode == "PTT") "HOLD TACTICAL PAD TO TALK" else "TAP TO TOGGLE MICROPHONE",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (isRecording) Color(0xFFC95532) else Color(0xFF8E9199),
                    letterSpacing = 0.5.sp
                )
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "Microphone Permission Required to Transmit",
                    color = Color(0xFFE2E2E6),
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(12.dp))
                Button(
                    onClick = { permissionState.launchPermissionRequest() },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD0E4FF), contentColor = Color(0xFF003355))
                ) {
                    Text("Grant Wireless Access")
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
                color = Color(0xFF232529),
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, Color(0xFF383A3E))
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text(
                        text = "Slash Command Connector",
                        color = Color(0xFFE2E2E6),
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Gateway: ${prefs.machineProfileName}",
                        color = Color(0xFF8E9199),
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = customCommand,
                            onValueChange = { customCommand = it },
                            placeholder = { Text("/sess status", color = Color(0xFF8E9199), fontSize = 12.sp) },
                            singleLine = true,
                            enabled = !isRunning,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFFD0E4FF),
                                unfocusedBorderColor = Color(0xFF44474B),
                                focusedTextColor = Color(0xFFE2E2E6),
                                unfocusedTextColor = Color(0xFFE2E2E6),
                                focusedContainerColor = Color(0xFF1E2022),
                                unfocusedContainerColor = Color(0xFF1E2022)
                            ),
                            modifier = Modifier.weight(1f)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = { runCommand(customCommand) },
                            enabled = customCommand.trim().isNotEmpty() && !isRunning,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Color(0xFFD0E4FF),
                                contentColor = Color(0xFF003355)
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
                            color = if (statusText.startsWith("Command failed")) Color(0xFFFFB4AB) else Color(0xFFDCEAF3),
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
                    CircularProgressIndicator(color = Color(0xFF4FA0EC))
                }
            }
        }

        items(commands, key = { it.name }) { command ->
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFF2D2F33),
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, Color(0xFF44474B))
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text(
                        text = "/${command.name}",
                        color = Color(0xFFD0E4FF),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace
                    )
                    if (command.description.isNotBlank()) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = command.description,
                            color = Color(0xFFE2E2E6),
                            fontSize = 12.sp
                        )
                    }
                    if (command.usage.isNotBlank()) {
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = command.usage,
                            color = Color(0xFFB0B3BC),
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
                                    border = BorderStroke(1.dp, Color(0xFF50616F))
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
                                containerColor = Color(0xFF17578D),
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
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences
) {
    var sessionsList by remember { mutableStateOf(prefs.getRecordedSessions()) }
    var activePlaybackId by remember { mutableStateOf<String?>(null) }

    fun refreshList() {
        sessionsList = prefs.getRecordedSessions()
    }

    if (sessionsList.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = "No saved sessions tape.",
                    color = Color(0xFF8E9199),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Transmit a voice or text turn to start logging sessions.",
                    color = Color(0xFF8E9199),
                    fontSize = 12.sp
                )
            }
        }
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp)
        ) {
            items(sessionsList, key = { it.id }) { item ->
                val isPlaying = activePlaybackId == item.id
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    color = Color(0xFF2D2F33),
                    shape = RoundedCornerShape(16.dp),
                    border = BorderStroke(1.dp, if (isPlaying) Color(0xFF22C55E) else Color(0xFF44474B))
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
                                color = Color(0xFFD0E4FF),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = 0.5.sp
                            )
                            Text(
                                text = item.voiceAgent,
                                color = Color(0xFF8E9199),
                                fontSize = 10.sp
                            )
                        }

                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Prompt: \"${item.transcriptionText}\"",
                            color = Color(0xFFE2E2E6),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium
                        )

                        Spacer(modifier = Modifier.height(4.dp))
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color(0xFF1E2022), RoundedCornerShape(8.dp))
                                .padding(8.dp)
                        ) {
                            Text(
                                text = item.replyText,
                                color = Color(0xFFDCEAF3),
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
                                        containerColor = if (isPlaying) Color(0xFFB3261E) else Color(0xFFD0E4FF),
                                        contentColor = if (isPlaying) Color.White else Color(0xFF003355)
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
                                            containerColor = Color(0xFF17765D),
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
                                            containerColor = Color(0xFF17578D),
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
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current

    val agents = listOf("Local Codex (Pi)", "Gateway Voice (ElevenLabs)", "Gateway Gemini (Vertex AI)")

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 12.dp)
    ) {
        item {
            Text(
                text = "VOICE ENGINE CONTROL MATRIX",
                color = Color(0xFF8E9199),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
        }

        // Active Voice Agent Matrix Config
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFF2D2F33),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFF44474B))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Active Voice Agent",
                        color = Color(0xFFE2E2E6),
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
                                    selectedColor = Color(0xFFD0E4FF),
                                    unselectedColor = Color(0xFF8E9199)
                                )
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = agent, color = Color(0xFFE2E2E6), fontSize = 14.sp)
                        }
                    }
                }
            }
        }

        // Tactical Trigger Setup
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFF2D2F33),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFF44474B))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Microphone Action Strategy",
                        color = Color(0xFFE2E2E6),
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
                                    .background(if (isSelected) Color(0xFF1A1C1E) else Color(0x3344474B))
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
                                    color = if (isSelected) Color(0xFFD0E4FF) else Color(0xFF8E9199),
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
                        Text(text = "Show turn progress text", color = Color(0xFFE2E2E6), fontSize = 13.sp)
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
                        Text(text = "Speak periodic progress updates", color = Color(0xFFE2E2E6), fontSize = 13.sp)
                    }
                }
            }
        }

        // Connection IP & Codex Session Targets Configuration
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = Color(0xFF2D2F33),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFF44474B))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Remote Codex Matrix Profile",
                        color = Color(0xFFE2E2E6),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // Machine profile label
                    Text(text = "Machine Profile Name", color = Color(0xFF8E9199), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = machineProfileName,
                        onValueChange = {
                            machineProfileName = it
                            prefs.machineProfileName = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFD0E4FF),
                            unfocusedBorderColor = Color(0xFF44474B),
                            focusedTextColor = Color(0xFFE2E2E6),
                            unfocusedTextColor = Color(0xFFE0E2E6)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Session tag
                    Text(text = "Target Session Name", color = Color(0xFF8E9199), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = codexSessionName,
                        onValueChange = {
                            codexSessionName = it
                            prefs.codexSessionName = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFD0E4FF),
                            unfocusedBorderColor = Color(0xFF44474B),
                            focusedTextColor = Color(0xFFE2E2E6),
                            unfocusedTextColor = Color(0xFFE0E2E6)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Gateway IP Address
                    Text(text = "Local Gateway URL host", color = Color(0xFF8E9199), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = targetIpAddress,
                        onValueChange = {
                            targetIpAddress = it
                            prefs.targetIpAddress = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFD0E4FF),
                            unfocusedBorderColor = Color(0xFF44474B),
                            focusedTextColor = Color(0xFFE2E2E6),
                            unfocusedTextColor = Color(0xFFE2E2E6)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Text(text = "Workspace Folder", color = Color(0xFF8E9199), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = workspacePath,
                        onValueChange = {
                            workspacePath = it
                            prefs.workspacePath = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFD0E4FF),
                            unfocusedBorderColor = Color(0xFF44474B),
                            focusedTextColor = Color(0xFFE2E2E6),
                            unfocusedTextColor = Color(0xFFE2E2E6)
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(workspaceRoot, color = Color(0xFF8E9199)) }
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
                        Text(text = "Loading folders...", color = Color(0xFF8E9199), fontSize = 11.sp)
                    }
                    workspaceEntries.take(12).forEach { entry ->
                        Text(
                            text = entry.name,
                            color = Color(0xFFD0E4FF),
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
                    Text(text = "Gateway Authentication Token", color = Color(0xFF8E9199), fontSize = 11.sp)
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
                            focusedBorderColor = Color(0xFFD0E4FF),
                            unfocusedBorderColor = Color(0xFF44474B),
                            focusedTextColor = Color(0xFFE2E2E6),
                            unfocusedTextColor = Color(0xFFE2E2E6)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Default Gateway Network Interface
                    Text(text = "Default Gateway Network Interface", color = Color(0xFF8E9199), fontSize = 11.sp)
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
                                    .background(if (isSelected) Color(0xFF1A1C1E) else Color(0x3344474B))
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
                                    color = if (isSelected) Color(0xFFD0E4FF) else Color(0xFF8E9199),
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
                color = Color(0xFF2D2F33),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFF44474B))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "ElevenLabs API Wiring Hub",
                        color = Color(0xFFE2E2E6),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // api key input fields (Must be masked unless requested)
                    Text(text = "ElevenLabs API Key", color = Color(0xFF8E9199), fontSize = 11.sp)
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
                            focusedBorderColor = Color(0xFFD0E4FF),
                            unfocusedBorderColor = Color(0xFF44474B),
                            focusedTextColor = Color(0xFFE2E2E6),
                            unfocusedTextColor = Color(0xFFE2E2E6)
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("Unset / Local Built-In Only", color = Color(0xFF8E9199)) }
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // voice id selector input
                    Text(text = "ElevenLabs Custom Voice ID", color = Color(0xFF8E9199), fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = elevenLabsVoiceId,
                        onValueChange = {
                            elevenLabsVoiceId = it
                            prefs.elevenLabsVoiceId = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFFD0E4FF),
                            unfocusedBorderColor = Color(0xFF44474B),
                            focusedTextColor = Color(0xFFE2E2E6),
                            unfocusedTextColor = Color(0xFFE2E2E6)
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
                color = Color(0xFF2D2F33),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFF44474B))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "System Voice Feedback Loop",
                        color = Color(0xFFE2E2E6),
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
                                color = Color(0xFFDCEAF3),
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Spacer(modifier = Modifier.height(2.dp))
                            Text(
                                text = "Instantly synthesize incoming responses out loud via phone speakers or active synthesizer node.",
                                color = Color(0xFF8E9199),
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
                                checkedThumbColor = Color(0xFFD0E4FF),
                                checkedTrackColor = Color(0xFF17578D),
                                uncheckedThumbColor = Color(0xFF8E9199),
                                uncheckedTrackColor = Color(0xFF1A1C1E)
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
            
            drawRoundRect(
                color = if (active) Color(0xFF76A8FF) else Color(0x33D0E4FF),
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
            color = Color(0xFF17578D).copy(alpha = 0.15f),
            radius = maxRadius * 0.4f,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )
        drawCircle(
            color = Color(0xFF17578D).copy(alpha = 0.15f),
            radius = maxRadius * 0.7f,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )
        drawCircle(
            color = Color(0xFF17578D).copy(alpha = 0.15f),
            radius = maxRadius,
            center = center,
            style = Stroke(width = 1.dp.toPx())
        )

        // Pulsating wave line
        drawCircle(
            color = Color(0xFF4FA0EC).copy(alpha = opacity),
            radius = maxRadius * radiusRatio,
            center = center,
            style = Stroke(width = 2.dp.toPx())
        )

        // Center beacon dot
        drawCircle(
            color = Color(0xFF4FA0EC),
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
                color = Color(0xFF232529),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Color(0xFF383A3E))
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Pi Speak Server Discovery",
                            color = Color(0xFFE2E2E6),
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = if (isScanning) "Broadcasting LAN and Tailscale discovery probes..." else "Discovery idle. Scan again or use QR setup.",
                            color = if (isScanning) Color(0xFF4FA0EC) else Color(0xFF8E9199),
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
                                containerColor = Color(0xFF17578D),
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
                    color = Color(0xFF8E9199),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.8.sp
                )
                Text(
                    text = "Active Target: ${prefs.targetIpAddress}",
                    color = Color(0xFF4FA0EC),
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
                    CircularProgressIndicator(color = Color(0xFF4FA0EC))
                }
            }
        } else {
            machines.forEach { machine ->
                item {
                    val isMachineActive = prefs.targetIpAddress == machine.ip
                    val isMachineSelected = selectedMachine?.ip == machine.ip
                    val isOnline = machine.status == "online"

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                selectedMachine = machine
                                // Instantly activate destination endpoint to router
                                if (isOnline) {
                                    onSessionSelected(prefs.codexSessionName, machine.ip)
                                }
                            },
                        color = if (isMachineSelected) Color(0xFF222B35) else Color(0xFF222326),
                        shape = RoundedCornerShape(14.dp),
                        border = BorderStroke(
                            width = 1.dp,
                            color = if (isMachineSelected) Color(0xFF17578D) else Color(0xFF323438)
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
                                            .background(if (isOnline) Color(0xFF22C55E) else Color(0xFF8E9199))
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = machine.name,
                                        color = if (isOnline) Color(0xFFE2E2E6) else Color(0xFF8E9199),
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (isOnline) Color(0xFF1E3524) else Color(0xFF2C2D30))
                                        .padding(horizontal = 6.dp, vertical = 2.dp)
                                ) {
                                    Text(
                                        text = if (isOnline) "${machine.latencyMs}ms" else "OFFLINE",
                                        color = if (isOnline) Color(0xFF4ADE80) else Color(0xFF8E9199),
                                        fontSize = 9.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "IP Address: ${machine.ip}",
                                color = Color(0xFF8E9199),
                                fontSize = 11.sp
                            )

                            Spacer(modifier = Modifier.height(8.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "${machine.activeSessions.size} AI sessions cached",
                                    color = Color(0xFFB0B3BC),
                                    fontSize = 11.sp
                                )

                                if (isOnline) {
                                    if (isMachineActive) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Box(
                                                modifier = Modifier
                                                    .size(12.dp)
                                                    .clip(CircleShape)
                                                    .background(Color(0xFF22C55E)),
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
                                                color = Color(0xFF4ADE80),
                                                fontSize = 10.sp,
                                                fontWeight = FontWeight.Bold
                                            )
                                        }
                                    } else {
                                        Text(
                                            text = "TAP TO ROTATE GATEWAY",
                                            color = Color(0xFF17578D),
                                            fontSize = 9.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                } else {
                                    Text(
                                        text = "HOST UNREACHABLE",
                                        color = Color(0xFFEF4444),
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
        if (currentMachine != null && currentMachine.status == "online") {
            item {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "RUNNING SESSIONS ON ${currentMachine.name.uppercase()}",
                    color = Color(0xFF8E9199),
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
                        "CODEX" -> Color(0xFF22C55E)
                        "AGY" -> Color(0xFFF97316)
                        "CLAUDE" -> Color(0xFFA855F7)
                        "KIMI" -> Color(0xFF3B82F6)
                        else -> Color(0xFF6B7280)
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
                        color = if (isSessionActive) Color(0xFF1D3227) else Color(0xFF1F2022),
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(
                            width = 1.dp,
                            color = if (isSessionActive) Color(0xFF22C55E) else Color(0xFF2A2B2E)
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
                                        color = Color(0xFFE2E2E6),
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = session.description,
                                    color = Color(0xFF8E9199),
                                    fontSize = 11.sp
                                )
                            }

                            if (isSessionActive) {
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(Color(0xFF1E3524))
                                        .border(1.dp, Color(0xFF22C55E), RoundedCornerShape(6.dp))
                                        .padding(horizontal = 8.dp, vertical = 4.dp)
                                ) {
                                    Text(
                                        text = "✓ MOUNTED",
                                        color = Color(0xFF22C55E),
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
                                        containerColor = Color(0xFF2B2D31),
                                        contentColor = Color(0xFFB0B3BC)
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
                        color = Color(0xFFEF4444),
                        fontSize = 12.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}
