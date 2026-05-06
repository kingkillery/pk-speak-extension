package com.pkkidking.pispeak.presentation.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.data.storage.ThemeMode
import com.pkkidking.pispeak.domain.model.ConnectionProfileId
import com.pkkidking.pispeak.presentation.main.MainUiState

private val ScreenPadding = 20.dp
private val PanelShape = RoundedCornerShape(28.dp)

@Composable
fun SettingsScreen(
    uiState: MainUiState,
    themeMode: ThemeMode,
    contentPadding: PaddingValues,
    onBaseUrlChanged: (String) -> Unit,
    onTokenChanged: (String) -> Unit,
    onActiveProfileChanged: (String) -> Unit,
    onRequestAudioChanged: (Boolean) -> Unit,
    onAutoplayChanged: (Boolean) -> Unit,
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
                    text = "Pick the active machine, then edit that machine’s URL and token. Windows and Mac each keep their own saved connection.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )

                var expanded by remember { mutableStateOf(false) }
                val selectedProfile = ConnectionProfileId.fromKey(uiState.activeProfileId)
                Box(modifier = Modifier.fillMaxWidth()) {
                    OutlinedButton(
                        onClick = { expanded = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Active machine: ${selectedProfile.label}")
                        Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                    }
                    DropdownMenu(
                        expanded = expanded,
                        onDismissRequest = { expanded = false },
                    ) {
                        ConnectionProfileId.entries.forEach { profile ->
                            DropdownMenuItem(
                                text = { Text(profile.label) },
                                onClick = {
                                    expanded = false
                                    onActiveProfileChanged(profile.key)
                                },
                            )
                        }
                    }
                }

                OutlinedTextField(
                    value = uiState.baseUrl,
                    onValueChange = onBaseUrlChanged,
                    label = { Text("${selectedProfile.label} Base URL") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = uiState.token,
                    onValueChange = onTokenChanged,
                    label = { Text("${selectedProfile.label} remote token") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    trailingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
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
private fun SettingRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Switch(checked = checked, onCheckedChange = onCheckedChange)
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
        border = BorderStroke(1.dp, Color(0x33D35A30)),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Needs attention",
                style = MaterialTheme.typography.titleMedium,
                color = Color(0xFF9B3517),
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF7B2A12),
            )
            OutlinedButton(onClick = onDismiss) {
                Text("Dismiss")
            }
        }
    }
}
