package com.example.data

import android.content.Context
import android.content.SharedPreferences
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory

data class RecordedSession(
    val id: String,
    val timestamp: Long,
    val durationSeconds: Int,
    val recordingPath: String,
    val transcriptionText: String,
    val replyText: String,
    val replyAudioPath: String? = null,
    val voiceAgent: String = "Local Codex"
)

data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    val timestampMs: Long,
    val serverId: String? = null,
    val baseUrl: String,
    val workspacePath: String? = null,
    val targetSession: String? = null,
    val progress: List<String> = emptyList(),
    val audioPath: String? = null
)

class AppPreferences(context: Context) {
    companion object {
        const val DEFAULT_WORKSPACE_PATH = "C:\\Dev"
        const val SPWR_DAILY_WORKSPACE_PATH = "C:\\Users\\Prest\\Desktop\\SPWR-DAILY\\Interconnection-Dash-2026"
    }

    private val prefs: SharedPreferences = context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE)
    private val moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()
    private val sessionListAdapterType = Types.newParameterizedType(List::class.java, RecordedSession::class.java)
    private val sessionListAdapter = moshi.adapter<List<RecordedSession>>(sessionListAdapterType)
    private val chatMessageListAdapterType = Types.newParameterizedType(List::class.java, ChatMessage::class.java)
    private val chatMessageListAdapter = moshi.adapter<List<ChatMessage>>(chatMessageListAdapterType)

    var activeAgent: String
        get() = prefs.getString("active_agent", "Local Codex (Pi)") ?: "Local Codex (Pi)"
        set(value) = prefs.edit().putString("active_agent", value).apply()

    var elevenLabsApiKey: String
        get() = prefs.getString("eleven_labs_api_key", "") ?: ""
        set(value) = prefs.edit().putString("eleven_labs_api_key", value).apply()

    var elevenLabsVoiceId: String
        get() = prefs.getString("eleven_labs_voice_id", "21m00Tcm4TlvDq8ikWAM") ?: "21m00Tcm4TlvDq8ikWAM"
        set(value) = prefs.edit().putString("eleven_labs_voice_id", value).apply()

    var elevenLabsModel: String
        get() = prefs.getString("eleven_labs_model", "eleven_monolingual_v1") ?: "eleven_monolingual_v1"
        set(value) = prefs.edit().putString("eleven_labs_model", value).apply()

    var transmissionMode: String
        get() = prefs.getString("transmission_mode", "PTT") ?: "PTT" // "PTT" = Hold to Talk, "TOGGLE" = Tap to Mic
        set(value) = prefs.edit().putString("transmission_mode", value).apply()

    var codexSessionName: String
        get() = prefs.getString("codex_session_name", "Main-Project-Alpha") ?: "Main-Project-Alpha"
        set(value) = prefs.edit().putString("codex_session_name", value).apply()

    var selectedGatewaySessionPath: String
        get() = prefs.getString("selected_gateway_session_path", "") ?: ""
        set(value) = prefs.edit().putString("selected_gateway_session_path", value).apply()

    var agentModel: String
        get() = prefs.getString("agent_model", "") ?: ""
        set(value) = prefs.edit().putString("agent_model", value.trim()).apply()

    var machineProfileName: String
        get() = prefs.getString("machine_profile_name", "MSI / appserver") ?: "MSI / appserver"
        set(value) = prefs.edit().putString("machine_profile_name", value).apply()

    var targetIpAddress: String
        get() = prefs.getString("target_ip_address", "") ?: ""
        set(value) = prefs.edit().putString("target_ip_address", value).apply()

    var lastKnownAppVersionCode: Int
        get() = prefs.getInt("last_known_app_version_code", 0)
        set(value) = prefs.edit().putInt("last_known_app_version_code", value).apply()

    var workspaceRoot: String
        get() = prefs.getString("workspace_root", DEFAULT_WORKSPACE_PATH) ?: DEFAULT_WORKSPACE_PATH
        set(value) = prefs.edit().putString("workspace_root", value).apply()

    var workspacePath: String
        get() = prefs.getString("workspace_path", workspaceRoot) ?: workspaceRoot
        set(value) = prefs.edit().putString("workspace_path", value).apply()

    var secureModeEnabled: Boolean
        get() = prefs.getBoolean("secure_mode_enabled", false)
        set(value) = prefs.edit().putBoolean("secure_mode_enabled", value).apply()

    var autoSpeakEnabled: Boolean
        get() = prefs.getBoolean("auto_speak_enabled", true)
        set(value) = prefs.edit().putBoolean("auto_speak_enabled", value).apply()

    var showTurnProgress: Boolean
        get() = prefs.getBoolean("show_turn_progress", true)
        set(value) = prefs.edit().putBoolean("show_turn_progress", value).apply()

    var speakTurnProgress: Boolean
        get() = prefs.getBoolean("speak_turn_progress", false)
        set(value) = prefs.edit().putBoolean("speak_turn_progress", value).apply()

    var remoteToken: String
        get() = prefs.getString("remote_token", "") ?: ""
        set(value) = prefs.edit().putString("remote_token", value).apply()

    var connectionMode: String
        get() = prefs.getString("connection_mode", "Tailscale") ?: "Tailscale"
        set(value) = prefs.edit().putString("connection_mode", value).apply()

    fun clearGatewayConfigIfAppUpgraded(currentVersionCode: Int) {
        val previousVersionCode = lastKnownAppVersionCode
        if (previousVersionCode != 0 && previousVersionCode != currentVersionCode) {
            prefs.edit()
                .remove("target_ip_address")
                .apply()
        }
        lastKnownAppVersionCode = currentVersionCode
    }

    fun getRecordedSessions(): List<RecordedSession> {
        val json = prefs.getString("recorded_sessions_json", null) ?: return emptyList()
        return try {
            sessionListAdapter.fromJson(json) ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun saveRecordedSessions(sessions: List<RecordedSession>) {
        val json = sessionListAdapter.toJson(sessions)
        prefs.edit().putString("recorded_sessions_json", json).apply()
    }

    fun addRecordedSession(session: RecordedSession) {
        val current = getRecordedSessions().toMutableList()
        current.add(0, session)
        saveRecordedSessions(current)
    }

    fun deleteRecordedSession(sessionId: String) {
        val filtered = getRecordedSessions().filter { it.id != sessionId }
        saveRecordedSessions(filtered)
    }

    fun conversationKey(
        baseUrl: String = targetIpAddress,
        workspacePath: String = this.workspacePath,
        targetSession: String = codexSessionName
    ): String = listOf(
        baseUrl.trim().trimEnd('/'),
        workspacePath.trim(),
        targetSession.trim()
    ).joinToString("|")

    fun getChatMessages(conversationKey: String = conversationKey()): List<ChatMessage> {
        val json = prefs.getString("chat_history_json_$conversationKey", null) ?: return emptyList()
        return try {
            chatMessageListAdapter.fromJson(json) ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun saveChatMessages(conversationKey: String = conversationKey(), messages: List<ChatMessage>) {
        val json = chatMessageListAdapter.toJson(messages.takeLast(50))
        prefs.edit().putString("chat_history_json_$conversationKey", json).apply()
    }

    fun clearChatMessages(conversationKey: String = conversationKey()) {
        prefs.edit().remove("chat_history_json_$conversationKey").apply()
    }
}
