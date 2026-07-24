package com.example.api

import org.json.JSONObject

/**
 * Models + pure parsers for the hierarchical Agent Hub surface (/v1/herdr/agent*): a live
 * lane -> subagent tree with per-agent chat/kill/revive and a live transcript stream, distinct
 * from the older flat session dashboard (/v1/sessions) modeled in GatewaySessions.kt.
 */

data class HubFolder(
    val key: String,
    val name: String,
    val laneCount: Int,
    val isCurrentFolder: Boolean
)

data class HubAgent(
    val id: String,
    val displayName: String,
    val kind: String, // "main" | "sub" | "advisor" | "background"
    val parentId: String? = null,
    val folderKey: String = "",
    val depth: Int = 0,
    val status: String = "parked", // "running" | "idle" | "parked" | "aborted"
    val model: String? = null,
    val cwd: String? = null,
    val activity: String? = null,
    /** Stable purpose of the lane (gateway: background instance role); null when unknown. */
    val description: String? = null,
    val createdAtMs: Long = 0L,
    val lastActivityMs: Long = 0L,
    val needsAttention: Boolean = false,
    val attentionReason: String? = null,
    val sessionFile: String? = null
)

data class HubAgentDetail(
    val agent: HubAgent,
    val transcriptTail: List<String> = emptyList(),
    val transcriptSize: Long = 0L
)

data class HubSnapshot(
    val folders: List<HubFolder> = emptyList(),
    val agents: List<HubAgent> = emptyList(),
    val generatedAtMs: Long = 0L
)

/** Result of chat/revive; kill uses [HubKillOutcome] since it has an extra confirm step. */
data class HubActionResult(
    val ok: Boolean,
    val messageId: String? = null,
    val code: String? = null,
    val error: String? = null
)

data class HubKillOutcome(
    val ok: Boolean,
    val confirmed: Boolean = false,
    val confirmToken: String? = null,
    val expiresInMs: Long? = null,
    val code: String? = null,
    val error: String? = null
)

fun parseHubFolder(json: JSONObject): HubFolder = HubFolder(
    key = json.optString("key"),
    name = json.optString("name").ifBlank { json.optString("key") },
    laneCount = json.optInt("laneCount", 0),
    isCurrentFolder = json.optBoolean("isCurrentFolder", false)
)

fun parseHubAgent(json: JSONObject): HubAgent? {
    val id = json.optString("id")
    if (id.isBlank()) return null
    return HubAgent(
        id = id,
        displayName = json.optString("displayName").ifBlank { id },
        kind = json.optString("kind").ifBlank { "background" },
        parentId = json.optString("parentId").ifBlank { null },
        folderKey = json.optString("folderKey"),
        depth = json.optInt("depth", 0),
        status = json.optString("status").ifBlank { "parked" },
        model = json.optString("model").ifBlank { null },
        cwd = json.optString("cwd").ifBlank { null },
        activity = json.optString("activity").ifBlank { null },
        description = json.optString("description").ifBlank { null },
        createdAtMs = json.optLong("createdAtMs", 0L),
        lastActivityMs = json.optLong("lastActivityMs", 0L),
        needsAttention = json.optBoolean("needsAttention", false),
        attentionReason = json.optString("attentionReason").ifBlank { null },
        sessionFile = json.optString("sessionFile").ifBlank { null }
    )
}

fun parseHubSnapshot(json: JSONObject): HubSnapshot {
    val foldersJson = json.optJSONArray("folders")
    val folders = mutableListOf<HubFolder>()
    if (foldersJson != null) {
        for (i in 0 until foldersJson.length()) {
            foldersJson.optJSONObject(i)?.let { folders.add(parseHubFolder(it)) }
        }
    }
    val agentsJson = json.optJSONArray("agents")
    val agents = mutableListOf<HubAgent>()
    if (agentsJson != null) {
        for (i in 0 until agentsJson.length()) {
            agentsJson.optJSONObject(i)?.let { item -> parseHubAgent(item)?.let { agents.add(it) } }
        }
    }
    return HubSnapshot(
        folders = folders,
        agents = agents,
        generatedAtMs = json.optLong("generatedAtMs", 0L)
    )
}

fun parseHubAgentDetail(json: JSONObject): HubAgentDetail? {
    val agentJson = json.optJSONObject("agent") ?: return null
    val agent = parseHubAgent(agentJson) ?: return null
    val tailJson = agentJson.optJSONArray("transcriptTail")
    val tail = mutableListOf<String>()
    if (tailJson != null) {
        for (i in 0 until tailJson.length()) {
            val line = tailJson.optString(i)
            if (line.isNotEmpty()) tail.add(line)
        }
    }
    return HubAgentDetail(
        agent = agent,
        transcriptTail = tail,
        transcriptSize = agentJson.optLong("transcriptSize", 0L)
    )
}

fun parseHubActionResult(json: JSONObject): HubActionResult = HubActionResult(
    ok = json.optBoolean("ok", false),
    messageId = json.optString("messageId").ifBlank { null },
    code = json.optString("code").ifBlank { null },
    error = json.optString("error").ifBlank { null }
)

fun parseHubKillOutcome(json: JSONObject): HubKillOutcome = HubKillOutcome(
    ok = json.optBoolean("ok", false),
    confirmed = json.optBoolean("ok", false),
    confirmToken = json.optString("confirmToken").ifBlank { null },
    expiresInMs = if (json.has("expiresInMs") && !json.isNull("expiresInMs")) json.optLong("expiresInMs") else null,
    code = json.optString("code").ifBlank { null },
    error = json.optString("error").ifBlank { null }
)
