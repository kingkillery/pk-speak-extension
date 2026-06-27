package com.example.api

data class GatewaySessionsResponse(
    val ok: Boolean = false,
    val dashboard: GatewaySessionDashboard? = null,
    val error: String? = null
)

data class GatewaySessionDashboard(
    val current: String = "",
    val ready: List<String> = emptyList(),
    val storePath: String? = null,
    val sessions: List<GatewaySessionEntry> = emptyList()
)

data class GatewaySessionSubagentEntry(
    val id: String = "",
    val name: String = "",
    val status: String? = null,
    val sessionPath: String? = null,
    val cwd: String? = null,
    val activity: String? = null,
    val createdAt: Long? = null,
    val lastActivity: Long? = null
)

data class GatewaySessionEntry(
    val name: String = "",
    val path: String? = null,
    val sessionPath: String? = null,
    val provider: String? = null,
    val sessionId: String? = null,
    val resumable: Boolean = false,
    val resumeCommand: List<String> = emptyList(),
    val workingDirectory: String? = null,
    val cwd: String? = null,
    val current: Boolean = false,
    val isCurrent: Boolean = false,
    val ready: Boolean = false,
    val isReady: Boolean = false,
    val activity: String? = null,
    val aliases: List<String> = emptyList(),
    val kind: String? = null,
    val source: String? = null,
    val model: String? = null,
    val role: String? = null,
    val createdAt: Long? = null,
    val lastActivity: Long? = null,
    val subagents: List<GatewaySessionSubagentEntry> = emptyList()
) {
    val displayCwd: String
        get() = workingDirectory?.takeIf { it.isNotBlank() }
            ?: cwd?.takeIf { it.isNotBlank() }
            ?: "unknown"

    val canonicalSessionPath: String?
        get() = sessionPath?.takeIf { it.isNotBlank() }
            ?: path?.takeIf { it.isNotBlank() }

    fun isCurrentIn(dashboard: GatewaySessionDashboard): Boolean =
        current || isCurrent || (name.isNotBlank() && name == dashboard.current)

    fun isReadyIn(dashboard: GatewaySessionDashboard): Boolean =
        ready || isReady || dashboard.ready.contains(name)

    fun isRouteCapableIn(dashboard: GatewaySessionDashboard): Boolean =
        isCurrentIn(dashboard) || isReadyIn(dashboard)
}

enum class GatewaySessionErrorKind {
    Unauthorized,
    Unsupported,
    Malformed,
    Network,
    Unknown
}

class GatewaySessionException(
    val kind: GatewaySessionErrorKind,
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)
