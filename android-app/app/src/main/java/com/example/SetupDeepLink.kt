package com.example

import android.net.Uri
import com.example.data.AppPreferences

data class SetupDeepLink(
    val baseUrl: String,
    val token: String,
    val profileName: String?,
    val connectionMode: String?,
    val defaultTarget: String?,
    val agentProvider: String?,
    val agentModel: String?,
    val workspaceRoot: String?,
    val workspacePath: String?
)

fun parseSetupDeepLink(uri: Uri?): SetupDeepLink? {
    if (uri?.scheme != "pi-speak" || uri.host != "setup") return null
    val baseUrl = uri.getQueryParameter("base_url")
        ?.trim()
        ?.trimEnd('/')
        ?.takeIf { it.isNotBlank() }
        ?: legacyBaseUrl(uri)
        ?: return null
    val token = uri.getQueryParameter("token")?.takeIf { it.isNotBlank() } ?: return null
    return SetupDeepLink(
        baseUrl = baseUrl,
        token = token,
        profileName = uri.getQueryParameter("profile_name")
            ?: uri.getQueryParameter("machine_id")
            ?: uri.getQueryParameter("name"),
        connectionMode = uri.getQueryParameter("connection_mode"),
        defaultTarget = uri.getQueryParameter("default_target")
            ?: uri.getQueryParameter("target")
            ?: uri.getQueryParameter("session"),
        agentProvider = uri.getQueryParameter("agent_provider"),
        agentModel = uri.getQueryParameter("agent_model") ?: uri.getQueryParameter("model"),
        workspaceRoot = uri.getQueryParameter("workspace_root"),
        workspacePath = uri.getQueryParameter("workspace_path")
    )
}

fun applySetupDeepLink(prefs: AppPreferences, setup: SetupDeepLink) {
    prefs.targetIpAddress = setup.baseUrl
    prefs.remoteToken = setup.token
    setup.profileName?.takeIf { it.isNotBlank() }?.let { prefs.machineProfileName = it }
    setup.defaultTarget?.takeIf { it.isNotBlank() }?.let { prefs.codexSessionName = it }
    setup.workspaceRoot?.takeIf { it.isNotBlank() }?.let { prefs.workspaceRoot = it }
    setup.workspacePath?.takeIf { it.isNotBlank() }?.let { prefs.workspacePath = it }
    setup.agentModel?.takeIf { it.isNotBlank() }?.let { prefs.agentModel = it }
    setup.connectionMode?.let { prefs.connectionMode = normalizeConnectionMode(it) }
    when (setup.agentProvider?.lowercase()) {
        "codex", "pi" -> prefs.activeAgent = "Local Codex (Pi)"
        "claude" -> prefs.activeAgent = "Gateway Claude (Claude Code)"
        "oh-my-pk", "ompk", "oh-my-pi", "omp" -> prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
        "hermes" -> prefs.activeAgent = "Gateway Hermes"
        "elevenlabs" -> prefs.activeAgent = "Gateway Voice (ElevenLabs)"
        "gemini", "gemini-live", "vertex" -> prefs.activeAgent = "Gateway Gemini (Vertex AI)"
    }
}

fun normalizeConnectionMode(value: String): String = when (value.trim().lowercase()) {
    "tailscale", "tailnet" -> "Tailscale"
    "bluetooth", "bt" -> "Bluetooth"
    else -> "Manual"
}

private fun legacyBaseUrl(uri: Uri): String? {
    val host = uri.getQueryParameter("host")?.takeIf { it.isNotBlank() } ?: return null
    val scheme = uri.getQueryParameter("scheme")?.takeIf { it.isNotBlank() } ?: "http"
    val port = uri.getQueryParameter("port")?.takeIf { it.isNotBlank() } ?: "8767"
    return "$scheme://$host:$port"
}
