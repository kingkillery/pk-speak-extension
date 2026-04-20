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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val ScreenPadding = 20.dp
private val PanelShape = RoundedCornerShape(28.dp)
private val VoiceShape = RoundedCornerShape(40.dp)

@Composable
fun ConversationScreen(
    uiState: MainUiState,
    contentPadding: PaddingValues,
    onTargetChanged: (String) -> Unit,
    onApplyTarget: () -> Unit,
    onRefresh: () -> Unit,
    onTextChanged: (String) -> Unit,
    onSendText: () -> Unit,
    onRecordToggle: () -> Unit,
    onPlayAudio: () -> Unit,
    onDismissError: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val isSecure = remember(uiState.baseUrl) { uiState.baseUrl.trim().startsWith("https://") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ScreenPadding, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        HeroSection(
            statusSummary = uiState.statusSummary,
            secure = isSecure,
            tokenLoaded = uiState.token.isNotBlank(),
            requestAudioReplies = uiState.requestAudioReplies,
            onRefresh = onRefresh,
            onOpenSettings = onOpenSettings,
        )

        TargetPanel(
            targetName = uiState.targetName,
            currentSession = uiState.currentSession,
            availableTargets = uiState.availableTargets,
            isBusy = uiState.isBusy,
            onTargetChanged = onTargetChanged,
            onApplyTarget = onApplyTarget,
        )

        if (uiState.error != null) {
            ErrorPanel(
                message = uiState.error,
                onDismiss = onDismissError,
            )
        }

        VoicePanel(
            isBusy = uiState.isBusy,
            isRecording = uiState.isRecording,
            onRecordToggle = onRecordToggle,
        )

        ReplyPanel(
            transcript = uiState.transcript,
            replyText = uiState.replyText,
            audioAvailable = uiState.audioUrl != null,
            onPlayAudio = onPlayAudio,
        )

        TextFallbackPanel(
            textPrompt = uiState.textPrompt,
            onTextChanged = onTextChanged,
            onSendText = onSendText,
            enabled = !uiState.isBusy,
        )
    }
}

@Composable
private fun TargetPanel(
    targetName: String,
    currentSession: String?,
    availableTargets: List<String>,
    isBusy: Boolean,
    onTargetChanged: (String) -> Unit,
    onApplyTarget: () -> Unit,
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
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Talk to", style = MaterialTheme.typography.titleMedium)
            Text(
                text = buildString {
                    append("Current session: ")
                    append(currentSession ?: "unknown")
                    append(". Route target: ")
                    append(targetName.ifBlank { "current session" })
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            OutlinedTextField(
                value = targetName,
                onValueChange = onTargetChanged,
                label = { Text("Target agent or session") },
                placeholder = { Text("pi, hermes, claude, codex") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            if (availableTargets.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    availableTargets.take(4).forEach { target ->
                        OutlinedButton(
                            onClick = { onTargetChanged(target) },
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(target, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = onApplyTarget, enabled = !isBusy) {
                    Text("Apply target")
                }
                OutlinedButton(onClick = { onTargetChanged("") }, enabled = !isBusy) {
                    Text("Use current")
                }
            }
        }
    }
}

@Composable
private fun HeroSection(
    statusSummary: String,
    secure: Boolean,
    tokenLoaded: Boolean,
    requestAudioReplies: Boolean,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Surface(
            shape = RoundedCornerShape(999.dp),
            color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.65f),
        ) {
            Text(
                text = "PI SPEAK REMOTE",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 9.dp),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.74f),
            )
        }

        Text(
            text = "Keep Pi\nin your ear.",
            style = MaterialTheme.typography.displaySmall,
            color = MaterialTheme.colorScheme.onBackground,
            maxLines = 2,
        )

        Text(
            text = "A native walkie-talkie for Pi. Fast voice in, clean reply out, no dashboard clutter.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.78f),
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StatusPill(
                label = "Secure",
                value = if (secure) "Yes" else "No",
                strong = secure,
                modifier = Modifier.weight(1f),
            )
            StatusPill(
                label = "Auth",
                value = if (tokenLoaded) "Loaded" else "Needed",
                strong = tokenLoaded,
                modifier = Modifier.weight(1f),
            )
            StatusPill(
                label = "Audio",
                value = if (requestAudioReplies) "Reply on" else "Reply off",
                strong = requestAudioReplies,
                modifier = Modifier.weight(1f),
            )
        }

        Text(
            text = statusSummary,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.68f),
        )

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onRefresh) {
                Icon(Icons.Default.Refresh, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Refresh")
            }
            TextButton(onClick = onOpenSettings) {
                Icon(Icons.Default.Settings, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Open settings")
            }
        }
    }
}

@Composable
private fun VoicePanel(
    isBusy: Boolean,
    isRecording: Boolean,
    onRecordToggle: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
        ),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                text = "Voice turn",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = if (isRecording) "Recording live. Tap once to send the turn." else "One dominant control. Open the mic only when you want it.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f),
            )
            VoiceOrbButton(
                isRecording = isRecording,
                isBusy = isBusy,
                onClick = onRecordToggle,
            )
        }
    }
}

@Composable
private fun VoiceOrbButton(
    isRecording: Boolean,
    isBusy: Boolean,
    onClick: () -> Unit,
) {
    val scale by animateFloatAsState(
        targetValue = if (isRecording) 1.02f else 1f,
        animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing),
        label = "voice-scale",
    )
    val infinite = rememberInfiniteTransition(label = "voice-pulse")
    val pulse by infinite.animateFloat(
        initialValue = 0.92f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1500, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "voice-pulse-value",
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
            .height(290.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(284.dp)
                .scale(if (isRecording) pulse else 1f)
                .clip(CircleShape)
                .background(outerBrush),
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(250.dp)
                .graphicsLayer(scaleX = scale, scaleY = scale)
                .clip(VoiceShape)
                .background(buttonBrush)
                .border(
                    1.dp,
                    if (isRecording) Color(0x33FFF7F1) else Color(0x33FFFFFF),
                    VoiceShape,
                )
                .clickable(enabled = !isBusy, onClick = onClick)
                .padding(horizontal = 28.dp, vertical = 26.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.Start,
        ) {
            Surface(
                shape = CircleShape,
                color = if (isRecording) Color(0x26FFFFFF) else Color(0x80FFFFFF),
            ) {
                Icon(
                    imageVector = if (isRecording) Icons.Default.GraphicEq else Icons.Default.Mic,
                    contentDescription = null,
                    tint = if (isRecording) Color.White else Color(0xFF23405A),
                    modifier = Modifier.padding(18.dp),
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = if (isRecording) "Send turn" else "Tap to talk",
                    style = MaterialTheme.typography.displayMedium,
                    color = if (isRecording) Color.White else Color(0xFF17324B),
                    maxLines = 2,
                )
                Text(
                    text = when {
                        isBusy -> "Working on it"
                        isRecording -> "Mic is live"
                        else -> "Mic opens on demand"
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
    onPlayAudio: () -> Unit,
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

            ResultBlock(
                label = "Transcript",
                text = transcript.ifBlank { "No transcript yet." },
                muted = transcript.isBlank(),
            )

            ResultBlock(
                label = "Reply",
                text = replyText.ifBlank { "No reply yet." },
                muted = replyText.isBlank(),
            )

            if (audioAvailable) {
                OutlinedButton(onClick = onPlayAudio) {
                    Icon(Icons.Default.VolumeUp, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Play reply audio")
                }
            }
        }
    }
}

@Composable
private fun ResultBlock(
    label: String,
    text: String,
    muted: Boolean,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = label.uppercase(),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.58f),
        )
        Text(
            text = text,
            style = if (label == "Reply") MaterialTheme.typography.bodyLarge else MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (muted) 0.6f else 0.94f),
        )
    }
}

@Composable
private fun TextFallbackPanel(
    textPrompt: String,
    onTextChanged: (String) -> Unit,
    onSendText: () -> Unit,
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
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Text fallback", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "For long prompts, quiet rooms, or flaky microphones.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )
            OutlinedTextField(
                value = textPrompt,
                onValueChange = onTextChanged,
                label = { Text("Ask Pi something") },
                placeholder = { Text("Summarize the latest change set...") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 4,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Default,
                ),
            )
            Button(onClick = onSendText, enabled = enabled && textPrompt.isNotBlank()) {
                Text("Send text")
            }
        }
    }
}

@Composable
private fun ErrorPanel(
    message: String,
    onDismiss: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        color = Color(0xFFFBE9E2),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x33D35A30)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Couldn't reach Pi",
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF9B3517),
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF7B2A12),
            )
            TextButton(onClick = onDismiss) { Text("Dismiss") }
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
    val container = if (strong) {
        MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.78f)
    } else {
        MaterialTheme.colorScheme.surface.copy(alpha = 0.9f)
    }
    val outline = if (strong) {
        MaterialTheme.colorScheme.secondary.copy(alpha = 0.18f)
    } else {
        MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)
    }

    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(24.dp),
        color = container,
        border = androidx.compose.foundation.BorderStroke(1.dp, outline),
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
