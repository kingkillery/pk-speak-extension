package com.pkkidking.pispeak.presentation.conversation.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HeadsetMic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.presentation.common.RecentTurnUiState
import com.pkkidking.pispeak.presentation.main.PanelShape

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
                    text = "${turn.source} | ${turn.status.label}",
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
