package com.pkkidking.pispeak.presentation.conversation.components

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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import com.pkkidking.pispeak.presentation.common.PlaybackState
import com.pkkidking.pispeak.presentation.common.RecentTurnUiState
import com.pkkidking.pispeak.presentation.main.ControlShape
import com.pkkidking.pispeak.presentation.main.PanelShape
import com.pkkidking.pispeak.presentation.main.VoiceShape

@Composable
internal fun VoicePanel(
    isBusy: Boolean,
    isRecording: Boolean,
    nextTurnHint: String,
    replyModeLabel: String,
    onRecordToggle: () -> Unit,
    disabledReason: String?,
) {
    val enabled = disabledReason == null && !isBusy

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                shape = androidx.compose.foundation.shape.RoundedCornerShape(4.dp),
                color = if (isRecording) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            ) {
                Icon(
                    imageVector = if (isRecording) Icons.Default.GraphicEq else Icons.Default.Mic,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.padding(5.dp).size(18.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = "Conversation mode",
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = disabledReason ?: when {
                        isBusy -> "Working on the last turn"
                        isRecording -> "Listening now"
                        else -> replyModeLabel
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.66f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Button(
                onClick = onRecordToggle,
                enabled = enabled,
                shape = VoiceShape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isRecording) MaterialTheme.colorScheme.error else Color(0xFFC95432),
                    contentColor = Color.White,
                ),
                modifier = Modifier
                    .width(116.dp)
                    .height(58.dp),
            ) {
                Text(if (isRecording) "Send" else "Talk")
            }
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
internal fun ReplyPanel(
    modifier: Modifier = Modifier,
    transcript: String,
    replyText: String,
    recentTurns: List<RecentTurnUiState>,
    statusSummary: String,
    securityLabel: String,
    audioAvailable: Boolean,
    playbackState: PlaybackState,
    replyModeLabel: String,
    replyModeHint: String,
    onPlayAudio: () -> Unit,
    onStopAudio: () -> Unit,
) {
    val hasLatestTurn = transcript.isNotBlank() || replyText.isNotBlank()
    val hasConversation = hasLatestTurn || recentTurns.isNotEmpty()

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (!hasConversation) {
                    Surface(
                        shape = ControlShape,
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.28f),
                        border = androidx.compose.foundation.BorderStroke(
                            1.dp,
                            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
                        ),
                    ) {
                        Text(
                            text = "Ready when the gateway is connected.",
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
                        )
                    }
                } else {
                    if (hasLatestTurn) {
                        if (transcript.isNotBlank()) {
                            MessageBubble(
                                label = "You",
                                text = transcript,
                                muted = false,
                                fromAgent = false,
                            )
                        }
                        if (replyText.isNotBlank()) {
                            MessageBubble(
                                label = "Agent",
                                text = replyText,
                                muted = false,
                                fromAgent = true,
                            )
                        }
                    }
                    recentTurns.forEach { turn ->
                        if (turn.transcript.isNotBlank()) {
                            MessageBubble(
                                label = "You",
                                text = turn.transcript,
                                muted = false,
                                fromAgent = false,
                            )
                        }
                        if (turn.replyText.isNotBlank()) {
                            MessageBubble(
                                label = "Agent",
                                text = turn.replyText,
                                muted = false,
                                fromAgent = true,
                            )
                        }
                    }
                }
            }
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
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = statusSummary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.78f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val showHint = securityLabel != "Secure (https)" && securityLabel != "Local LAN" && securityLabel != "Tailscale" && securityLabel != "Bluetooth link"
                if (showHint) {
                    Text(
                        text = "$securityLabel. ${if (audioAvailable) replyModeLabel else replyModeHint}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
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
internal fun TextFallbackPanel(
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
        Row(
            modifier = Modifier.padding(10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = textPrompt,
                onValueChange = onTextChanged,
                placeholder = { Text("Message your agent...") },
                modifier = Modifier
                    .weight(1f)
                    .height(72.dp),
                minLines = 2,
                maxLines = 4,
                enabled = !needsSetup,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Send,
                ),
            )
            Button(
                onClick = onCommit,
                enabled = enabled && textPrompt.isNotBlank(),
                shape = ControlShape,
                modifier = Modifier
                    .width(96.dp)
                    .height(72.dp),
            ) {
                Text("Send")
            }
        }
    }
}

@Composable
internal fun ErrorPanel(
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
