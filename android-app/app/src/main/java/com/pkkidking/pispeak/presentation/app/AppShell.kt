package com.pkkidking.pispeak.presentation.app

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pkkidking.pispeak.data.storage.ThemeMode
import com.pkkidking.pispeak.presentation.main.ConversationScreen
import com.pkkidking.pispeak.presentation.main.MainViewModel
import com.pkkidking.pispeak.presentation.settings.SettingsScreen
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
    appViewModel: AppViewModel = hiltViewModel(),
    mainViewModel: MainViewModel = hiltViewModel(),
) {
    val themeMode by appViewModel.themeMode.collectAsStateWithLifecycle()
    val uiState by mainViewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            mainViewModel.startRecording()
        } else {
            mainViewModel.onMicrophonePermissionDenied()
        }
    }
    var currentDestination by rememberSaveable { mutableStateOf(AppDestination.Conversation) }

    LaunchedEffect(bootstrapBaseUrl, bootstrapToken) {
        mainViewModel.applyBootstrap(bootstrapBaseUrl, bootstrapToken)
    }

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
                    title = {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = "Pi Speak",
                                style = MaterialTheme.typography.titleLarge,
                            )
                            Text(
                                text = if (currentDestination == AppDestination.Conversation) {
                                    uiState.statusSummary
                                } else {
                                    "Connection, audio, and appearance"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                )
            },
            bottomBar = {
                NavigationBar {
                    AppDestination.entries.forEach { destination ->
                        NavigationBarItem(
                            selected = currentDestination == destination,
                            onClick = { currentDestination = destination },
                            icon = {
                                Icon(
                                    imageVector = if (destination == AppDestination.Conversation) {
                                        Icons.Default.ChatBubble
                                    } else {
                                        Icons.Default.Settings
                                    },
                                    contentDescription = destination.label,
                                )
                            },
                            label = { Text(destination.label) },
                        )
                    }
                }
            },
        ) { paddingValues ->
            when (currentDestination) {
                AppDestination.Conversation -> ConversationScreen(
                    uiState = uiState,
                    contentPadding = paddingValues,
                    onRefresh = mainViewModel::refreshStatus,
                    onTargetChanged = mainViewModel::onTargetChanged,
                    onApplyTarget = mainViewModel::applyRouteTarget,
                    onTextChanged = mainViewModel::onTextPromptChanged,
                    onSendText = mainViewModel::submitTextTurn,
                    onRecordToggle = {
                        if (uiState.isRecording) {
                            mainViewModel.stopRecordingAndSend()
                        } else {
                            val granted = ContextCompat.checkSelfPermission(
                                context,
                                Manifest.permission.RECORD_AUDIO,
                            ) == PackageManager.PERMISSION_GRANTED
                            if (granted) {
                                mainViewModel.startRecording()
                            } else {
                                permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }
                    },
                    onPlayAudio = mainViewModel::playReplyAudio,
                    onDismissError = mainViewModel::clearError,
                    onOpenSettings = { currentDestination = AppDestination.Settings },
                )

                AppDestination.Settings -> SettingsScreen(
                    uiState = uiState,
                    themeMode = themeMode,
                    contentPadding = paddingValues,
                    onBaseUrlChanged = mainViewModel::onBaseUrlChanged,
                    onTokenChanged = mainViewModel::onTokenChanged,
                    onActiveProfileChanged = mainViewModel::onActiveProfileChanged,
                    onRequestAudioChanged = mainViewModel::onRequestAudioRepliesChanged,
                    onAutoplayChanged = mainViewModel::onAutoplayReplyAudioChanged,
                    onSaveSettings = mainViewModel::saveCurrentSettings,
                    onThemeModeChanged = appViewModel::setThemeMode,
                    onDismissError = mainViewModel::clearError,
                )
            }
        }
    }
}
