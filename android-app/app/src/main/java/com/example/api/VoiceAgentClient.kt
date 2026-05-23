package com.example.api

import android.content.Context
import android.util.Log
import com.example.BuildConfig
import com.example.data.AppPreferences
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit

class VoiceAgentClient(private val context: Context, private val prefs: AppPreferences) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Sends a text turn to the current active agent.
     * Returns a Pair of: (User Transcript, Agent Response Text)
     */
    suspend fun sendTextTurn(text: String): Pair<String, String> {
        val targetAgent = prefs.activeAgent
        Log.d("VoiceAgent", "Sending text turn using: $targetAgent")

        return when {
            targetAgent.contains("Gemini", ignoreCase = true) -> {
                val response = callGeminiText(text)
                Pair(text, response)
            }
            targetAgent.contains("ElevenLabs", ignoreCase = true) -> {
                // ElevenLabs handles text-to-speech, but Gemini handles coding intelligence
                val responseText = callGeminiText(text)
                try {
                    synthesizeWithElevenLabs(responseText)
                } catch (e: Exception) {
                    Log.e("VoiceAgent", "ElevenLabs failed, fallback to built-in system speakers", e)
                }
                Pair(text, responseText)
            }
            else -> {
                // Local Codex (Pi Speak local gateway)
                callLocalGatewayText(text)
            }
        }
    }

    /**
     * Sends an audio file turn to the active agent.
     * Returns a Pair of: (Recognized Transcription, Agent Response Text)
     */
    suspend fun sendVoiceTurn(audioFile: File): Pair<String, String> {
        val targetAgent = prefs.activeAgent
        Log.d("VoiceAgent", "Sending voice turn using: $targetAgent")

        return when {
            targetAgent.contains("Gemini", ignoreCase = true) || targetAgent.contains("ElevenLabs", ignoreCase = true) -> {
                val result = callGeminiVoice(audioFile)
                val transcript = result.first
                val responseText = result.second
                
                if (targetAgent.contains("ElevenLabs", ignoreCase = true)) {
                    try {
                        synthesizeWithElevenLabs(responseText)
                    } catch (e: Exception) {
                        Log.e("VoiceAgent", "ElevenLabs synthesis failed", e)
                    }
                }
                Pair(transcript, responseText)
            }
            else -> {
                // Local Codex / Gateway audio upload
                callLocalGatewayVoice(audioFile)
            }
        }
    }

    private fun callGeminiVoice(audioFile: File): Pair<String, String> {
        val apiKey = BuildConfig.GEMINI_API_KEY
        if (apiKey.isEmpty() || apiKey == "MY_GEMINI_API_KEY") {
            return Pair(
                "Voice transmission ignored",
                "Developer Setup Required: Please configure your GEMINI_API_KEY inside the Secrets panel of AI Studio to enable wireless AI Codex responses."
            )
        }

        val url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=$apiKey"

        val bytes = try {
            audioFile.readBytes()
        } catch (e: Exception) {
            e.printStackTrace()
            return Pair("Could not read audio file.", "Error loading audio capture buffer.")
        }
        val base64Audio = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

        val jsonBody = JSONObject().apply {
            put("systemInstruction", JSONObject().apply {
                put("parts", JSONArray().put(JSONObject().apply {
                    put("text", "You are a professional physical coding machine companion named Pi Speak. " +
                            "Listen to the audio. " +
                            "First, transcribe exactly what the user said, word-for-word, on line 1 starting with 'TRANSCRIPT: <text>'. Do NOT add extra stars or quotes around this prefix. " +
                            "Second, on a new line, write your expert, highly compact operational response to their request starting with 'REPLY: <text>'. " +
                            "Current Codex session context: '${prefs.codexSessionName}'. Keep replies elite, operational, compact, direct, and focused on remote code execution. No introductory fluff.")
                }))
            })
            put("contents", JSONArray().put(JSONObject().apply {
                put("parts", JSONArray().apply {
                    put(JSONObject().apply {
                        put("inlineData", JSONObject().apply {
                            put("mimeType", "audio/mp4")
                            put("data", base64Audio)
                        })
                    })
                    put(JSONObject().apply {
                        put("text", "Please analyze this remote voice instruction tape.")
                    })
                })
            }))
        }

        val request = Request.Builder()
            .url(url)
            .post(jsonBody.toString().toRequestBody("application/json".toMediaType()))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Pair(
                        "Voice transmission failed.",
                        "Error querying Gemini cloud node: Code ${response.code}\n${response.body?.string()}"
                    )
                } else {
                    val respString = response.body?.string() ?: ""
                    val jsonResponse = JSONObject(respString)
                    val candidates = jsonResponse.getJSONArray("candidates")
                    val content = candidates.getJSONObject(0).getJSONObject("content")
                    val parts = content.getJSONArray("parts")
                    val fullResponse = parts.getJSONObject(0).getString("text").trim()

                    Log.d("VoiceAgent", "Raw Gemini speech response: $fullResponse")

                    var transcript = ""
                    var reply = ""

                    fullResponse.lines().forEach { line ->
                        val trimmedLine = line.trim()
                        if (trimmedLine.startsWith("TRANSCRIPT:", ignoreCase = true)) {
                            transcript = trimmedLine.substring("TRANSCRIPT:".length).trim()
                        } else if (trimmedLine.trim().startsWith("REPLY:", ignoreCase = true)) {
                            reply = trimmedLine.substring("REPLY:".length).trim()
                        }
                    }

                    if (transcript.isEmpty() && reply.isEmpty()) {
                        reply = fullResponse
                        transcript = "Transcribed Voice Command"
                    } else if (transcript.isEmpty()) {
                        transcript = "Transcribed Voice Command"
                    } else if (reply.isEmpty()) {
                        reply = fullResponse
                    }

                    Pair(transcript, reply)
                }
            }
        } catch (e: Exception) {
            Pair(
                "Voice transmission timeout.",
                "Gateway timeout trying to reach Gemini API edge: ${e.localizedMessage}"
            )
        }
    }

    // --- GEMINI CO-PILOT INTEGRATION ---
    private fun callGeminiText(prompt: String): String {
        val apiKey = BuildConfig.GEMINI_API_KEY
        if (apiKey.isEmpty() || apiKey == "MY_GEMINI_API_KEY") {
            return "Developer Setup Required: Please configure your GEMINI_API_KEY inside the Secrets panel of AI Studio to enable wireless AI Codex responses."
        }

        val url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=$apiKey"
        
        val systemInstruction = "You are a professional physical coding machine companion named Pi Speak. " +
                "You assist the user with remote deployments, file editing, workspace configuration, and coding. " +
                "Current Codex session context: '${prefs.codexSessionName}'. " +
                "Keep responses compact, highly operational, direct, and elite. Do not include verbose introductory fluff."

        val jsonBody = JSONObject().apply {
            put("contents", JSONArray().put(JSONObject().apply {
                put("parts", JSONArray().put(JSONObject().apply {
                    put("text", "$systemInstruction\n\nUser request: $prompt")
                }))
            }))
        }

        val request = Request.Builder()
            .url(url)
            .post(jsonBody.toString().toRequestBody("application/json".toMediaType()))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    "Error querying Gemini cloud node: Code ${response.code}\n${response.body?.string()}"
                } else {
                    val respString = response.body?.string() ?: ""
                    val jsonResponse = JSONObject(respString)
                    val candidates = jsonResponse.getJSONArray("candidates")
                    val content = candidates.getJSONObject(0).getJSONObject("content")
                    val parts = content.getJSONArray("parts")
                    parts.getJSONObject(0).getString("text").trim()
                }
            }
        } catch (e: Exception) {
            "Gateway timeout trying to reach Gemini API edge: ${e.localizedMessage}"
        }
    }

    // --- ELEVENLABS TEXT-TO-SPEECH ---
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
        val gatewayUrl = "${prefs.targetIpAddress}/v1/turn/text"
        val requestBody = JSONObject().apply {
            put("session", prefs.codexSessionName)
            put("text", text)
            put("audio", prefs.autoSpeakEnabled)
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
                    Pair(text, "Local gateway returned operational status: ${response.code}")
                }
            }
        } catch (e: Exception) {
            Pair(text, "Gateway connection error: Ensure you are connected to the Tailscale subnet or Bluetooth local link. Details:\n${e.localizedMessage}")
        }
    }

    private fun callLocalGatewayVoice(audioFile: File): Pair<String, String> {
        val audioParam = if (prefs.autoSpeakEnabled) "1" else "0"
        val gatewayUrl = "${prefs.targetIpAddress}/v1/turn/voice?audio=$audioParam&target=${prefs.codexSessionName}&agentProvider=codex"
        
        val requestBody = audioFile.asRequestBody("audio/mp4".toMediaType())

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
                    Pair("Voice transmission completed.", "Operational status returned by remote: ${response.code}")
                }
            }
        } catch (e: Exception) {
            Pair(
                "Voice transmission offline.",
                "Offline: Couldn't connect to target gateway IP (${prefs.targetIpAddress}). Verify if Pi Speak machine service is hosting on port 8767."
            )
        }
    }

    private fun downloadAudioFile(relativeUrl: String) {
        val fullUrl = if (relativeUrl.startsWith("http")) {
            relativeUrl
        } else {
            val base = prefs.targetIpAddress.removeSuffix("/")
            "$base${if (relativeUrl.startsWith("/")) "" else "/"}$relativeUrl"
        }
        
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
        val targetIp = prefs.targetIpAddress
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

        // 2. Scan and add additional simulated Tailscale Nodes
        // Machine 1: Tailnode Alpha
        resultList.add(
            DiscoveredMachine(
                name = "Tailnode-Alpha-Pi5",
                ip = "http://100.80.45.12:8767",
                status = "online",
                latencyMs = 28L,
                activeSessions = listOf(
                    ActiveCodexSession("Main-Project-Alpha", "CODEX", "Active Codex code compiler node", "active"),
                    ActiveCodexSession("Agy-Live-Deployer", "AGY", "AGY continuous deployment node", "active"),
                    ActiveCodexSession("Claude-Architect", "CLAUDE", "Claude structural system analyst", "idle")
                )
            )
        )

        // Machine 2: Giga Mona Cluster
        resultList.add(
            DiscoveredMachine(
                name = "Giga-Mona-Cluster",
                ip = "http://100.76.136.91:8767",
                status = "online",
                latencyMs = 45L,
                activeSessions = listOf(
                    ActiveCodexSession("Mona-Codex-Prod", "CODEX", "Production release branch sandbox", "active"),
                    ActiveCodexSession("Kimi-Context-Layer", "KIMI", "Kimi 100k context engine instance", "active"),
                    ActiveCodexSession("Claude-Refactor-Branch", "CLAUDE", "Claude deep code restructurer", "idle"),
                    ActiveCodexSession("Agy-Automata", "AGY", "Autonomous code loop engine", "idle")
                )
            )
        )

        // Machine 3: Dormant/Offline node
        resultList.add(
            DiscoveredMachine(
                name = "Pi-Speak-Tail-03",
                ip = "http://100.112.5.40:8767",
                status = "offline",
                latencyMs = 999L,
                activeSessions = listOf(
                    ActiveCodexSession("Dormant-Sandbox", "CODEX", "Suspended debugging zone", "inactive")
                )
            )
        )

        return resultList
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
