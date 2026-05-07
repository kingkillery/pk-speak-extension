package com.pkkidking.pispeak.domain.model

import java.net.URI
import java.util.UUID

data class AppSettings(
    val baseUrl: String,
    val token: String,
    val requestAudioReplies: Boolean,
    val autoplayReplyAudio: Boolean,
    val continuousConversation: Boolean = false,
    val connectionMode: ConnectionMode = ConnectionMode.MANUAL,
    val selectedMachineId: String? = null,
    val machineProfiles: List<MachineProfile> = emptyList(),
    val machineProfileName: String = "",
    val workspacePath: String = "",
)

enum class ConnectionMode(val storageKey: String, val label: String) {
    TAILSCALE("tailscale", "Tailscale"),
    BLUETOOTH("bluetooth", "Bluetooth"),
    MANUAL("manual", "Manual"),
    ;

    companion object {
        fun fromStorage(value: String?, fallback: ConnectionMode = MANUAL): ConnectionMode =
            entries.firstOrNull { it.storageKey == value?.trim()?.lowercase() } ?: fallback
    }
}

data class MachineProfile(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val baseUrl: String,
    val token: String,
    val connectionMode: ConnectionMode = ConnectionMode.MANUAL,
    val workspacePath: String = "",
)

const val TAILSCALE_REMOTE_PORT = 8767
const val TAILSCALE_APPSERVER_IP = "100.76.136.91"
const val TAILSCALE_MAC_IP = "100.76.176.119"
const val BLUETOOTH_REMOTE_IP = "192.168.44.1"
const val LAN_MSI_IP = "10.0.0.117"

val DefaultMachineProfiles = listOf(
    MachineProfile(
        id = "tailscale-appserver",
        name = "MSI / appserver",
        baseUrl = "http://$TAILSCALE_APPSERVER_IP:$TAILSCALE_REMOTE_PORT/",
        token = "",
        connectionMode = ConnectionMode.TAILSCALE,
    ),
    MachineProfile(
        id = "tailscale-mac",
        name = "Mac",
        baseUrl = "http://$TAILSCALE_MAC_IP:$TAILSCALE_REMOTE_PORT/",
        token = "",
        connectionMode = ConnectionMode.TAILSCALE,
    ),
    MachineProfile(
        id = "lan-msi",
        name = "MSI / LAN",
        baseUrl = "http://$LAN_MSI_IP:$TAILSCALE_REMOTE_PORT/",
        token = "",
        connectionMode = ConnectionMode.MANUAL,
    ),
    MachineProfile(
        id = "bluetooth-local",
        name = "Bluetooth / local link",
        baseUrl = "http://$BLUETOOTH_REMOTE_IP:$TAILSCALE_REMOTE_PORT/",
        token = "",
        connectionMode = ConnectionMode.BLUETOOTH,
    ),
)

fun MachineProfile.normalizedBaseUrl(): String = baseUrl.trim().trimEnd('/')

data class RemoteStatusSummary(
    val remoteEnabled: Boolean,
    val remotePort: Int?,
    val agentProvider: String? = null,
    val agentModel: String? = null,
    val speakEnabled: Boolean,
    val speakProvider: String?,
    val monoRunning: Boolean,
    val phoneEnabled: Boolean,
    val defaultTarget: String?,
    val currentSession: String?,
    val availableTargets: List<String>,
) {
    fun summaryText(): String = buildString {
        append("Remote ")
        append(if (remoteEnabled) "on" else "off")
        if (remotePort != null) append(" at port $remotePort")
        append(". Agent ")
        append(agentProvider ?: "unknown")
        if (!agentModel.isNullOrBlank()) {
            append(" (")
            append(agentModel)
            append(')')
        }
        append(". Speak ")
        append(if (speakEnabled) (speakProvider ?: "on") else "off")
        append(", mono ")
        append(if (monoRunning) "on" else "off")
        append(", phone ")
        append(if (phoneEnabled) "on" else "off")
        append(", route ")
        append(defaultTarget ?: currentSession ?: "current")
        append('.')
    }
}

data class TurnResult(
    val replyText: String,
    val transcript: String,
    val audioUrl: String?,
)

enum class TurnSource(val storageKey: String, val label: String) {
    TEXT("text", "Text"),
    VOICE("voice", "Voice"),
    ;

    companion object {
        fun fromStorage(value: String?): TurnSource =
            entries.firstOrNull { it.storageKey == value?.trim()?.lowercase() } ?: TEXT
    }
}

enum class TurnHistoryStatus(val storageKey: String, val label: String) {
    COMPLETE("complete", "Complete"),
    FAILED("failed", "Failed"),
    ;

    companion object {
        fun fromStorage(value: String?): TurnHistoryStatus =
            entries.firstOrNull { it.storageKey == value?.trim()?.lowercase() } ?: COMPLETE
    }
}

data class TurnHistoryItem(
    val id: Long,
    val createdAtMillis: Long,
    val source: TurnSource,
    val routeLabel: String,
    val transcript: String,
    val replyText: String,
    val hasAudio: Boolean,
    val audioUrl: String?,
    val status: TurnHistoryStatus,
)

enum class DiagnosticSeverity(val storageKey: String, val label: String) {
    INFO("info", "Info"),
    WARNING("warning", "Warning"),
    ERROR("error", "Error"),
    ;

    companion object {
        fun fromStorage(value: String?): DiagnosticSeverity =
            entries.firstOrNull { it.storageKey == value?.trim()?.lowercase() } ?: INFO
    }
}

data class DiagnosticEvent(
    val id: Long,
    val createdAtMillis: Long,
    val area: String,
    val severity: DiagnosticSeverity,
    val message: String,
)

data class RecordedAudio(
    val filePath: String,
    val mimeType: String,
)

fun AppSettings.validate(allowInsecureLoopback: Boolean): String? {
    val normalized = baseUrl.trim()
    if (normalized.isEmpty()) return "Base URL is required."

    val parsed = runCatching { URI.create(normalized) }.getOrNull()
        ?: return "Base URL is invalid."
    val scheme = parsed.scheme?.lowercase().orEmpty()
    val host = parsed.host?.lowercase().orEmpty()
    val loopbackHosts = setOf("localhost", "127.0.0.1", "::1")
    val approvedTailscaleHosts = setOf(TAILSCALE_APPSERVER_IP, TAILSCALE_MAC_IP)
    val approvedLanHosts = setOf(LAN_MSI_IP)
    val activeConnectionMode = machineProfiles
        .firstOrNull { it.id == selectedMachineId }
        ?.connectionMode
        ?: connectionMode

    if (scheme == "https") return null
    if (scheme == "http" && host in approvedTailscaleHosts) return null
    if (scheme == "http" && host in approvedLanHosts) return null
    if (scheme == "http" && activeConnectionMode == ConnectionMode.BLUETOOTH) return null
    if (allowInsecureLoopback && scheme == "http" && host in loopbackHosts) return null
    return "Use an HTTPS base URL. HTTP is only allowed for local debug, approved Tailscale, or Bluetooth local-link endpoints."
}
