package com.pkkidking.pispeak.presentation.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pkkidking.pispeak.data.storage.ThemeMode
import com.pkkidking.pispeak.presentation.audio.AudioEvent
import com.pkkidking.pispeak.presentation.audio.AudioViewModel
import com.pkkidking.pispeak.presentation.connection.ConnectionViewModel
import com.pkkidking.pispeak.presentation.main.ConversationScreen
import com.pkkidking.pispeak.presentation.main.ConversationScreenState
import com.pkkidking.pispeak.presentation.settings.SettingsScreen
import com.pkkidking.pispeak.presentation.turn.TurnViewModel
import com.pkkidking.pispeak.ui.theme.PiSpeakTheme

private enum class AppDestination(val label: String) {
    Conversation("Talk"),
    Settings("Settings"),
}

@androidx.compose.material3.ExperimentalMaterial3Api
@Composable
fun PiSpeakApp(
    bootstrapBaseUrl: String? = null,
    bootstrapToken: String? = null,
    bootstrapMachineId: String? = null,
    bootstrapProfileName: String? = null,
    bootstrapConnectionMode: String? = null,
    appViewModel: AppViewModel = hiltViewModel(),
    connectionViewModel: ConnectionViewModel = hiltViewModel(),
    turnViewModel: TurnViewModel = hiltViewModel(),
    audioViewModel: AudioViewModel = hiltViewModel(),
) {
    val themeMode by appViewModel.themeMode.collectAsStateWithLifecycle()
    val connectionUiState by connectionViewModel.uiState.collectAsStateWithLifecycle()
    val turnUiState by turnViewModel.uiState.collectAsStateWithLifecycle()
    val audioUiState by audioViewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val expandedLayout = LocalConfiguration.current.screenWidthDp >= 840
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            turnViewModel.startRecording()
        } else {
            turnViewModel.onMicrophonePermissionDenied()
        }
    }
    var currentDestination by rememberSaveable { mutableStateOf(AppDestination.Conversation) }

    LaunchedEffect(bootstrapBaseUrl, bootstrapToken, bootstrapMachineId, bootstrapProfileName, bootstrapConnectionMode) {
        connectionViewModel.applyBootstrap(
            baseUrl = bootstrapBaseUrl,
            token = bootstrapToken,
            machineId = bootstrapMachineId,
            profileName = bootstrapProfileName,
            connectionMode = bootstrapConnectionMode,
        )
    }

    // Cross-VM: audio rearm → start recording
    LaunchedEffect(Unit) {
        audioViewModel.events.collect { event ->
            when (event) {
                is AudioEvent.RequestStartRecording -> {
                    val granted = ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.RECORD_AUDIO,
                    ) == PackageManager.PERMISSION_GRANTED
                    if (granted) {
                        turnViewModel.startRecording()
                    } else {
                        permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }
            }
        }
    }

    // Cross-VM: turn completed → maybe autoplay
    LaunchedEffect(Unit) {
        turnViewModel.turnCompleted.collect { event ->
            audioViewModel.maybeAutoplay(
                audioUrl = event.result.audioUrl,
                baseUrl = connectionUiState.baseUrl,
                token = connectionUiState.token,
                rearmAfterPlayback = event.source == com.pkkidking.pispeak.domain.model.TurnSource.VOICE,
            )
        }
    }

    val conversationScreenState = ConversationScreenState(
        connection = connectionUiState,
        turn = turnUiState,
        audio = audioUiState,
    )

    PiSpeakTheme(
        darkTheme = when (themeMode) {
            ThemeMode.SYSTEM -> isSystemInDarkTheme()
            ThemeMode.LIGHT -> false
            ThemeMode.DARK -> true
        },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                    ),
                    title = {
                        Text(
                            text = "Pi Speak",
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                )
            },
            bottomBar = {
                if (!expandedLayout) {
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                        AppDestination.entries.forEach { destination ->
                            NavigationBarItem(
                                selected = currentDestination == destination,
                                onClick = { currentDestination = destination },
                                icon = { DestinationIcon(destination) },
                                label = { Text(destination.label) },
                            )
                        }
                    }
                }
            },
        ) { paddingValues ->
            Row {
                if (expandedLayout) {
                    NavigationRail(
                        modifier = androidx.compose.ui.Modifier.fillMaxHeight(),
                        containerColor = MaterialTheme.colorScheme.surface,
                    ) {
                        AppDestination.entries.forEach { destination ->
                            NavigationRailItem(
                                selected = currentDestination == destination,
                                onClick = { currentDestination = destination },
                                icon = { DestinationIcon(destination) },
                                label = { Text(destination.label) },
                            )
                        }
                    }
                }
                when (currentDestination) {
                    AppDestination.Conversation -> ConversationScreen(
                        uiState = conversationScreenState,
                        contentPadding = paddingValues,
                        expandedLayout = expandedLayout,
                        onRefresh = connectionViewModel::refreshStatus,
                        onMachineSelected = connectionViewModel::onMachineSelected,
                        onBaseUrlChanged = connectionViewModel::onBaseUrlChanged,
                        onTokenChanged = connectionViewModel::onTokenChanged,
                        onWorkspacePathChanged = connectionViewModel::onWorkspacePathChanged,
                        onTargetChanged = connectionViewModel::onTargetChanged,
                        onApplyTarget = connectionViewModel::applyRouteTarget,
                        onTextChanged = turnViewModel::onTextPromptChanged,
                        onSendText = turnViewModel::submitTextTurn,
                        onSaveConnection = connectionViewModel::saveCurrentSettings,
                        onRecordToggle = {
                            if (turnUiState.isRecording) {
                                turnViewModel.stopRecordingAndSend()
                            } else {
                                val granted = ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.RECORD_AUDIO,
                                ) == PackageManager.PERMISSION_GRANTED
                                if (granted) {
                                    turnViewModel.startRecording()
                                } else {
                                    permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            }
                        },
                        onPlayAudio = {
                            audioViewModel.playReplyAudio(
                                turnUiState.latestAudioUrl,
                                connectionUiState.baseUrl,
                                connectionUiState.token,
                            )
                        },
                        onStopAudio = audioViewModel::stopReplyAudio,
                        onDismissError = {
                            connectionViewModel.clearError()
                            turnViewModel.clearError()
                            audioViewModel.clearError()
                        },
                        onOpenSettings = { currentDestination = AppDestination.Settings },
                        onOpenAppSettings = {
                            val intent = Intent(
                                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.fromParts("package", context.packageName, null),
                            )
                            context.startActivity(intent)
                        },
                    )

                    AppDestination.Settings -> SettingsScreen(
                        connectionUiState = connectionUiState,
                        turnUiState = turnUiState,
                        audioUiState = audioUiState,
                        themeMode = themeMode,
                        contentPadding = paddingValues,
                        onBaseUrlChanged = connectionViewModel::onBaseUrlChanged,
                        onTokenChanged = connectionViewModel::onTokenChanged,
                        onConnectionModeChanged = connectionViewModel::onConnectionModeChanged,
                        onWorkspacePathChanged = connectionViewModel::onWorkspacePathChanged,
                        onMachineSelected = connectionViewModel::onMachineSelected,
                        onMachineProfileNameChanged = connectionViewModel::onMachineProfileNameChanged,
                        onSaveMachineProfile = connectionViewModel::onSaveMachineProfile,
                        onDeleteSelectedMachine = connectionViewModel::onDeleteSelectedMachine,
                        onTargetChanged = connectionViewModel::onTargetChanged,
                        onApplyTarget = connectionViewModel::applyRouteTarget,
                        onRequestAudioChanged = audioViewModel::onRequestAudioRepliesChanged,
                        onAutoplayChanged = audioViewModel::onAutoplayReplyAudioChanged,
                        onContinuousConversationChanged = audioViewModel::onContinuousConversationChanged,
                        onSaveSettings = connectionViewModel::saveCurrentSettings,
                        onThemeModeChanged = appViewModel::setThemeMode,
                        onDismissError = {
                            connectionViewModel.clearError()
                            turnViewModel.clearError()
                            audioViewModel.clearError()
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun DestinationIcon(destination: AppDestination) {
    Icon(
        imageVector = if (destination == AppDestination.Conversation) {
            Icons.Default.ChatBubble
        } else {
            Icons.Default.Settings
        },
        contentDescription = destination.label,
    )
}
