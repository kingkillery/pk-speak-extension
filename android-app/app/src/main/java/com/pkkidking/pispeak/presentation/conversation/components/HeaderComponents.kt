package com.pkkidking.pispeak.presentation.conversation.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.TurnPhase
import com.pkkidking.pispeak.presentation.main.PanelShape
import com.pkkidking.pispeak.presentation.main.label

@Composable
internal fun WalkieHeader(
    needsSetup: Boolean,
    statusSummary: String,
    machineName: String,
    currentSession: String?,
    targetLabel: String,
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
    val showDetails = remember { androidx.compose.runtime.mutableStateOf(false) }
    val connectionHint = when {
        needsSetup -> "Add base URL + token to connect."
        trustedConnection && connectionState == ConnectionState.Connected -> "Connected"
        else -> securityLabel
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
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text = "Status",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                )
                Text(
                    text = statusSummary,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = "$machineName | $targetLabel | $connectionHint",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (showDetails.value) {
                    Text(
                        text = listOfNotNull(
                            "Connection ${connectionState.label()}",
                            "Turn ${turnPhase.label()}",
                            replyModeLabel.takeIf { it.isNotBlank() }?.let { "Replies $it" },
                            speakProvider?.takeIf { speakEnabled }?.let { "Speak $it" } ?: "Speak off",
                            currentSession?.takeIf { it.isNotBlank() }?.let { "Session $it" },
                            securityLabel.takeIf { !trustedConnection && !needsSetup },
                        ).joinToString(" | "),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { showDetails.value = !showDetails.value }) {
                    Text(if (showDetails.value) "Hide" else "Details")
                }
                IconButton(
                    onClick = onRefresh,
                    enabled = connectionState != ConnectionState.Connected,
                ) {
                    Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                }
                IconButton(onClick = onOpenSettings) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings")
                }
            }
        }
    }
}

@Composable
internal fun StatusPill(
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
