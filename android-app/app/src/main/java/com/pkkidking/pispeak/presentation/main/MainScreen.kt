package com.pkkidking.pispeak.presentation.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.presentation.common.ConnectionState
import com.pkkidking.pispeak.presentation.common.TurnPhase
import com.pkkidking.pispeak.presentation.conversation.components.ErrorPanel
import com.pkkidking.pispeak.presentation.conversation.components.OnboardingPanel
import com.pkkidking.pispeak.presentation.conversation.components.ReplyPanel
import com.pkkidking.pispeak.presentation.conversation.components.TextFallbackPanel
import com.pkkidking.pispeak.presentation.conversation.components.VoicePanel
import com.pkkidking.pispeak.presentation.conversation.components.WalkieHeader

internal val PanelShape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)
internal val ControlShape = androidx.compose.foundation.shape.RoundedCornerShape(16.dp)
internal val VoiceShape = androidx.compose.foundation.shape.RoundedCornerShape(28.dp)

@Composable
fun ConversationScreen(
    uiState: ConversationScreenState,
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
    val isSecure = remember(uiState.connection.baseUrl) { uiState.connection.baseUrl.trim().startsWith("https://") }
    val isApprovedLan = remember(uiState.connection.baseUrl) { uiState.connection.baseUrl.contains(BuildConfig.LAN_MSI_IP) }
    val trustedConnection = isSecure || isApprovedLan || uiState.connection.connectionMode == ConnectionMode.TAILSCALE || uiState.connection.connectionMode == ConnectionMode.BLUETOOTH
    val securityLabel = when {
        needsSetup -> "Setup required"
        isSecure -> "Secure (https)"
        isApprovedLan -> "Local LAN"
        uiState.connection.connectionMode == ConnectionMode.TAILSCALE -> "Tailscale"
        uiState.connection.connectionMode == ConnectionMode.BLUETOOTH -> "Bluetooth link"
        else -> "HTTPS preferred"
    }
    val focusManager = LocalFocusManager.current
    val targetLabel = uiState.connection.targetName.ifBlank { uiState.connection.currentSession ?: "Current session" }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .padding(horizontal = if (expandedLayout) 32.dp else 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        WalkieHeader(
            needsSetup = needsSetup,
            statusSummary = if (needsSetup) "Setup required." else uiState.connection.statusSummary,
            machineName = uiState.connection.selectedMachineName,
            currentSession = uiState.connection.currentSession,
            targetLabel = targetLabel,
            securityLabel = securityLabel,
            trustedConnection = trustedConnection,
            speakProvider = uiState.connection.speakProvider,
            speakEnabled = uiState.connection.speakEnabled,
            replyModeLabel = uiState.replyModeLabel(),
            replyModeHint = uiState.replyModeHint(),
            nextTurnHint = uiState.nextTurnHint(),
            connectionState = uiState.connection.connectionState,
            turnPhase = uiState.turn.turnPhase,
            onRefresh = onRefresh,
            onOpenSettings = onOpenSettings,
        )

        if (needsSetup) {
            OnboardingPanel(
                baseUrl = uiState.connection.baseUrl,
                token = uiState.connection.token,
                workspacePath = uiState.connection.workspacePath,
                onBaseUrlChanged = onBaseUrlChanged,
                onTokenChanged = onTokenChanged,
                onWorkspacePathChanged = onWorkspacePathChanged,
                onSaveConnection = onSaveConnection,
                onOpenSettings = onOpenSettings,
            )
        }

        val error = uiState.error
        if (error != null) {
            ErrorPanel(
                message = error,
                onDismiss = onDismissError,
                onOpenAppSettings = onOpenAppSettings,
            )
        }

        if (expandedLayout) {
            Row(
                modifier = Modifier.weight(1f),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                ReplyPanel(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxSize(),
                    transcript = uiState.turn.transcript,
                    replyText = uiState.turn.replyText,
                    recentTurns = uiState.turn.recentTurns,
                    statusSummary = uiState.connection.statusSummary,
                    securityLabel = securityLabel,
                    audioAvailable = uiState.audioUrl != null,
                    playbackState = uiState.audio.playbackState,
                    replyModeLabel = uiState.replyModeLabel(),
                    replyModeHint = uiState.replyModeHint(),
                    onPlayAudio = onPlayAudio,
                    onStopAudio = onStopAudio,
                )
                Column(
                    modifier = Modifier.width(420.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    TextFallbackPanel(
                        textPrompt = uiState.turn.textPrompt,
                        onTextChanged = onTextChanged,
                        onSendText = onSendText,
                        enabled = !uiState.isBusy && !needsSetup,
                        needsSetup = needsSetup,
                        onCommit = {
                            focusManager.clearFocus()
                            onSendText()
                        },
                    )
                    VoicePanel(
                        isBusy = uiState.isBusy,
                        isRecording = uiState.turn.isRecording,
                        nextTurnHint = uiState.nextTurnHint(),
                        replyModeLabel = uiState.replyModeLabel(),
                        onRecordToggle = onRecordToggle,
                        disabledReason = if (needsSetup) "Connect to a machine first to send voice turns." else null,
                    )
                }
            }
        } else {
            ReplyPanel(
                modifier = Modifier.weight(1f),
                transcript = uiState.turn.transcript,
                replyText = uiState.turn.replyText,
                recentTurns = uiState.turn.recentTurns,
                statusSummary = uiState.connection.statusSummary,
                securityLabel = securityLabel,
                audioAvailable = uiState.audioUrl != null,
                playbackState = uiState.audio.playbackState,
                replyModeLabel = uiState.replyModeLabel(),
                replyModeHint = uiState.replyModeHint(),
                onPlayAudio = onPlayAudio,
                onStopAudio = onStopAudio,
            )
            TextFallbackPanel(
                textPrompt = uiState.turn.textPrompt,
                onTextChanged = onTextChanged,
                onSendText = onSendText,
                enabled = !uiState.isBusy && !needsSetup,
                needsSetup = needsSetup,
                onCommit = {
                    focusManager.clearFocus()
                    onSendText()
                },
            )
            VoicePanel(
                isBusy = uiState.isBusy,
                isRecording = uiState.turn.isRecording,
                nextTurnHint = uiState.nextTurnHint(),
                replyModeLabel = uiState.replyModeLabel(),
                onRecordToggle = onRecordToggle,
                disabledReason = if (needsSetup) "Connect to a machine first to send voice turns." else null,
            )
        }
    }
}

internal fun ConnectionState.label(): String = when (this) {
    ConnectionState.Unknown -> "Checking"
    ConnectionState.Connected -> "Connected"
    ConnectionState.Unauthorized -> "Token"
    ConnectionState.Offline -> "Offline"
    ConnectionState.Misconfigured -> "Setup"
}

internal fun TurnPhase.label(): String = when (this) {
    TurnPhase.Idle -> "Idle"
    TurnPhase.Recording -> "Recording"
    TurnPhase.Uploading -> "Uploading"
    TurnPhase.Waiting -> "Waiting"
    TurnPhase.Complete -> "Done"
    TurnPhase.Failed -> "Failed"
}
