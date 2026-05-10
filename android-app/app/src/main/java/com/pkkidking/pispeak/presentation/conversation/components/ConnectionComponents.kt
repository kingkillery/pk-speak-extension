package com.pkkidking.pispeak.presentation.conversation.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.TurnPhase
import com.pkkidking.pispeak.presentation.main.ConversationScreenState
import com.pkkidking.pispeak.presentation.main.PanelShape
import com.pkkidking.pispeak.presentation.main.label
import com.pkkidking.pispeak.presentation.main.isBusy
import com.pkkidking.pispeak.presentation.main.nextTurnHint

@Composable
internal fun OnboardingPanel(
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
                    androidx.compose.foundation.layout.Spacer(Modifier.width(6.dp))
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
    uiState: ConversationScreenState,
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
        uiState.turn.isRecording -> Triple(
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
