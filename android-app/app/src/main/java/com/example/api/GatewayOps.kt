package com.example.api

import org.json.JSONObject

/**
 * Models + pure parsers for the gateway operations surface the web remote already
 * uses: routing (/v1/route), compact route slots (/v1/sessions/slots), discovered
 * agents (/v1/agents), workspace file previews (/v1/workspace/file), and the
 * session event stream (/v1/events). Parsers are top-level and JSON-in so they
 * stay unit-testable without a network stack.
 */

data class GatewayRoute(
    val defaultTarget: String? = null,
    val currentSession: String? = null,
    val availableTargets: List<String> = emptyList()
)

data class GatewayRouteUpdate(
    val message: String,
    val route: GatewayRoute? = null,
    val ok: Boolean = false
)

data class GatewayRouteSlot(
    val family: String,
    val sessionName: String? = null,
    val sessionPath: String? = null,
    val labels: List<String> = emptyList(),
    val status: String = "unassigned"
)

data class RunningAgentProcess(
    val provider: String,
    val target: String,
    val pid: Long? = null,
    val cwd: String? = null,
    val cwdBasename: String? = null,
    val startedAt: String? = null
)

data class RecentAgentSessionFile(
    val provider: String,
    val path: String,
    val sessionId: String? = null,
    val title: String? = null,
    val updatedAt: String? = null,
    val cwd: String? = null,
    val cwdBasename: String? = null
)

data class AgentInventory(
    val agents: List<String> = emptyList(),
    val running: List<RunningAgentProcess> = emptyList(),
    val recent: List<RecentAgentSessionFile> = emptyList(),
    val generatedAt: String? = null
)

data class WorkspaceFilePreview(
    val name: String = "",
    val path: String = "",
    val size: Long = 0L,
    val truncated: Boolean = false,
    val binary: Boolean = false,
    val content: String = "",
    val error: String? = null
)

data class GatewayEvent(
    val ts: Long,
    val source: String,
    val kind: String,
    val summary: String
)

fun parseGatewayRoute(json: JSONObject): GatewayRoute? {
    val route = json.optJSONObject("route") ?: return null
    val targetsJson = route.optJSONArray("availableTargets")
    val targets = mutableListOf<String>()
    if (targetsJson != null) {
        for (i in 0 until targetsJson.length()) {
            val value = targetsJson.optString(i)
            if (value.isNotBlank()) targets.add(value)
        }
    }
    return GatewayRoute(
        defaultTarget = route.optString("defaultTarget").ifBlank { null },
        currentSession = route.optString("currentSession").ifBlank { null },
        availableTargets = targets
    )
}

fun parseGatewayRouteSlots(json: JSONObject): List<GatewayRouteSlot> {
    val slotsJson = json.optJSONArray("slots") ?: return emptyList()
    val slots = mutableListOf<GatewayRouteSlot>()
    for (i in 0 until slotsJson.length()) {
        val item = slotsJson.optJSONObject(i) ?: continue
        val labelsJson = item.optJSONArray("labels")
        val labels = mutableListOf<String>()
        if (labelsJson != null) {
            for (j in 0 until labelsJson.length()) {
                val value = labelsJson.optString(j)
                if (value.isNotBlank()) labels.add(value)
            }
        }
        val family = item.optString("family")
        if (family.isBlank()) continue
        slots.add(
            GatewayRouteSlot(
                family = family,
                sessionName = item.optString("sessionName").ifBlank { null },
                sessionPath = item.optString("sessionPath").ifBlank { null },
                labels = labels,
                status = item.optString("status").ifBlank { "unassigned" }
            )
        )
    }
    return slots
}

fun parseAgentInventory(json: JSONObject): AgentInventory {
    val agentsJson = json.optJSONArray("agents")
    val agents = mutableListOf<String>()
    if (agentsJson != null) {
        for (i in 0 until agentsJson.length()) {
            val value = agentsJson.optString(i)
            if (value.isNotBlank()) agents.add(value)
        }
    }
    val runningJson = json.optJSONArray("running")
    val running = mutableListOf<RunningAgentProcess>()
    if (runningJson != null) {
        for (i in 0 until runningJson.length()) {
            val item = runningJson.optJSONObject(i) ?: continue
            val target = item.optString("target")
            if (target.isBlank()) continue
            running.add(
                RunningAgentProcess(
                    provider = item.optString("provider").ifBlank { "agent" },
                    target = target,
                    pid = if (item.has("pid") && !item.isNull("pid")) item.optLong("pid") else null,
                    cwd = item.optString("cwd").ifBlank { null },
                    cwdBasename = item.optString("cwdBasename").ifBlank { null },
                    startedAt = item.optString("startedAt").ifBlank { null }
                )
            )
        }
    }
    val recentJson = json.optJSONArray("recent")
    val recent = mutableListOf<RecentAgentSessionFile>()
    if (recentJson != null) {
        for (i in 0 until recentJson.length()) {
            val item = recentJson.optJSONObject(i) ?: continue
            val path = item.optString("path")
            if (path.isBlank()) continue
            recent.add(
                RecentAgentSessionFile(
                    provider = item.optString("provider").ifBlank { "agent" },
                    path = path,
                    sessionId = item.optString("sessionId").ifBlank { null },
                    title = item.optString("title").ifBlank { null },
                    updatedAt = item.optString("updatedAt").ifBlank { null },
                    cwd = item.optString("cwd").ifBlank { null },
                    cwdBasename = item.optString("cwdBasename").ifBlank { null }
                )
            )
        }
    }
    return AgentInventory(
        agents = agents,
        running = running,
        recent = recent,
        generatedAt = json.optString("generatedAt").ifBlank { null }
    )
}

fun parseWorkspaceFilePreview(json: JSONObject): WorkspaceFilePreview? {
    val file = json.optJSONObject("file") ?: return null
    return WorkspaceFilePreview(
        name = file.optString("name"),
        path = file.optString("path"),
        size = file.optLong("size", 0L),
        truncated = file.optBoolean("truncated", false),
        binary = file.optBoolean("binary", false),
        content = file.optString("content")
    )
}

/**
 * Parses one SSE `data:` payload from /v1/events into a display-ready event.
 * Events are `{ts, source, kind, payload}`; the payload object is flattened into
 * a compact "key=value" summary so the feed stays one-line-per-event.
 */
fun parseGatewayEventData(data: String): GatewayEvent? {
    val json = try { JSONObject(data) } catch (_: Exception) { return null }
    val kind = json.optString("kind")
    if (kind.isBlank()) {
        // `event: error` frames carry only {message}.
        val message = json.optString("message")
        if (message.isBlank()) return null
        return GatewayEvent(ts = 0L, source = "gateway", kind = "error", summary = message)
    }
    val payload = json.optJSONObject("payload")
    val summary = if (payload == null || payload.length() == 0) {
        ""
    } else {
        val parts = mutableListOf<String>()
        val keys = payload.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = payload.opt(key)?.toString().orEmpty()
            if (value.isNotBlank()) parts.add("$key=${value.take(80)}")
        }
        parts.joinToString(" ")
    }
    return GatewayEvent(
        ts = json.optLong("ts", 0L),
        source = json.optString("source").ifBlank { "gateway" },
        kind = kind,
        summary = summary
    )
}
