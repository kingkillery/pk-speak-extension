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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.LAN_MSI_IP
import com.pkkidking.pispeak.domain.model.MachineProfile

private val ScreenPadding = 20.dp
private val PanelShape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)
private val ControlShape = androidx.compose.foundation.shape.RoundedCornerShape(16.dp)
private val VoiceShape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp)

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun ConversationScreen(
    uiState: MainUiState,
    contentPadding: PaddingValues,
    expandedLayout: Boolean = false,
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
    val needsSetup = uiState.needsSetup
    val isSecure = remember(uiState.baseUrl) { uiState.baseUrl.trim().startsWith("https://") }
    val isApprovedLan = remember(uiState.baseUrl) { uiState.baseUrl.contains(LAN_MSI_IP) }
    val trustedConnection = isSecure || isApprovedLan || uiState.connectionMode == ConnectionMode.TAILSCALE || uiState.connectionMode == ConnectionMode.BLUETOOTH
    val securityLabel = when {
        needsSetup -> "Setup required"
        isSecure -> "Secure (https)"
        isApprovedLan -> "Local LAN"
        uiState.connectionMode == ConnectionMode.TAILSCALE -> "Tailscale"
        uiState.connectionMode == ConnectionMode.BLUETOOTH -> "Bluetooth link"
        else -> "HTTPS preferred"
    }
    val focusManager = LocalFocusManager.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = if (expandedLayout) 32.dp else ScreenPadding, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        WalkieHeader(
            needsSetup = needsSetup,
            machineName = uiState.connection.selectedMachineName,
            currentSession = uiState.currentSession,
            routeLabel = uiState.targetName.ifBlank { uiState.currentSession ?: "Current" },
            securityLabel = securityLabel,
            trustedConnection = trustedConnection,
            speakProvider = uiState.speakProvider,
            speakEnabled = uiState.speakEnabled,
            replyModeLabel = uiState.replyModeLabel(),
            replyModeHint = uiState.replyModeHint(),
            nextTurnHint = uiState.nextTurnHint(),
            connectionState = uiState.connectionState,
            turnPhase = uiState.turnPhase,
            onRefresh = onRefresh,
            onOpenSettings = onOpenSettings,
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
        }

        if (uiState.error != null) {
            ErrorPanel(
                message = uiState.error,
                onDismiss = onDismissError,
                onOpenAppSettings = onOpenAppSettings,
            )
        }

        ReplyPanel(
            transcript = uiState.transcript,
            replyText = uiState.replyText,
            audioAvailable = uiState.audioUrl != null,
            playbackState = uiState.playbackState,
            replyModeLabel = uiState.replyModeLabel(),
            replyModeHint = uiState.replyModeHint(),
            onPlayAudio = onPlayAudio,
            onStopAudio = onStopAudio,
        )

        RecentTurnsPanel(
            recentTurns = uiState.recentTurns,
            latestAudioAvailable = uiState.audioUrl != null,
        )

        VoicePanel(
            isBusy = uiState.isBusy,
            isRecording = uiState.isRecording,
            nextTurnHint = uiState.nextTurnHint(),
            replyModeLabel = uiState.replyModeLabel(),
            onRecordToggle = onRecordToggle,
            disabledReason = if (needsSetup) "Connect to a machine first to send voice turns." else null,
        )

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
    }
}

@Composable
private fun WalkieHeader(
    needsSetup: Boolean,
    machineName: String,
    currentSession: String?,
    routeLabel: String,
    securityLabel: String,
    trustedConnection: Boolean,
    speakProvider: String?,
    speakEnabled: Boolean,
    replyModeLabel: String,
    replyModeHint: String,
    nextTurnHint: String,
    connectionState: ConnectionState,
    turnPhase: TurnPhase,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
) {
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
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text("Talk", style = MaterialTheme.typography.titleMedium)
                    Text(
                        text = "$machineName / ${currentSession ?: "unknown"} / $routeLabel",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                OutlinedButton(onClick = onOpenSettings) {
                    Icon(Icons.Default.Settings, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Settings")
                }
            }
            Text(
                text = if (needsSetup) "Connect this phone to start." else nextTurnHint,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill(
                    label = "Connection",
                    value = connectionState.label(),
                    strong = trustedConnection,
                    modifier = Modifier.weight(1f),
                )
                StatusPill(
                    label = "Replies",
                    value = replyModeLabel,
                    strong = replyModeLabel == "Hands-free" || replyModeLabel == "Loop on",
                    modifier = Modifier.weight(1f),
                )
                StatusPill(
                    label = "Turn",
                    value = turnPhase.label(),
                    strong = turnPhase == TurnPhase.Waiting || turnPhase == TurnPhase.Recording,
                    modifier = Modifier.weight(1f),
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "$securityLabel. $replyModeHint",
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                OutlinedButton(
                    onClick = onRefresh,
                    enabled = connectionState != ConnectionState.Connected,
                ) {
                    Icon(Icons.Default.Refresh, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Refresh")
                }
            }
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
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Next,
                ),
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
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Next,
                ),
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

@Composable
private fun MachinePickerPanel(
    machineProfiles: List<MachineProfile>,
    selectedMachineId: String?,
    onMachineSelected: (String?) -> Unit,
) {
    val selectedMachine = machineProfiles.firstOrNull { it.id == selectedMachineId }
    val selectedMachineLabel = selectedMachine?.name ?: "Manual connection"
    val selectedEndpoint = selectedMachine?.baseUrl ?: "Manual gateway"

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
            Text("Machine selector", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "Choose the machine this phone should control.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item {
                    FilterChip(
                        selected = selectedMachine == null,
                        onClick = { onMachineSelected(null) },
                        label = { Text("Manual") },
                    )
                }
                items(machineProfiles, key = { it.id }) { profile ->
                    FilterChip(
                        selected = profile.id == selectedMachineId,
                        onClick = { onMachineSelected(profile.id) },
                        label = {
                            Text(
                                text = profile.name.ifBlank { "Machine" },
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                    )
                }
            }
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(18.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
                border = androidx.compose.foundation.BorderStroke(
                    1.dp,
                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
                ),
            ) {
                Column(
                    modifier = Modifier.padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = selectedMachineLabel,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        text = selectedEndpoint,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.78f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (selectedMachine?.token.isNullOrBlank()) {
                        Text(
                            text = "Add the remote token once for this machine in Settings.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionQuickPanel(
    connectionTrusted: Boolean,
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
                    append(if (connectionTrusted && tokenLoaded) "ready and authenticated" else "setup needed")
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
            uiState.nextTurnHint(),
            MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.65f),
        )
        uiState.isRecording -> Triple(
            "Recording",
            uiState.nextTurnHint(),
            MaterialTheme.colorScheme.primaryContainer,
        )
        quickReady -> Triple(
            "Ready",
            uiState.nextTurnHint(),
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
        shape = PanelShape,
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
    nextTurnHint: String,
    replyModeLabel: String,
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Conversation", style = MaterialTheme.typography.titleLarge)
                Text(
                    text = replyModeLabel,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Text(
                text = when {
                    disabledReason != null -> disabledReason
                    else -> nextTurnHint
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
            listOf(MaterialTheme.colorScheme.error.copy(alpha = 0.18f), Color.Transparent)
        } else {
            listOf(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), Color.Transparent)
        },
    )
    val buttonBrush = Brush.linearGradient(
        colors = if (isRecording) {
            listOf(MaterialTheme.colorScheme.error, MaterialTheme.colorScheme.tertiary)
        } else {
            listOf(MaterialTheme.colorScheme.tertiary, MaterialTheme.colorScheme.tertiaryContainer)
        },
    )

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(180.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(156.dp)
                .scale(if (isRecording) pulse else 1f)
                .clip(androidx.compose.foundation.shape.CircleShape)
                .background(outerBrush),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(152.dp)
                .graphicsLayer(scaleX = scale, scaleY = scale)
                .clip(VoiceShape)
                .background(buttonBrush)
                .border(
                    1.dp,
                    if (isRecording) Color(0x33FFF7F1) else Color(0x33FFFFFF),
                    VoiceShape,
                )
                .clickable(enabled = enabled && !isBusy, onClick = onClick)
                .padding(horizontal = 24.dp, vertical = 18.dp),
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
                    tint = if (isRecording) Color.White else MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(18.dp),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = if (isRecording) "Send" else "Talk",
                    style = MaterialTheme.typography.headlineMedium,
                    color = if (isRecording) Color.White else MaterialTheme.colorScheme.primary,
                    maxLines = 1,
                )
                Text(
                    text = when {
                        isBusy -> "Working..."
                        isRecording -> "Listening now"
                        else -> "Start a turn"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (isRecording) Color(0xFFFBE8E0) else MaterialTheme.colorScheme.primary.copy(alpha = 0.72f),
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
    replyModeLabel: String,
    replyModeHint: String,
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Latest turn", style = MaterialTheme.typography.titleLarge)
                Text(
                    text = replyModeLabel,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            MessageBubble(
                label = "You",
                text = transcript.ifBlank { "Nothing heard yet." },
                muted = transcript.isBlank(),
                fromAgent = false,
            )
            MessageBubble(
                label = "Agent",
                text = replyText.ifBlank { "The next reply will appear here and play aloud when audio is available." },
                muted = replyText.isBlank(),
                fromAgent = true,
            )
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
            } else {
                Text(
                    text = replyModeHint,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.64f),
                )
            }
        }
    }
}

@Composable
private fun MessageBubble(
    label: String,
    text: String,
    muted: Boolean,
    fromAgent: Boolean,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalAlignment = if (fromAgent) Alignment.Start else Alignment.End,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.58f),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth(if (fromAgent) 0.92f else 0.86f)
                .clip(ControlShape)
                .background(
                    if (fromAgent) {
                        MaterialTheme.colorScheme.primaryContainer.copy(alpha = if (muted) 0.38f else 0.7f)
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (muted) 0.35f else 0.65f)
                    },
                )
                .border(
                    1.dp,
                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
                    ControlShape,
                )
                .padding(14.dp),
        ) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (muted) 0.58f else 0.94f),
            )
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
        shape = PanelShape,
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
                    text = "${turn.source} - ${turn.routeLabel} - ${turn.status.label}",
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
            Text("Type instead", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "Use this when the thought is longer than a quick voice turn.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            OutlinedTextField(
                value = textPrompt,
                onValueChange = onTextChanged,
                label = { Text("Tell me what to do next") },
                placeholder = { Text("Keep the last answer in mind and continue...") },
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
        shape = PanelShape,
        color = MaterialTheme.colorScheme.errorContainer,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.22f)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Connection issue",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.error,
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
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
