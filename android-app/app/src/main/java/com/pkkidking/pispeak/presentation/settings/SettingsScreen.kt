package com.pkkidking.pispeak.presentation.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.data.storage.ThemeMode
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.presentation.main.MainUiState

private val ScreenPadding = 20.dp
private val PanelShape = RoundedCornerShape(8.dp)
private val ControlShape = RoundedCornerShape(16.dp)

@Composable
fun SettingsScreen(
    uiState: MainUiState,
    themeMode: ThemeMode,
    contentPadding: PaddingValues,
    onBaseUrlChanged: (String) -> Unit,
    onTokenChanged: (String) -> Unit,
    onConnectionModeChanged: (ConnectionMode) -> Unit,
    onWorkspacePathChanged: (String) -> Unit,
    machineProfiles: List<MachineProfile>,
    selectedMachineId: String?,
    machineProfileName: String,
    onMachineSelected: (String?) -> Unit,
    onMachineProfileNameChanged: (String) -> Unit,
    onSaveMachineProfile: () -> Unit,
    onDeleteSelectedMachine: () -> Unit,
    onTargetChanged: (String) -> Unit,
    onApplyTarget: () -> Unit,
    onRequestAudioChanged: (Boolean) -> Unit,
    onAutoplayChanged: (Boolean) -> Unit,
    onContinuousConversationChanged: (Boolean) -> Unit,
    onSaveSettings: () -> Unit,
    onThemeModeChanged: (ThemeMode) -> Unit,
    onDismissError: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ScreenPadding, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = PanelShape,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)),
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("Connection", style = MaterialTheme.typography.titleLarge)
                Text(
                    text = "Choose how the phone reaches the gateway, then save the URL and token for that machine.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )

                ConnectionModeSelector(
                    selected = uiState.connectionMode,
                    onSelected = onConnectionModeChanged,
                )

                MachineProfileSection(
                    machineProfiles = machineProfiles,
                    selectedMachineId = selectedMachineId,
                    machineProfileName = machineProfileName,
                    baseUrl = uiState.baseUrl,
                    token = uiState.token,
                    workspacePath = uiState.workspacePath,
                    onMachineSelected = onMachineSelected,
                    onMachineProfileNameChanged = onMachineProfileNameChanged,
                    onSaveMachineProfile = onSaveMachineProfile,
                    onDeleteSelectedMachine = onDeleteSelectedMachine,
                )

                OutlinedTextField(
                    value = uiState.baseUrl,
                    onValueChange = onBaseUrlChanged,
                    label = { Text("Base URL") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedTextField(
                    value = uiState.token,
                    onValueChange = onTokenChanged,
                    label = { Text("Remote token") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    trailingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
                )
                OutlinedTextField(
                    value = uiState.workspacePath,
                    onValueChange = onWorkspacePathChanged,
                    label = { Text("Launch path") },
                    placeholder = { Text("C:\\dev\\Desktop-Projects\\my-project") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Text(
                    text = "Optional working directory for agent turns started from this phone.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
                Button(onClick = onSaveSettings) {
                    Text("Save connection settings")
                }
            }
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = PanelShape,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)),
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("Routing", style = MaterialTheme.typography.titleLarge)
                Text(
                    text = "Choose which agent or session receives the next turn.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
                if (uiState.availableTargets.isNotEmpty()) {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(uiState.availableTargets.take(10)) { target ->
                            FilterChip(
                                selected = target == uiState.targetName,
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
                        value = uiState.targetName,
                        onValueChange = onTargetChanged,
                        label = { Text("Target") },
                        placeholder = { Text("Current session") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                    )
                    Button(onClick = onApplyTarget, enabled = !uiState.isBusy) {
                        Text("Apply")
                    }
                }
                TextButton(onClick = { onTargetChanged("") }) {
                    Text("Use current session")
                }
            }
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = PanelShape,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)),
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("Appearance", style = MaterialTheme.typography.titleLarge)
                Text(
                    text = "Choose whether Pi Speak follows the device or stays light or dark.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    ThemeMode.entries.forEach { mode ->
                        OutlinedButton(
                            onClick = { onThemeModeChanged(mode) },
                            border = BorderStroke(
                                1.dp,
                                if (themeMode == mode) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                            ),
                        ) {
                            Text(mode.label)
                        }
                    }
                }
            }
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = PanelShape,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)),
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("Audio behavior", style = MaterialTheme.typography.titleLarge)
                SettingRow("Request spoken replies", uiState.requestAudioReplies, onRequestAudioChanged)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                SettingRow("Autoplay reply audio", uiState.autoplayReplyAudio, onAutoplayChanged)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                SettingRow(
                    label = "Continue after replies",
                    checked = uiState.continuousConversation,
                    onCheckedChange = onContinuousConversationChanged,
                    enabled = uiState.requestAudioReplies && uiState.autoplayReplyAudio,
                    supportingText = "After a spoken voice reply finishes, Pi Speak waits a moment and starts listening again.",
                )
            }
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = PanelShape,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)),
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("Diagnostics", style = MaterialTheme.typography.titleLarge)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    StateBadge("Connection", uiState.connectionState.name, Modifier.weight(1f))
                    StateBadge("Turn", uiState.turnPhase.name, Modifier.weight(1f))
                    StateBadge("Audio", uiState.playbackState.name, Modifier.weight(1f))
                }
                if (uiState.diagnostics.isEmpty()) {
                    Text(
                        text = "No events yet.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                } else {
                    uiState.diagnostics.forEach { event ->
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = event.area.uppercase(),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Text(
                                text = event.message,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.78f),
                            )
                        }
                    }
                }
            }
        }

        if (uiState.error != null) {
            ErrorPanel(
                message = uiState.error,
                onDismiss = onDismissError,
            )
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun MachineProfileSection(
    machineProfiles: List<MachineProfile>,
    selectedMachineId: String?,
    machineProfileName: String,
    baseUrl: String,
    token: String,
    workspacePath: String,
    onMachineSelected: (String?) -> Unit,
    onMachineProfileNameChanged: (String) -> Unit,
    onSaveMachineProfile: () -> Unit,
    onDeleteSelectedMachine: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val selectedMachine = machineProfiles.firstOrNull { it.id == selectedMachineId }
    val selectedMachineLabel = selectedMachine?.name ?: "Manual connection"
    val hasProfiles = machineProfiles.isNotEmpty()
    val canSave = baseUrl.isNotBlank() && (selectedMachine != null || machineProfileName.isNotBlank())
    val hasWorkspace = workspacePath.isNotBlank()

    Surface(
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Machine profiles", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "Save one or more remote URLs and tokens so you can switch machines quickly.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
            )

            ExposedDropdownMenuBox(
                expanded = menuExpanded,
                onExpandedChange = { menuExpanded = !menuExpanded },
            ) {
                OutlinedTextField(
                    value = selectedMachineLabel,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Machine") },
                    modifier = Modifier
                        .fillMaxWidth()
                        .menuAnchor(MenuAnchorType.PrimaryNotEditable),
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = menuExpanded) },
                )
                ExposedDropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("Manual connection") },
                        onClick = {
                            menuExpanded = false
                            onMachineSelected(null)
                        },
                    )
                    machineProfiles.forEach { profile ->
                        DropdownMenuItem(
                            text = {
                                Text(
                                    text = "${profile.name.ifBlank { "Machine" }} - ${profile.connectionMode.label} - ${profile.baseUrl}",
                                    maxLines = 1,
                                )
                            },
                            onClick = {
                                menuExpanded = false
                                onMachineSelected(profile.id)
                            },
                        )
                    }
                }
            }

            if (hasProfiles) {
                Text(
                    text = "${machineProfiles.size} saved machine profile${if (machineProfiles.size != 1) "s" else ""}.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                )
            } else {
                Text(
                    text = "No saved machines yet.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                )
            }

            OutlinedTextField(
                value = machineProfileName,
                onValueChange = onMachineProfileNameChanged,
                label = { Text("Profile name") },
                placeholder = { Text("Living Room Pi") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            if (selectedMachine != null) {
                Text(
                    text = "Selected: ${selectedMachine.name} - ${selectedMachine.baseUrl}${if (hasWorkspace) " - ${selectedMachine.workspacePath}" else ""}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                )
                Text(
                    text = "Token is${if (selectedMachine.token.isNotBlank()) " " else " not "}saved for this profile.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = onSaveMachineProfile, enabled = canSave) {
                    Text(if (selectedMachine == null) "Save machine" else "Update selected")
                }
                if (selectedMachine != null) {
                    TextButton(onClick = onDeleteSelectedMachine) {
                        Text("Delete selected")
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionModeSelector(
    selected: ConnectionMode,
    onSelected: (ConnectionMode) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "Connection type",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ConnectionMode.entries.forEach { mode ->
                OutlinedButton(
                    onClick = { onSelected(mode) },
                    border = BorderStroke(
                        1.dp,
                        if (selected == mode) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                    ),
                ) {
                    Text(mode.label)
                }
            }
        }
        Text(
            text = when (selected) {
                ConnectionMode.TAILSCALE -> "Uses your tailnet or HTTPS tunnel profile."
                ConnectionMode.BLUETOOTH -> "Uses a paired Bluetooth local-link/PAN address; Tailscale is not required."
                ConnectionMode.MANUAL -> "Requires HTTPS unless this is a debug loopback build."
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.66f),
        )
    }
}

@Composable
private fun StateBadge(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = ControlShape,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f)),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
            )
            Text(
                text = value,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun SettingRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean = true,
    supportingText: String? = null,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.56f),
            )
            if (supportingText != null) {
                Text(
                    text = supportingText,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.66f),
                )
            }
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

@Composable
private fun ErrorPanel(
    message: String,
    onDismiss: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = PanelShape,
        color = MaterialTheme.colorScheme.errorContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.22f)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Needs attention",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.error,
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            OutlinedButton(onClick = onDismiss) {
                Text("Dismiss")
            }
        }
    }
}
