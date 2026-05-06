package com.pkkidking.pispeak.presentation.main

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.HeadsetMic
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.domain.model.MachineProfile

private val ScreenPadding = 20.dp
private val PanelShape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp)
private val VoiceShape = androidx.compose.foundation.shape.RoundedCornerShape(40.dp)

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun ConversationScreen(
    uiState: MainUiState,
    contentPadding: PaddingValues,
    onMachineSelected: (String?) -> Unit,
    onBaseUrlChanged: (String) -> Unit,
    onTokenChanged: (String) -> Unit,
    onWorkspacePathChanged: (String) -> Unit,
    onTargetChanged: (String) -> Unit,
    onApplyTarget: () -> Unit,
    onRefresh: () -> Unit,
    onTextChanged: (String) -> Unit,
    onSendText: () -> Unit,
    onSaveConnection: () -> Unit,
    onRecordToggle: () -> Unit,
    onPlayAudio: () -> Unit,
    onStopAudio: () -> Unit,
    onDismissError: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    val needsSetup = uiState.baseUrl.isBlank() || uiState.token.isBlank()
    val quickReady = uiState.connectionState == ConnectionState.Connected && !needsSetup
    val isSecure = remember(uiState.baseUrl) { uiState.baseUrl.trim().startsWith("https://") }
    val focusManager = LocalFocusManager.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ScreenPadding, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        WalkieHeader(
            needsSetup = needsSetup,
            currentSession = uiState.currentSession,
            secure = isSecure,
            statusSummary = uiState.statusSummary,
            speakProvider = uiState.speakProvider,
            speakEnabled = uiState.speakEnabled,
            requestAudioReplies = uiState.requestAudioReplies,
            connectionState = uiState.connectionState,
            turnPhase = uiState.turnPhase,
            onRefresh = onRefresh,
        )

        if (needsSetup) {
            OnboardingPanel(
                baseUrl = uiState.baseUrl,
                token = uiState.token,
                workspacePath = uiState.workspacePath,
                onBaseUrlChanged = onBaseUrlChanged,
                onTokenChanged = onTokenChanged,
                onWorkspacePathChanged = onWorkspacePathChanged,
                onSaveConnection = onSaveConnection,
                onOpenSettings = onOpenSettings,
            )
        } else {
            QuickConnectionPanel(
                baseUrl = uiState.baseUrl,
                token = uiState.token,
                workspacePath = uiState.workspacePath,
                onBaseUrlChanged = onBaseUrlChanged,
                onTokenChanged = onTokenChanged,
                onWorkspacePathChanged = onWorkspacePathChanged,
                onSaveConnection = onSaveConnection,
            )
        }

        if (uiState.machineProfiles.isNotEmpty()) {
            MachinePickerPanel(
                machineProfiles = uiState.machineProfiles,
                selectedMachineId = uiState.selectedMachineId,
                onMachineSelected = onMachineSelected,
            )
        }

        SessionQuickPanel(
            isSecure = isSecure,
            tokenLoaded = uiState.token.isNotBlank(),
            currentSession = uiState.currentSession,
            connectionState = uiState.connectionState,
            turnPhase = uiState.turnPhase,
            availableTargets = uiState.availableTargets,
            targetName = uiState.targetName,
            playbackEnabled = uiState.requestAudioReplies,
            onTargetChanged = onTargetChanged,
            onApplyTarget = onApplyTarget,
            isBusy = uiState.isBusy,
        )

        if (uiState.error != null) {
            ErrorPanel(
                message = uiState.error,
                onDismiss = onDismissError,
                onOpenAppSettings = onOpenAppSettings,
            )
        }

        GuidancePanel(
            needsSetup = needsSetup,
            uiState = uiState,
            quickReady = quickReady,
        )

        VoicePanel(
            isBusy = uiState.isBusy,
            isRecording = uiState.isRecording,
            onRecordToggle = onRecordToggle,
            disabledReason = if (needsSetup) "Connect to a machine first to send voice turns." else null,
        )

        if (uiState.audioUrl != null) {
            ReplyPanel(
                transcript = uiState.transcript,
                replyText = uiState.replyText,
                audioAvailable = true,
                playbackState = uiState.playbackState,
                onPlayAudio = onPlayAudio,
                onStopAudio = onStopAudio,
            )
        } else {
            ReplyPanel(
                transcript = uiState.transcript,
                replyText = uiState.replyText,
                audioAvailable = false,
                playbackState = uiState.playbackState,
                onPlayAudio = onPlayAudio,
                onStopAudio = onStopAudio,
            )
        }

        TextFallbackPanel(
            textPrompt = uiState.textPrompt,
            onTextChanged = onTextChanged,
            onSendText = onSendText,
            enabled = !uiState.isBusy && !needsSetup,
            needsSetup = needsSetup,
            onCommit = {
                focusManager.clearFocus()
                onSendText()
            },
        )

        RecentTurnsPanel(
            recentTurns = uiState.recentTurns,
            latestAudioAvailable = uiState.audioUrl != null,
        )
    }
}

@Composable
private fun WalkieHeader(
    needsSetup: Boolean,
    currentSession: String?,
    secure: Boolean,
    statusSummary: String,
    speakProvider: String?,
    speakEnabled: Boolean,
    requestAudioReplies: Boolean,
    connectionState: ConnectionState,
    turnPhase: TurnPhase,
    onRefresh: () -> Unit,
) {
    val secureText = when {
        needsSetup -> "Setup required"
        secure -> "Secure (https)"
        else -> "Allow HTTPS preferred"
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "PI SPEAK",
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                text = "Walkie-talkie remote control for your coding machine.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.74f),
            )
            Text(
                text = buildString {
                    append(if (needsSetup) "Set up your gateway to begin." else "You are ready for a turn.")
                    append(" Session: ")
                    append(currentSession ?: "unknown")
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            OutlinedButton(
                onClick = onRefresh,
                enabled = connectionState != ConnectionState.Connected,
            ) {
                Icon(Icons.Default.Refresh, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Refresh status")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill(
                    label = "Security",
                    value = secureText,
                    strong = secure,
                    modifier = Modifier.weight(1f),
                )
                StatusPill(
                    label = "Replies",
                    value = if (requestAudioReplies) "audio" else "text",
                    strong = requestAudioReplies,
                    modifier = Modifier.weight(1f),
                )
                StatusPill(
                    label = "Provider",
                    value = if (!speakEnabled) "off" else (speakProvider ?: "auto"),
                    strong = speakEnabled,
                    modifier = Modifier.weight(1f),
                )
                StatusPill(
                    label = "Turn",
                    value = turnPhase.label(),
                    strong = turnPhase == TurnPhase.Waiting || turnPhase == TurnPhase.Recording,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                text = statusSummary,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
        }
    }
}

@Composable
private fun OnboardingPanel(
    baseUrl: String,
    token: String,
    workspacePath: String,
    onBaseUrlChanged: (String) -> Unit,
    onTokenChanged: (String) -> Unit,
    onWorkspacePathChanged: (String) -> Unit,
    onSaveConnection: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.45f),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Quick setup", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "Open `/remote setup` on your machine and share the link, or add base url/token below.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f),
            )
            Text(
                text = "Add a launch path to make actions run in the right repository folder automatically.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            OutlinedTextField(
                value = baseUrl,
                onValueChange = onBaseUrlChanged,
                label = { Text("Base URL") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next,
                ),
            )
            OutlinedTextField(
                value = token,
                onValueChange = onTokenChanged,
                label = { Text("Remote token") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = workspacePath,
                onValueChange = onWorkspacePathChanged,
                label = { Text("Launch path") },
                placeholder = { Text("C:\\Users\\you\\repo") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = onSaveConnection) {
                    Text("Apply")
                }
                OutlinedButton(onClick = onOpenSettings) {
                    Icon(Icons.Default.Settings, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Open settings")
                }
            }
        }
    }
}

@Composable
private fun QuickConnectionPanel(
    baseUrl: String,
    token: String,
    workspacePath: String,
    onBaseUrlChanged: (String) -> Unit,
    onTokenChanged: (String) -> Unit,
    onWorkspacePathChanged: (String) -> Unit,
    onSaveConnection: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Gateway", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = baseUrl,
                onValueChange = onBaseUrlChanged,
                label = { Text("Base URL") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next,
                ),
            )
            OutlinedTextField(
                value = token,
                onValueChange = onTokenChanged,
                label = { Text("Remote token") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = workspacePath,
                onValueChange = onWorkspacePathChanged,
                label = { Text("Launch path") },
                placeholder = { Text("e.g. /Users/you/workspace/project") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Done),
            )
            Button(onClick = onSaveConnection) {
                Text("Apply changes")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MachinePickerPanel(
    machineProfiles: List<MachineProfile>,
    selectedMachineId: String?,
    onMachineSelected: (String?) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedMachine = machineProfiles.firstOrNull { it.id == selectedMachineId }
    val selectedMachineLabel = selectedMachine?.name ?: "Direct connection"

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Machine", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "Pick a saved machine profile to swap machines in one tap.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            ExposedDropdownMenuBox(
                expanded = expanded,
                onExpandedChange = { expanded = !expanded },
            ) {
                OutlinedTextField(
                    value = selectedMachineLabel,
                    onValueChange = {},
                    readOnly = true,
                    singleLine = true,
                    label = { Text("Machine profile") },
                    modifier = Modifier
                        .fillMaxWidth()
                        .menuAnchor(MenuAnchorType.PrimaryNotEditable),
                    trailingIcon = {
                        ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded)
                    },
                )
                ExposedDropdownMenu(
                    expanded = expanded,
                    onDismissRequest = { expanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("Direct connection") },
                        onClick = {
                            expanded = false
                            onMachineSelected(null)
                        },
                    )
                    machineProfiles.forEach { profile ->
                        DropdownMenuItem(
                            text = {
                                Text("${profile.name.ifBlank { "Machine" }} - ${profile.baseUrl}")
                            },
                            onClick = {
                                expanded = false
                                onMachineSelected(profile.id)
                            },
                        )
                    }
                }
            }
            if (selectedMachine != null) {
                Text(
                    text = "Selected: ${selectedMachine.name} · ${selectedMachine.baseUrl}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                )
            }
        }
    }
}

@Composable
private fun SessionQuickPanel(
    isSecure: Boolean,
    tokenLoaded: Boolean,
    currentSession: String?,
    connectionState: ConnectionState,
    turnPhase: TurnPhase,
    availableTargets: List<String>,
    targetName: String,
    playbackEnabled: Boolean,
    onTargetChanged: (String) -> Unit,
    onApplyTarget: () -> Unit,
    isBusy: Boolean,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Session target", style = MaterialTheme.typography.titleMedium)
            Text(
                text = buildString {
                    append("Session: ")
                    append(currentSession ?: "unknown")
                    append(" · ")
                    append(if (isSecure && tokenLoaded) "secure and authenticated" else "setup needed")
                    append(" · status ")
                    append(connectionState.label())
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            if (availableTargets.isNotEmpty()) {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    items(availableTargets.take(8)) { target ->
                        FilterChip(
                            selected = target == targetName,
                            onClick = { onTargetChanged(target) },
                            label = { Text(target, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        )
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = targetName,
                    onValueChange = onTargetChanged,
                    label = { Text("Target agent or session") },
                    placeholder = { Text("pi, claude, codex, /session/name") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
                Button(onClick = onApplyTarget, enabled = !isBusy) {
                    Text("Apply")
                }
                TextButton(onClick = { onTargetChanged("") }) {
                    Text("Current")
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill("Mode", if (playbackEnabled) "audio replies" else "text only", playbackEnabled, Modifier.weight(1f))
                StatusPill("Turn state", turnPhase.label(), turnPhase != TurnPhase.Idle, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun GuidancePanel(
    needsSetup: Boolean,
    uiState: MainUiState,
    quickReady: Boolean,
) {
    val (title, body, color) = when {
        needsSetup -> Triple(
            "Setup required",
            "Use `/remote setup` on your machine or use the fields above, then connect.",
            MaterialTheme.colorScheme.tertiary.copy(alpha = 0.18f),
        )
        uiState.isBusy -> Triple(
            "Working",
            "Request sent. A response is processing. Keep voice nearby and continue talking if needed.",
            MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.65f),
        )
        uiState.isRecording -> Triple(
            "Recording",
            "You are live. Speak your instruction clearly and tap again to send.",
            MaterialTheme.colorScheme.primaryContainer,
        )
        quickReady -> Triple(
            "Ready",
            "Use the big orb for voice turns or the text box for longer prompts.",
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.75f),
        )
        else -> Triple(
            "Connection status",
            "Tap refresh if status is stale or if the server changed while running.",
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f),
        )
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
        color = color,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                text = body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.78f),
            )
        }
    }
}

@Composable
private fun VoicePanel(
    isBusy: Boolean,
    isRecording: Boolean,
    onRecordToggle: () -> Unit,
    disabledReason: String?,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Voice turn", style = MaterialTheme.typography.titleLarge)
            Text(
                text = when {
                    disabledReason != null -> disabledReason
                    isBusy -> "Working on your last turn..."
                    isRecording -> "Recording now. Tap again to send."
                    else -> "One-tap interaction: speak, then send."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f),
            )
            VoiceOrbButton(
                isRecording = isRecording,
                isBusy = isBusy,
                disabledReason = disabledReason,
                onClick = onRecordToggle,
            )
        }
    }
}

@Composable
private fun VoiceOrbButton(
    isRecording: Boolean,
    isBusy: Boolean,
    disabledReason: String?,
    onClick: () -> Unit,
) {
    val enabled = disabledReason == null
    val scale by animateFloatAsState(
        targetValue = if (isRecording) 1.02f else 1f,
        animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing),
        label = "voice-scale",
    )
    val transition = rememberInfiniteTransition(label = "voice-pulse")
    val pulse by transition.animateFloat(
        initialValue = 0.92f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1500, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "voice-pulse",
    )
    val outerBrush = Brush.radialGradient(
        colors = if (isRecording) {
            listOf(Color(0x33F06B3C), Color(0x12C24A27), Color.Transparent)
        } else {
            listOf(Color(0x1A173B56), Color(0x0D193A52), Color.Transparent)
        },
    )
    val buttonBrush = Brush.linearGradient(
        colors = if (isRecording) {
            listOf(Color(0xFFF18B6A), Color(0xFFE05B2F), Color(0xFF7F3425))
        } else {
            listOf(Color(0xFFF0E7D9), Color(0xFFE3D7C6), Color(0xFFD8CAB7))
        },
    )

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(248.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(240.dp)
                .scale(if (isRecording) pulse else 1f)
                .clip(androidx.compose.foundation.shape.CircleShape)
                .background(outerBrush),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(202.dp)
                .graphicsLayer(scaleX = scale, scaleY = scale)
                .clip(VoiceShape)
                .background(buttonBrush)
                .border(
                    1.dp,
                    if (isRecording) Color(0x33FFF7F1) else Color(0x33FFFFFF),
                    VoiceShape,
                )
                .clickable(enabled = enabled && !isBusy, onClick = onClick)
                .padding(horizontal = 28.dp, vertical = 22.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.Start,
        ) {
            Surface(
                shape = androidx.compose.foundation.shape.CircleShape,
                color = if (isRecording) Color(0x26FFFFFF) else Color(0x80FFFFFF),
            ) {
                Icon(
                    imageVector = if (isRecording) Icons.Default.GraphicEq else Icons.Default.Mic,
                    contentDescription = null,
                    tint = if (isRecording) Color.White else Color(0xFF23405A),
                    modifier = Modifier.padding(18.dp),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = if (isRecording) "Send turn" else "Tap to talk",
                    style = MaterialTheme.typography.displayMedium,
                    color = if (isRecording) Color.White else Color(0xFF17324B),
                    maxLines = 1,
                )
                Text(
                    text = when {
                        isBusy -> "Working..."
                        isRecording -> "Recording in progress"
                        else -> "Best for quick notes and meeting follow-up"
                    },
                    style = MaterialTheme.typography.titleMedium,
                    color = if (isRecording) Color(0xFFFBE8E0) else Color(0xB317324B),
                )
            }
        }
    }
}

@Composable
private fun ReplyPanel(
    transcript: String,
    replyText: String,
    audioAvailable: Boolean,
    playbackState: PlaybackState,
    onPlayAudio: () -> Unit,
    onStopAudio: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Turn result", style = MaterialTheme.typography.titleLarge)
            ResultBlock("Transcript", transcript.ifBlank { "No transcript yet." }, transcript.isBlank())
            ResultBlock("Reply", replyText.ifBlank { "No reply yet." }, replyText.isBlank())
            if (audioAvailable) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = onPlayAudio, enabled = playbackState != PlaybackState.Loading) {
                        Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            when (playbackState) {
                                PlaybackState.Loading -> "Loading audio"
                                PlaybackState.Playing -> "Replay"
                                PlaybackState.Failed -> "Retry audio"
                                PlaybackState.Idle -> "Play reply"
                            },
                        )
                    }
                    if (playbackState == PlaybackState.Playing || playbackState == PlaybackState.Loading) {
                        OutlinedButton(onClick = onStopAudio) {
                            Text("Stop")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RecentTurnsPanel(
    recentTurns: List<RecentTurnUiState>,
    latestAudioAvailable: Boolean,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Conversation log", style = MaterialTheme.typography.titleLarge)
            if (recentTurns.isEmpty()) {
                Text(
                    text = "Recent turns will appear here so you can review context before your next instruction.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
                )
            } else {
                recentTurns.forEachIndexed { index, turn ->
                    RecentTurnCard(turn = turn, emphasizeLatest = index == 0 && latestAudioAvailable)
                }
            }
        }
    }
}

@Composable
private fun RecentTurnCard(
    turn: RecentTurnUiState,
    emphasizeLatest: Boolean,
) {
    Surface(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
        color = if (emphasizeLatest) {
            MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f)
        } else {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)
        },
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "${turn.source} · ${turn.routeLabel}",
                    style = MaterialTheme.typography.titleSmall,
                )
                if (turn.hasAudio) {
                    Icon(
                        imageVector = Icons.Default.HeadsetMic,
                        contentDescription = "Audio available",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            Text(
                text = "Heard: ${turn.transcript}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.82f),
            )
            Text(
                text = "Reply: ${turn.replyText}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.82f),
            )
        }
    }
}

@Composable
private fun TextFallbackPanel(
    textPrompt: String,
    onTextChanged: (String) -> Unit,
    onSendText: () -> Unit,
    onCommit: () -> Unit,
    needsSetup: Boolean,
    enabled: Boolean,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Text fallback", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "Longer context or noisy environments? Use text.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            OutlinedTextField(
                value = textPrompt,
                onValueChange = onTextChanged,
                label = { Text("Tell me what to do next") },
                placeholder = { Text("Summarize this meeting in your own words.") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 4,
                enabled = !needsSetup,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Send,
                ),
            )
            Button(onClick = onCommit, enabled = enabled && textPrompt.isNotBlank()) {
                Text("Send text")
            }
        }
    }
}

@Composable
private fun ErrorPanel(
    message: String,
    onDismiss: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
        color = Color(0xFFFBE9E2),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x33D35A30)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Connection issue",
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF9B3517),
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF7B2A12),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onDismiss) {
                    Text("Dismiss")
                }
                if (message.contains("Microphone", ignoreCase = true)) {
                    OutlinedButton(onClick = onOpenAppSettings) {
                        Text("App settings")
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusPill(
    label: String,
    value: String,
    strong: Boolean,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
        color = if (strong) {
            MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.75f)
        } else {
            MaterialTheme.colorScheme.surface.copy(alpha = 0.9f)
        },
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (strong) MaterialTheme.colorScheme.secondary.copy(alpha = 0.2f)
            else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
            Text(
                text = value,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ResultBlock(
    label: String,
    text: String,
    muted: Boolean,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = label.uppercase(),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.58f),
        )
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (muted) 0.6f else 0.94f),
        )
    }
}

private fun ConnectionState.label(): String = when (this) {
    ConnectionState.Unknown -> "Checking"
    ConnectionState.Connected -> "Connected"
    ConnectionState.Unauthorized -> "Token"
    ConnectionState.Offline -> "Offline"
    ConnectionState.Misconfigured -> "Setup"
}

private fun TurnPhase.label(): String = when (this) {
    TurnPhase.Idle -> "Idle"
    TurnPhase.Recording -> "Recording"
    TurnPhase.Uploading -> "Uploading"
    TurnPhase.Waiting -> "Waiting"
    TurnPhase.Complete -> "Done"
    TurnPhase.Failed -> "Failed"
}
