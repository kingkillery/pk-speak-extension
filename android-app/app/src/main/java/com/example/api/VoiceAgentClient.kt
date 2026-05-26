package com.example.api

import android.content.Context
import android.util.Log
import com.example.data.AppPreferences
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class VoiceAgentClient(private val context: Context, private val prefs: AppPreferences) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    /**
     * Sends a text turn to the current active agent.
     * Returns a Pair of: (User Transcript, Agent Response Text)
     */
    suspend fun sendTextTurn(text: String): Pair<String, String> {
        val targetAgent = prefs.activeAgent
        Log.d("VoiceAgent", "Sending text turn using: $targetAgent")

        return withContext(Dispatchers.IO) {
            callLocalGatewayText(text)
        }
    }

    /**
     * Sends an audio file turn to the active agent.
     * Returns a Pair of: (Recognized Transcription, Agent Response Text)
     */
    suspend fun sendVoiceTurn(audioFile: File, fallbackPrompt: String = ""): Pair<String, String> {
        val targetAgent = prefs.activeAgent
        Log.d("VoiceAgent", "Sending voice turn using: $targetAgent")

        val result = withContext(Dispatchers.IO) {
            callLocalGatewayVoice(audioFile)
        }
        val reply = result.second.lowercase()
        if (reply.contains("operational status returned by remote: 502")
            || reply.contains("operational status returned by remote: 429")
            || reply.contains("voice transmission offline")
            || reply.contains("gateway connection error")) {
            val prompt = fallbackPrompt.trim()
            if (prompt.isNotEmpty() && !prompt.equals("Listening...", ignoreCase = true)) {
                return withContext(Dispatchers.IO) {
                    callLocalGatewayText(prompt)
                }
            }
        }
        return result
    }

    // Optional direct test helper. Normal phone turns use the Pi Speak gateway so API keys stay off the device.
    suspend fun synthesizeWithElevenLabs(textToSpeak: String): File? {
        val apiKey = prefs.elevenLabsApiKey
        val voiceId = prefs.elevenLabsVoiceId
        val modelId = prefs.elevenLabsModel

        if (apiKey.isEmpty()) {
            Log.w("VoiceAgent", "ElevenLabs API Key is missing. Skipping voices synthesis.")
            return null
        }

        val url = "https://api.elevenlabs.io/v1/text-to-speech/$voiceId"

        val jsonBody = JSONObject().apply {
            put("text", textToSpeak)
            put("model_id", modelId)
            put("voice_settings", JSONObject().apply {
                put("stability", 0.75)
                put("similarity_boost", 0.75)
            })
        }

        val request = Request.Builder()
            .url(url)
            .header("xi-api-key", apiKey)
            .header("Content-Type", "application/json")
            .post(jsonBody.toString().toRequestBody("application/json".toMediaType()))
            .build()

        return try {
            val response = client.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.e("VoiceAgent", "ElevenLabs API responded with failure: ${response.code}")
                null
            } else {
                val outputFile = File(context.cacheDir, "elevenlabs_reply.mp3")
                response.body?.byteStream()?.use { inputStream ->
                    FileOutputStream(outputFile).use { outputStream ->
                        inputStream.copyTo(outputStream)
                    }
                }
                Log.d("VoiceAgent", "Successfully synthesized audio file of size: ${outputFile.length()} bytes")
                outputFile
            }
        } catch (e: Exception) {
            Log.e("VoiceAgent", "Error communicating with ElevenLabs server node", e)
            null
        }
    }

    // --- PI SPEAK LOCAL REMOTE GATEWAY ---
    private fun callLocalGatewayText(text: String): Pair<String, String> {
        val gatewayUrl = "${gatewayBaseUrl()}/v1/turn/text"
        Log.d("VoiceAgent", "POST text turn to gateway: $gatewayUrl")
        val requestBody = JSONObject().apply {
            put("session", prefs.codexSessionName)
            put("target", prefs.codexSessionName)
            put("agentProvider", activeGatewayProvider())
            put("text", text)
            put("audio", prefs.autoSpeakEnabled)
            put("cwd", prefs.workspacePath)
        }.toString().toRequestBody("application/json".toMediaType())

        val request = Request.Builder()
            .url(gatewayUrl)
            .header("X-Pi-Speak-Token", prefs.remoteToken)
            .post(requestBody)
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    val json = JSONObject(body)
                    val reply = json.optString("replyText", json.optString("reply", "Text turn successfully accepted by gateway."))
                    val audioUrl = json.optString("audioUrl", "")
                    if (audioUrl.isNotEmpty()) {
                        try {
                            downloadAudioFile(audioUrl)
                        } catch (e: Exception) {
                            Log.e("VoiceAgent", "Failed to download synthesized reply audio", e)
                        }
                    }
                    Pair(text, reply)
                } else {
                    Log.e("VoiceAgent", "Gateway text turn failed: ${response.code} ${response.message}")
                    Pair(text, "Local gateway returned operational status: ${response.code}")
                }
            }
        } catch (e: Exception) {
            Log.e("VoiceAgent", "Gateway text turn connection failed", e)
            Pair(text, "Gateway connection error: Ensure you are connected to the Tailscale subnet or Bluetooth local link. Details:\n${e.localizedMessage}")
        }
    }

    private fun callLocalGatewayVoice(audioFile: File): Pair<String, String> {
        val audioParam = if (prefs.autoSpeakEnabled) "1" else "0"
        val gatewayUrl = "${gatewayBaseUrl()}/v1/turn/voice?audio=$audioParam&target=${urlParam(prefs.codexSessionName)}&agentProvider=${urlParam(activeGatewayProvider())}&cwd=${urlParam(prefs.workspacePath)}"
        Log.d("VoiceAgent", "POST voice turn to gateway: $gatewayUrl")
        
        val requestBody = audioFile.asRequestBody(recordingMimeType(audioFile).toMediaType())

        val request = Request.Builder()
            .url(gatewayUrl)
            .header("X-Pi-Speak-Token", prefs.remoteToken)
            .post(requestBody)
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    val json = JSONObject(body)
                    val transcript = json.optString("transcript", "Synthesized voice command.")
                    val reply = json.optString("replyText", json.optString("reply", "Operation executed correctly."))
                    
                    val audioUrl = json.optString("audioUrl", "")
                    if (audioUrl.isNotEmpty()) {
                        try {
                            downloadAudioFile(audioUrl)
                        } catch (e: Exception) {
                            Log.e("VoiceAgent", "Failed to download synthesized reply audio", e)
                        }
                    }
                    Pair(transcript, reply)
                } else {
                    val errorBody = response.body?.string()?.take(240) ?: ""
                    Log.e("VoiceAgent", "Gateway voice turn failed: ${response.code} ${response.message} $errorBody")
                    Pair("Voice transmission completed.", "Operational status returned by remote: ${response.code}")
                }
            }
        } catch (e: Exception) {
            Log.e("VoiceAgent", "Gateway voice turn connection failed", e)
            val detail = e.localizedMessage ?: e.javaClass.simpleName
            Pair(
                "Voice transmission offline.",
                "Offline: Couldn't connect to target gateway IP (${gatewayBaseUrl()}). Verify Pi Speak machine service is hosting on port 8767. Details: $detail"
            )
        }
    }

    private fun downloadAudioFile(relativeUrl: String) {
        val fullUrl = if (relativeUrl.startsWith("http")) {
            relativeUrl
        } else {
            val base = gatewayBaseUrl()
            "$base${if (relativeUrl.startsWith("/")) "" else "/"}$relativeUrl"
        }
        Log.d("VoiceAgent", "GET gateway synthesized audio: $fullUrl")
        
        val request = Request.Builder()
            .url(fullUrl)
            .header("X-Pi-Speak-Token", prefs.remoteToken)
            .get()
            .build()
            
        client.newCall(request).execute().use { response ->
            if (response.isSuccessful) {
                val outputFile = File(context.cacheDir, "elevenlabs_reply.mp3")
                if (outputFile.exists()) {
                    outputFile.delete()
                }
                response.body?.byteStream()?.use { inputStream ->
                    FileOutputStream(outputFile).use { outputStream ->
                        inputStream.copyTo(outputStream)
                    }
                }
                Log.d("VoiceAgent", "Downloaded gateway synthesized audio to: ${outputFile.absolutePath}")
            } else {
                Log.e("VoiceAgent", "Gateway audio download failed: ${response.code}")
            }
        }
    }

    private fun simulateVoiceTranscription(): String {
        val promptExamples = listOf(
            "Review handleEvents on line 42 for leaks",
            "Generate optimized unit test configurations for Gradle build speed",
            "Recompile the release binary targets on main node",
            "Connect physical debug shell on Tailscale subnet",
            "Explain git status discrepancies in remote repository",
            "Verify dependencies sync in libs.versions.toml"
        )
        return promptExamples.random()
    }

    suspend fun discoverMachines(): List<DiscoveredMachine> {
        val targetIp = gatewayBaseUrl()
        val resultList = mutableListOf<DiscoveredMachine>()

        // 1. Attempt a Real Scan on the configured target gateway diagnostics
        try {
            val request = Request.Builder()
                .url("$targetIp/v1/diagnostics")
                .header("X-Pi-Speak-Token", prefs.remoteToken)
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    val json = JSONObject(body)
                    val diagnostics = json.optJSONObject("diagnostics")
                    if (diagnostics != null) {
                        val routing = diagnostics.optJSONObject("routing")
                        val statusObj = diagnostics.optJSONObject("status")
                        
                        val name = statusObj?.optJSONObject("remote")?.optString("host", "Connected-Pi-Node") ?: "Connected-Pi-Node"
                        val status = "online"
                        val currentSession = routing?.optString("currentSession", "Main-Project-Alpha") ?: "Main-Project-Alpha"
                        val availableTargets = routing?.optJSONArray("availableTargets")
                        
                        val sessions = mutableListOf<ActiveCodexSession>()
                        if (availableTargets != null && availableTargets.length() > 0) {
                            for (i in 0 until availableTargets.length()) {
                                val targetName = availableTargets.getString(i)
                                sessions.add(
                                    ActiveCodexSession(
                                        sessionId = targetName,
                                        engineType = "CODEX",
                                        description = "Active sandbox on $name.",
                                        status = if (targetName == currentSession) "active" else "idle"
                                    )
                                )
                            }
                        } else {
                            sessions.add(ActiveCodexSession(currentSession, "CODEX", "Standard compiler sandbox node", "active"))
                        }
                        
                        resultList.add(
                            DiscoveredMachine(
                                name = name,
                                ip = targetIp,
                                status = status,
                                latencyMs = 15L,
                                activeSessions = sessions
                            )
                        )
                    }
                }
            }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "Real target diagnostics discovery failed: ${e.message}")
        }

        return resultList
    }

    fun listWorkspace(path: String = prefs.workspacePath): WorkspaceListing? {
        val gatewayUrl = "${gatewayBaseUrl()}/v1/workspace?path=${urlParam(path)}"
        val request = Request.Builder()
            .url(gatewayUrl)
            .header("X-Pi-Speak-Token", prefs.remoteToken)
            .get()
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = response.body?.string() ?: return null
                val workspace = JSONObject(body).optJSONObject("workspace") ?: return null
                val entriesJson = workspace.optJSONArray("entries")
                val entries = mutableListOf<WorkspaceEntry>()
                if (entriesJson != null) {
                    for (i in 0 until entriesJson.length()) {
                        val item = entriesJson.optJSONObject(i) ?: continue
                        entries.add(
                            WorkspaceEntry(
                                name = item.optString("name"),
                                path = item.optString("path"),
                            )
                        )
                    }
                }
                WorkspaceListing(
                    root = workspace.optString("root"),
                    current = workspace.optString("current"),
                    parent = workspace.optString("parent").ifBlank { null },
                    defaultPath = workspace.optString("defaultPath").ifBlank { null },
                    entries = entries
                )
            }
        } catch (e: Exception) {
            Log.e("VoiceAgent", "Workspace listing failed", e)
            null
        }
    }

    private fun gatewayBaseUrl(): String = prefs.targetIpAddress.trim().trimEnd('/')

    private fun activeGatewayProvider(): String = when (prefs.activeAgent) {
        "Gateway Voice (ElevenLabs)" -> "elevenlabs"
        "Gateway Gemini (Vertex AI)" -> "gemini"
        else -> "codex"
    }

    private fun urlParam(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun recordingMimeType(file: File): String = when (file.extension.lowercase()) {
        "wav" -> "audio/wav"
        "mp3" -> "audio/mpeg"
        "m4a", "mp4" -> "audio/mp4"
        "webm" -> "audio/webm"
        "ogg" -> "audio/ogg"
        else -> "application/octet-stream"
    }
}

data class DiscoveredMachine(
    val name: String,
    val ip: String,
    val status: String,
    val latencyMs: Long,
    val activeSessions: List<ActiveCodexSession>
)

data class ActiveCodexSession(
    val sessionId: String,
    val engineType: String, // "CODEX" | "AGY" | "CLAUDE" | "KIMI"
    val description: String,
    val status: String
)

data class WorkspaceListing(
    val root: String,
    val current: String,
    val parent: String?,
    val defaultPath: String?,
    val entries: List<WorkspaceEntry>
)

data class WorkspaceEntry(
    val name: String,
    val path: String
)
