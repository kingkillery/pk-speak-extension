package com.pkkidking.pispeak.domain.model

import java.net.URI

enum class ConnectionProfileId(val key: String, val label: String) {
    WINDOWS("windows", "Windows"),
    MAC("mac", "Mac");

    companion object {
        fun fromKey(value: String?): ConnectionProfileId =
            entries.firstOrNull { it.key.equals(value, ignoreCase = true) } ?: WINDOWS
    }
}

data class ConnectionSettings(
    val baseUrl: String,
    val token: String,
)

data class AppSettings(
    val activeProfileId: String,
    val windowsConnection: ConnectionSettings,
    val macConnection: ConnectionSettings,
    val requestAudioReplies: Boolean,
    val autoplayReplyAudio: Boolean,
) {
    fun activeProfile(): ConnectionProfileId = ConnectionProfileId.fromKey(activeProfileId)

    fun activeConnection(): ConnectionSettings = when (activeProfile()) {
        ConnectionProfileId.MAC -> macConnection
        ConnectionProfileId.WINDOWS -> windowsConnection
    }

    fun withActiveConnection(baseUrl: String, token: String): AppSettings = when (activeProfile()) {
        ConnectionProfileId.MAC -> copy(macConnection = ConnectionSettings(baseUrl, token))
        ConnectionProfileId.WINDOWS -> copy(windowsConnection = ConnectionSettings(baseUrl, token))
    }

    fun withActiveProfile(profileId: ConnectionProfileId): AppSettings = copy(activeProfileId = profileId.key)
}

data class RemoteStatusSummary(
    val remoteEnabled: Boolean,
    val remotePort: Int?,
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

data class RecordedAudio(
    val filePath: String,
    val mimeType: String,
)

fun ConnectionSettings.validate(allowInsecureLoopback: Boolean): String? {
    val normalized = baseUrl.trim()
    if (normalized.isEmpty()) return "Base URL is required."

    val parsed = runCatching { URI.create(normalized) }.getOrNull()
        ?: return "Base URL is invalid."
    val scheme = parsed.scheme?.lowercase().orEmpty()
    val host = parsed.host?.lowercase().orEmpty()
    val loopbackHosts = setOf("localhost", "127.0.0.1", "::1", "10.0.2.2")

    if (scheme == "https") return null
    if (allowInsecureLoopback && scheme == "http" && host in loopbackHosts) return null
    return "Use an HTTPS base URL. HTTP is only allowed for local debug endpoints."
}
