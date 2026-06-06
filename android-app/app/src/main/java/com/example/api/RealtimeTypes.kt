package com.example.api

import org.json.JSONObject

data class RealtimeControlMessage(
    val type: String,
    val text: String? = null,
    val session: String? = null,
    val approvalId: String? = null,
    val name: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val reason: String? = null,
    val timeoutMs: Int? = null,
    val output: String? = null,
    val message: String? = null,
    val clientSequenceId: Int? = null,
    val serverSequenceId: Int? = null,
    val vadThreshold: Double? = null
) {
    fun toJsonString(): String {
        val json = JSONObject().apply {
            put("type", type)
            text?.let { put("text", it) }
            session?.let { put("session", it) }
            approvalId?.let { put("approvalId", it) }
            name?.let { put("name", it) }
            command?.let { put("command", it) }
            cwd?.let { put("cwd", it) }
            reason?.let { put("reason", it) }
            timeoutMs?.let { put("timeoutMs", it) }
            output?.let { put("output", it) }
            message?.let { put("message", it) }
            clientSequenceId?.let { put("clientSequenceId", it) }
            serverSequenceId?.let { put("serverSequenceId", it) }
            vadThreshold?.let { put("vadThreshold", it) }
        }
        return json.toString()
    }

    companion object {
        fun fromJsonString(jsonStr: String): RealtimeControlMessage {
            val json = JSONObject(jsonStr)
            return RealtimeControlMessage(
                type = json.getString("type"),
                text = json.optString("text").takeIf { json.has("text") },
                session = json.optString("session").takeIf { json.has("session") },
                approvalId = json.optString("approvalId").takeIf { json.has("approvalId") },
                name = json.optString("name").takeIf { json.has("name") },
                command = json.optString("command").takeIf { json.has("command") },
                cwd = json.optString("cwd").takeIf { json.has("cwd") },
                reason = json.optString("reason").takeIf { json.has("reason") },
                timeoutMs = if (json.has("timeoutMs")) json.getInt("timeoutMs") else null,
                output = json.optString("output").takeIf { json.has("output") },
                message = json.optString("message").takeIf { json.has("message") },
                clientSequenceId = if (json.has("clientSequenceId")) json.getInt("clientSequenceId") else null,
                serverSequenceId = if (json.has("serverSequenceId")) json.getInt("serverSequenceId") else null,
                vadThreshold = if (json.has("vadThreshold")) json.getDouble("vadThreshold") else null
            )
        }
    }
}
