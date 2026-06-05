package com.example.api

import org.json.JSONObject

data class RealtimeControlMessage(
    val type: String,
    val text: String? = null,
    val session: String? = null,
    val name: String? = null,
    val command: String? = null,
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
            name?.let { put("name", it) }
            command?.let { put("command", it) }
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
                name = json.optString("name").takeIf { json.has("name") },
                command = json.optString("command").takeIf { json.has("command") },
                output = json.optString("output").takeIf { json.has("output") },
                message = json.optString("message").takeIf { json.has("message") },
                clientSequenceId = if (json.has("clientSequenceId")) json.getInt("clientSequenceId") else null,
                serverSequenceId = if (json.has("serverSequenceId")) json.getInt("serverSequenceId") else null,
                vadThreshold = if (json.has("vadThreshold")) json.getDouble("vadThreshold") else null
            )
        }
    }
}
