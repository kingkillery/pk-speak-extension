package com.example.api

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import com.example.data.AppPreferences
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class VoiceAgentClient(private val context: Context, private val prefs: AppPreferences) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()
    private val healthClient = OkHttpClient.Builder()
        .connectTimeout(1500, TimeUnit.MILLISECONDS)
        .readTimeout(1500, TimeUnit.MILLISECONDS)
        .writeTimeout(1500, TimeUnit.MILLISECONDS)
        .build()
    @Volatile
    private var activeTurnCall: Call? = null

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

    suspend fun sendTextTurnDetailed(text: String): GatewayTurnResult {
        val targetAgent = prefs.activeAgent
        Log.d("VoiceAgent", "Sending text turn using: $targetAgent")

        return withContext(Dispatchers.IO) {
            callLocalGatewayTextDetailed(text)
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

    suspend fun sendVoiceTurnDetailed(audioFile: File, fallbackPrompt: String = ""): GatewayTurnResult {
        val targetAgent = prefs.activeAgent
        Log.d("VoiceAgent", "Sending voice turn using: $targetAgent")

        val result = withContext(Dispatchers.IO) {
            callLocalGatewayVoiceDetailed(audioFile)
        }
        val reply = result.replyText.lowercase()
        if (reply.contains("operational status returned by remote: 502")
            || reply.contains("operational status returned by remote: 429")
            || reply.contains("voice transmission offline")
            || reply.contains("gateway connection error")) {
            val prompt = fallbackPrompt.trim()
            if (prompt.isNotEmpty() && !prompt.equals("Listening...", ignoreCase = true)) {
                return withContext(Dispatchers.IO) {
                    callLocalGatewayTextDetailed(prompt)
                }
            }
        }
        return result
    }

    suspend fun cancelTurn(): String {
        return withContext(Dispatchers.IO) {
            val gatewayUrl = "${gatewayBaseUrl()}/v1/turn/cancel"
            val request = Request.Builder()
                .url(gatewayUrl)
                .header("X-Pi-Speak-Token", prefs.remoteToken)
                .post(ByteArray(0).toRequestBody(null))
                .build()
            try {
                client.newCall(request).execute().use { response ->
                    val body = response.body?.string() ?: ""
                    if (!response.isSuccessful) {
                        return@withContext "Stop request failed: ${response.code}"
                    }
                    JSONObject(body).optString("message", "Stop request sent.")
                }
            } catch (e: Exception) {
                Log.e("VoiceAgent", "Turn cancellation failed", e)
                "Stop request failed: ${e.localizedMessage ?: e.javaClass.simpleName}"
            }
        }
    }

    fun cancelActiveTurnCall() {
        activeTurnCall?.cancel()
    }

    suspend fun pingHealth(): Boolean {
        return withContext(Dispatchers.IO) {
            pingHealth(gatewayBaseUrl())
        }
    }

    private fun pingHealth(baseUrl: String): Boolean {
        if (baseUrl.isBlank()) return false
        return try {
            val request = Request.Builder().url("${baseUrl.trim().trimEnd('/')}/health").get().build()
            healthClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return false
                val body = response.body?.string() ?: ""
                JSONObject(body).optString("app") == "pi-speak"
            }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "Health ping failed for $baseUrl: ${e.message}")
            false
        }
    }

    suspend fun testConnection(): ConnectionTestReport {
        return withContext(Dispatchers.IO) {
            val checks = mutableListOf<ConnectionCheck>()
            val baseUrl = gatewayBaseUrl()
            if (baseUrl.isBlank()) {
                return@withContext ConnectionTestReport(
                    ok = false,
                    summary = "No gateway URL is configured.",
                    checks = listOf(ConnectionCheck("Gateway URL", "fail", "Open setup QR or enter a gateway URL.")),
                    capabilities = emptyList()
                )
            }

            var descriptor: JSONObject? = null
            val healthOk = try {
                val request = Request.Builder().url("$baseUrl/health").get().build()
                client.newCall(request).execute().use { response ->
                    val ok = response.isSuccessful
                    checks.add(
                        ConnectionCheck(
                            label = "Health",
                            status = if (ok) "ok" else "fail",
                            detail = if (ok) "Gateway responded." else "Gateway returned ${response.code}."
                        )
                    )
                    ok
                }
            } catch (e: Exception) {
                checks.add(ConnectionCheck("Health", "fail", "Cannot reach $baseUrl. ${shortError(e)}"))
                false
            }

            val descriptorOk = try {
                val request = Request.Builder().url("$baseUrl/.well-known/pi-speak").get().build()
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        checks.add(ConnectionCheck("Descriptor", "fail", "Descriptor returned ${response.code}."))
                        false
                    } else {
                        val json = JSONObject(response.body?.string() ?: "{}")
                        descriptor = json
                        val ok = json.optString("app") == "pi-speak"
                        checks.add(
                            ConnectionCheck(
                                "Descriptor",
                                if (ok) "ok" else "fail",
                                if (ok) json.optString("name", "Pi Speak server detected.") else "Response was not a Pi Speak descriptor."
                            )
                        )
                        ok
                    }
                }
            } catch (e: Exception) {
                checks.add(ConnectionCheck("Descriptor", "fail", "Descriptor fetch failed. ${shortError(e)}"))
                false
            }

            var authOk = false
            var workspaceOk = false
            val statusOk = try {
                val request = Request.Builder()
                    .url("$baseUrl/v1/status")
                    .header("X-Pi-Speak-Token", prefs.remoteToken)
                    .get()
                    .build()
                client.newCall(request).execute().use { response ->
                    authOk = response.isSuccessful
                    checks.add(
                        ConnectionCheck(
                            "Auth / Status",
                            if (response.isSuccessful) "ok" else if (response.code == 401) "fail" else "warn",
                            when {
                                response.isSuccessful -> "Token accepted; status API is available."
                                response.code == 401 -> "Token rejected. Scan the setup QR again."
                                else -> "Status returned ${response.code}."
                            }
                        )
                    )
                    response.isSuccessful
                }
            } catch (e: Exception) {
                checks.add(ConnectionCheck("Auth / Status", "fail", "Status check failed. ${shortError(e)}"))
                false
            }

            if (statusOk) {
                workspaceOk = try {
                    val request = Request.Builder()
                        .url("$baseUrl/v1/workspace?path=${urlParam(prefs.workspacePath)}")
                        .header("X-Pi-Speak-Token", prefs.remoteToken)
                        .get()
                        .build()
                    client.newCall(request).execute().use { response ->
                        val ok = response.isSuccessful
                        checks.add(
                            ConnectionCheck(
                                "Workspace",
                                if (ok) "ok" else "warn",
                                if (ok) "Workspace browser can read ${prefs.workspacePath}." else "Workspace check returned ${response.code}."
                            )
                        )
                        ok
                    }
                } catch (e: Exception) {
                    checks.add(ConnectionCheck("Workspace", "warn", "Workspace check failed. ${shortError(e)}"))
                    false
                }
            }

            val capabilities = descriptor?.optJSONArray("capabilities")?.let { array ->
                (0 until array.length()).mapNotNull { i -> array.optString(i).takeIf { it.isNotBlank() } }
            } ?: emptyList()
            if (descriptorOk) {
                val required = listOf("text-turn", "voice-turn", "audio-reply", "routing", "turn-cancel", "progress-events")
                val available = required.filter { capabilities.contains(it) }
                checks.add(
                    ConnectionCheck(
                        "Capabilities",
                        if (available.containsAll(required)) "ok" else "warn",
                        if (available.isEmpty()) "Descriptor did not report turn capabilities." else available.joinToString(", ")
                    )
                )
            }

            val ok = healthOk && descriptorOk && authOk && workspaceOk
            ConnectionTestReport(
                ok = ok,
                summary = when {
                    ok -> "Connection ready."
                    !healthOk -> "Gateway is unreachable."
                    !descriptorOk -> "Server identity could not be verified."
                    !authOk -> "Setup required or token rejected."
                    else -> "Connected with warnings."
                },
                checks = checks,
                capabilities = capabilities
            )
        }
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
        val result = callLocalGatewayTextDetailed(text)
        return Pair(result.transcript, result.replyText)
    }

    private fun callLocalGatewayTextDetailed(text: String): GatewayTurnResult {
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

        val call = client.newCall(request)
        activeTurnCall = call

        return try {
            call.execute().use { response ->
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
                    GatewayTurnResult(text, reply, parseProgress(json))
                } else {
                    Log.e("VoiceAgent", "Gateway text turn failed: ${response.code} ${response.message}")
                    GatewayTurnResult(text, "Local gateway returned operational status: ${response.code}", statusCode = response.code)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (call.isCanceled()) {
                throw CancellationException("Local request cancelled")
            }
            Log.e("VoiceAgent", "Gateway text turn connection failed", e)
            GatewayTurnResult(
                transcript = text,
                replyText = "Gateway connection error: Ensure you are connected to the Tailscale subnet or Bluetooth local link. Details:\n${e.localizedMessage}",
                connectionError = true
            )
        } finally {
            if (activeTurnCall === call) {
                activeTurnCall = null
            }
        }
    }

    private fun callLocalGatewayVoice(audioFile: File): Pair<String, String> {
        val result = callLocalGatewayVoiceDetailed(audioFile)
        return Pair(result.transcript, result.replyText)
    }

    private fun callLocalGatewayVoiceDetailed(audioFile: File): GatewayTurnResult {
        val audioParam = if (prefs.autoSpeakEnabled) "1" else "0"
        val gatewayUrl = "${gatewayBaseUrl()}/v1/turn/voice?audio=$audioParam&target=${urlParam(prefs.codexSessionName)}&agentProvider=${urlParam(activeGatewayProvider())}&cwd=${urlParam(prefs.workspacePath)}"
        Log.d("VoiceAgent", "POST voice turn to gateway: $gatewayUrl")
        
        val requestBody = audioFile.asRequestBody(recordingMimeType(audioFile).toMediaType())

        val request = Request.Builder()
            .url(gatewayUrl)
            .header("X-Pi-Speak-Token", prefs.remoteToken)
            .post(requestBody)
            .build()

        val call = client.newCall(request)
        activeTurnCall = call

        return try {
            call.execute().use { response ->
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
                    GatewayTurnResult(transcript, reply, parseProgress(json))
                } else {
                    val errorBody = response.body?.string()?.take(240) ?: ""
                    Log.e("VoiceAgent", "Gateway voice turn failed: ${response.code} ${response.message} $errorBody")
                    GatewayTurnResult("Voice transmission completed.", "Operational status returned by remote: ${response.code}", statusCode = response.code)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (call.isCanceled()) {
                throw CancellationException("Local request cancelled")
            }
            Log.e("VoiceAgent", "Gateway voice turn connection failed", e)
            val detail = e.localizedMessage ?: e.javaClass.simpleName
            GatewayTurnResult(
                transcript = "Voice transmission offline.",
                replyText = "Offline: Couldn't connect to target gateway IP (${gatewayBaseUrl()}). Verify Pi Speak machine service is hosting on port 8767. Details: $detail",
                connectionError = true
            )
        } finally {
            if (activeTurnCall === call) {
                activeTurnCall = null
            }
        }
    }

    private fun parseProgress(json: JSONObject): List<String> {
        val progress = json.optJSONArray("progress") ?: return emptyList()
        val messages = mutableListOf<String>()
        for (i in 0 until progress.length()) {
            val item = progress.optJSONObject(i) ?: continue
            val message = item.optString("message")
            if (message.isNotBlank()) messages.add(message)
        }
        return messages
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
        return withContext(Dispatchers.IO) {
            val discovered = linkedMapOf<String, DiscoveredMachine>()
            (discoverMdnsMachines() + discoverUdpMachines()).forEach { machine ->
                discovered[machine.ip] = machine
            }
            if (discovered.isNotEmpty()) return@withContext discovered.values.toList()

            val targetIp = gatewayBaseUrl()
            if (targetIp.isBlank()) return@withContext emptyList()
            val resultList = mutableListOf<DiscoveredMachine>()

            // Fallback to the configured target gateway diagnostics.
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
                                    activeSessions = sessions,
                                    authRequired = true,
                                    pairingRequired = prefs.remoteToken.isBlank()
                                )
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                Log.d("VoiceAgent", "Real target diagnostics discovery failed: ${e.message}")
            }

            resultList
        }
    }

    private fun discoverMdnsMachines(): List<DiscoveredMachine> {
        val nsdManager = context.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return emptyList()
        val results = linkedMapOf<String, DiscoveredMachine>()
        val discoveryLatch = CountDownLatch(1)
        val resolveLatch = CountDownLatch(4)
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                Log.d("VoiceAgent", "mDNS discovery started for $serviceType")
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (serviceInfo.serviceType != "_pispeak._tcp.") return
                try {
                    nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                            Log.d("VoiceAgent", "mDNS resolve failed: $errorCode")
                            resolveLatch.countDown()
                        }

                        override fun onServiceResolved(resolved: NsdServiceInfo) {
                            try {
                                val host = resolved.host?.hostAddress
                                val port = resolved.port
                                if (!host.isNullOrBlank() && port > 0) {
                                    val baseUrl = "http://$host:$port"
                                    val machine = descriptorMachine(baseUrl, resolved.serviceName)
                                        ?: DiscoveredMachine(
                                            name = resolved.serviceName,
                                            ip = baseUrl,
                                            status = "online",
                                            latencyMs = 20L,
                                            activeSessions = listOf(ActiveCodexSession("default", "CODEX", "Discovered Pi Speak gateway", "idle")),
                                            authRequired = true,
                                            pairingRequired = prefs.remoteToken.isBlank(),
                                            setupUrl = "$baseUrl/setup"
                                        )
                                    synchronized(results) {
                                        results[machine.ip] = machine
                                    }
                                }
                            } finally {
                                resolveLatch.countDown()
                            }
                        }
                    })
                } catch (e: Exception) {
                    Log.d("VoiceAgent", "mDNS resolve request failed: ${e.message}")
                    resolveLatch.countDown()
                }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
            override fun onDiscoveryStopped(serviceType: String) {
                discoveryLatch.countDown()
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.d("VoiceAgent", "mDNS discovery start failed: $errorCode")
                try { nsdManager.stopServiceDiscovery(this) } catch (_: Exception) {}
                discoveryLatch.countDown()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                discoveryLatch.countDown()
            }
        }
        return try {
            nsdManager.discoverServices("_pispeak._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
            Thread.sleep(1800)
            try { nsdManager.stopServiceDiscovery(listener) } catch (_: Exception) {}
            discoveryLatch.await(800, TimeUnit.MILLISECONDS)
            resolveLatch.await(1200, TimeUnit.MILLISECONDS)
            synchronized(results) { results.values.toList() }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "mDNS discovery unavailable: ${e.message}")
            emptyList()
        }
    }

    private fun discoverUdpMachines(): List<DiscoveredMachine> {
        val results = linkedMapOf<String, DiscoveredMachine>()
        val multicastLock = (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
            ?.createMulticastLock("pi-speak-discovery")
        try {
            multicastLock?.setReferenceCounted(false)
            multicastLock?.acquire()
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = 900
                val nonce = UUID.randomUUID().toString()
                val payload = JSONObject()
                    .put("type", "pi-speak.discover")
                    .put("version", 1)
                    .put("nonce", nonce)
                    .toString()
                    .toByteArray(Charsets.UTF_8)
                val targets = listOf("255.255.255.255", "100.127.255.255")
                targets.forEach { target ->
                    try {
                        socket.send(DatagramPacket(payload, payload.size, InetAddress.getByName(target), 8768))
                    } catch (e: Exception) {
                        Log.d("VoiceAgent", "UDP discovery send failed for $target: ${e.message}")
                    }
                }
                val deadline = System.currentTimeMillis() + 1800
                val buffer = ByteArray(4096)
                while (System.currentTimeMillis() < deadline) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        val json = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
                        if (json.optString("type") != "pi-speak.announce") continue
                        if (json.optString("nonce") != nonce) continue
                        val port = json.optInt("httpPort", 8767)
                        val baseUrls = json.optJSONArray("baseUrls")
                        val baseUrl = firstBaseUrl(baseUrls) ?: "http://${packet.address.hostAddress}:$port"
                        val machine = descriptorMachine(baseUrl.trimEnd('/'), json.optString("name", "Pi Speak"))
                            ?: DiscoveredMachine(
                                name = json.optString("name", "Pi Speak"),
                                ip = baseUrl.trimEnd('/'),
                                status = "online",
                                latencyMs = 20L,
                                activeSessions = listOf(ActiveCodexSession("default", "CODEX", "Discovered Pi Speak gateway", "idle")),
                                authRequired = json.optBoolean("authRequired", true),
                                pairingRequired = json.optBoolean("authRequired", true) && prefs.remoteToken.isBlank(),
                                setupUrl = "${baseUrl.trimEnd('/')}/setup"
                            )
                        results[machine.ip] = machine
                    } catch (_: SocketTimeoutException) {
                        break
                    } catch (e: Exception) {
                        Log.d("VoiceAgent", "UDP discovery receive failed: ${e.message}")
                    }
                }
            }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "UDP discovery unavailable: ${e.message}")
        } finally {
            if (multicastLock?.isHeld == true) multicastLock.release()
        }
        return results.values.toList()
    }

    private fun firstBaseUrl(baseUrls: org.json.JSONArray?): String? {
        if (baseUrls == null) return null
        for (i in 0 until baseUrls.length()) {
            val value = baseUrls.optString(i).trim().trimEnd('/')
            if (value.isNotBlank()) return value
        }
        return null
    }

    private fun descriptorMachine(baseUrl: String, fallbackName: String): DiscoveredMachine? {
        val descriptorUrl = "$baseUrl/.well-known/pi-speak"
        val started = System.currentTimeMillis()
        return try {
            val request = Request.Builder().url(descriptorUrl).get().build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = response.body?.string() ?: return null
                val json = JSONObject(body)
                if (json.optString("app") != "pi-speak") return null
                val endpoints = json.optJSONObject("endpoints")
                val pairing = json.optJSONObject("pairing")
                val authRequired = json.optBoolean("authRequired", false)
                val pairingRequired = pairing?.optBoolean("required", json.optBoolean("pairingRequired", authRequired))
                    ?: json.optBoolean("pairingRequired", authRequired)
                val setupPath = endpoints?.optString("setup", "/setup")?.ifBlank { "/setup" } ?: "/setup"
                val sessions = mutableListOf<ActiveCodexSession>()
                val agent = json.optJSONObject("agent")
                val provider = agent?.optString("provider", "CODEX")?.uppercase() ?: "CODEX"
                sessions.add(ActiveCodexSession(prefs.codexSessionName.ifBlank { "default" }, provider, "Discovered Pi Speak gateway", "idle"))
                DiscoveredMachine(
                    name = json.optString("name", fallbackName),
                    ip = baseUrl,
                    status = if (endpoints != null) "online" else "unknown",
                    latencyMs = (System.currentTimeMillis() - started).coerceAtLeast(1),
                    activeSessions = sessions,
                    authRequired = authRequired,
                    pairingRequired = pairingRequired,
                    setupUrl = setupUrl(baseUrl, setupPath)
                )
            }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "Descriptor fetch failed for $baseUrl: ${e.message}")
            null
        }
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

    suspend fun getSessionDashboard(): GatewaySessionDashboard {
        return withContext(Dispatchers.IO) {
            val baseUrl = gatewayBaseUrl()
            if (baseUrl.isBlank()) {
                throw GatewaySessionException(
                    GatewaySessionErrorKind.Network,
                    "Configure a gateway URL to load remote sessions."
                )
            }
            val request = Request.Builder()
                .url("$baseUrl/v1/sessions")
                .header("X-Pi-Speak-Token", prefs.remoteToken)
                .get()
                .build()

            try {
                client.newCall(request).execute().use { response ->
                    val body = response.body?.string() ?: ""
                    when (response.code) {
                        401 -> throw GatewaySessionException(
                            GatewaySessionErrorKind.Unauthorized,
                            "Gateway token required or invalid."
                        )
                        501 -> throw GatewaySessionException(
                            GatewaySessionErrorKind.Unsupported,
                            "This gateway does not expose the session dashboard."
                        )
                    }
                    if (!response.isSuccessful) {
                        throw GatewaySessionException(
                            GatewaySessionErrorKind.Unknown,
                            "Session dashboard request failed: ${response.code}"
                        )
                    }
                    val json = try {
                        JSONObject(body)
                    } catch (e: Exception) {
                        throw GatewaySessionException(
                            GatewaySessionErrorKind.Malformed,
                            "Gateway returned an unreadable sessions response.",
                            e
                        )
                    }
                    if (!json.optBoolean("ok", false)) {
                        throw GatewaySessionException(
                            GatewaySessionErrorKind.Unknown,
                            json.optString("error", "Session dashboard request failed.")
                        )
                    }
                    val dashboardJson = json.optJSONObject("dashboard")
                        ?: throw GatewaySessionException(
                            GatewaySessionErrorKind.Malformed,
                            "Gateway sessions response did not include a dashboard."
                        )
                    parseGatewaySessionDashboard(dashboardJson)
                }
            } catch (e: GatewaySessionException) {
                throw e
            } catch (e: Exception) {
                throw GatewaySessionException(
                    GatewaySessionErrorKind.Network,
                    "Could not reach gateway.",
                    e
                )
            }
        }
    }

    private fun parseGatewaySessionDashboard(json: JSONObject): GatewaySessionDashboard {
        val readyJson = json.optJSONArray("ready")
        val ready = mutableListOf<String>()
        if (readyJson != null) {
            for (i in 0 until readyJson.length()) {
                val value = readyJson.optString(i)
                if (value.isNotBlank()) ready.add(value)
            }
        }

        val sessionsJson = json.optJSONArray("sessions")
        val sessions = mutableListOf<GatewaySessionEntry>()
        if (sessionsJson != null) {
            for (i in 0 until sessionsJson.length()) {
                val item = sessionsJson.optJSONObject(i) ?: continue
                sessions.add(parseGatewaySessionEntry(item))
            }
        }

        return GatewaySessionDashboard(
            current = json.optString("current"),
            ready = ready,
            storePath = json.optString("storePath").ifBlank { null },
            sessions = sessions
        )
    }

    private fun parseGatewaySessionEntry(json: JSONObject): GatewaySessionEntry {
        val aliasesJson = json.optJSONArray("aliases")
        val aliases = mutableListOf<String>()
        if (aliasesJson != null) {
            for (i in 0 until aliasesJson.length()) {
                val value = aliasesJson.optString(i)
                if (value.isNotBlank()) aliases.add(value)
            }
        }
        val resumeCommandJson = json.optJSONArray("resumeCommand")
        val resumeCommand = mutableListOf<String>()
        if (resumeCommandJson != null) {
            for (i in 0 until resumeCommandJson.length()) {
                val value = resumeCommandJson.optString(i)
                if (value.isNotBlank()) resumeCommand.add(value)
            }
        }
        return GatewaySessionEntry(
            name = json.optString("name"),
            path = json.optString("path").ifBlank { null },
            sessionPath = json.optString("sessionPath").ifBlank { null },
            provider = json.optString("provider").ifBlank { null },
            sessionId = json.optString("sessionId").ifBlank { null },
            resumable = json.optBoolean("resumable", false),
            resumeCommand = resumeCommand,
            workingDirectory = json.optString("workingDirectory").ifBlank { null },
            cwd = json.optString("cwd").ifBlank { null },
            current = json.optBoolean("current", false),
            isCurrent = json.optBoolean("isCurrent", false),
            ready = json.optBoolean("ready", false),
            isReady = json.optBoolean("isReady", false),
            activity = json.optString("activity").ifBlank { null },
            aliases = aliases
        )
    }

    suspend fun resumeGatewaySession(entry: GatewaySessionEntry): String {
        return withContext(Dispatchers.IO) {
            val cwd = entry.workingDirectory?.takeIf { it.isNotBlank() }
                ?: entry.cwd?.takeIf { it.isNotBlank() }
            val requestBody = JSONObject().apply {
                entry.provider?.takeIf { it.isNotBlank() }?.let { put("provider", it) }
                entry.sessionId?.takeIf { it.isNotBlank() }?.let { put("sessionId", it) }
                entry.canonicalSessionPath?.takeIf { it.isNotBlank() }?.let { put("sessionPath", it) }
                cwd?.let { put("cwd", it) }
            }.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("${gatewayBaseUrl()}/v1/sessions/resume")
                .header("X-Pi-Speak-Token", prefs.remoteToken)
                .post(requestBody)
                .build()
            try {
                client.newCall(request).execute().use { response ->
                    val body = response.body?.string() ?: "{}"
                    val json = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
                    if (!response.isSuccessful || !json.optBoolean("ok", false)) {
                        return@withContext json.optString("error", json.optString("message", "Session resume failed: ${response.code}"))
                    }
                    json.optString("message", "Session resume launched.")
                }
            } catch (e: Exception) {
                Log.e("VoiceAgent", "Session resume failed", e)
                "Session resume failed: ${shortError(e)}"
            }
        }
    }

    suspend fun listSlashCommands(): List<RemoteSlashCommand> {
        return withContext(Dispatchers.IO) {
            val gatewayUrl = "${gatewayBaseUrl()}/v1/commands"
            val request = Request.Builder()
                .url(gatewayUrl)
                .header("X-Pi-Speak-Token", prefs.remoteToken)
                .get()
                .build()

            try {
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@withContext emptyList()
                    val body = response.body?.string() ?: return@withContext emptyList()
                    val commandsJson = JSONObject(body).optJSONArray("commands") ?: return@withContext emptyList()
                    val commands = mutableListOf<RemoteSlashCommand>()
                    for (i in 0 until commandsJson.length()) {
                        val item = commandsJson.optJSONObject(i) ?: continue
                        val examplesJson = item.optJSONArray("examples")
                        val examples = mutableListOf<String>()
                        if (examplesJson != null) {
                            for (j in 0 until examplesJson.length()) {
                                val example = examplesJson.optString(j)
                                if (example.isNotBlank()) examples.add(example)
                            }
                        }
                        commands.add(
                            RemoteSlashCommand(
                                name = item.optString("name"),
                                description = item.optString("description"),
                                usage = item.optString("usage"),
                                examples = examples
                            )
                        )
                    }
                    commands.filter { it.name.isNotBlank() }
                }
            } catch (e: Exception) {
                Log.e("VoiceAgent", "Slash command list failed", e)
                emptyList()
            }
        }
    }

    /**
     * Unified Remote-style auto-connect.
     * 1. Try localhost first (ADB reverse, same-machine).
     * 2. Fall back to network discovery (LAN / Tailscale via mDNS + UDP).
     * If anything is found, configures prefs silently and returns true.
     */
    fun tryAutoConnect(forceVerify: Boolean = false): AutoConnectResult {
        val currentUrl = gatewayBaseUrl()
        if (forceVerify && currentUrl.isNotBlank() && pingHealth(currentUrl)) {
            val pairingState = getPairingState(currentUrl)
            if (pairingState.requiresPairing && prefs.remoteToken.isBlank()) {
                return AutoConnectResult(false, currentUrl, "Gateway found. Scan the setup QR from /pk-remote to pair this phone.", discovered = false)
            }
            if (prefs.remoteToken.isNotBlank() && pairingState.authRequired && !isAuthenticatedGateway(currentUrl)) {
                return AutoConnectResult(false, currentUrl, "Gateway found, but the saved token was rejected. Scan the setup QR again.", discovered = false)
            }
            return AutoConnectResult(true, currentUrl, "Current gateway is reachable.", discovered = false)
        }

        // Phase 1: localhost probe (fast, no network needed)
        val localhostUrl = "http://localhost:8767"
        if (pingHealth(localhostUrl)) {
            val pairingState = getPairingState(localhostUrl)
            if (pairingState.requiresPairing && prefs.remoteToken.isBlank()) {
                return AutoConnectResult(false, localhostUrl, "Local gateway found. Scan the setup QR from /pk-remote to pair this phone.", discovered = true)
            }
            if (prefs.remoteToken.isNotBlank() && pairingState.authRequired && !isAuthenticatedGateway(localhostUrl)) {
                return AutoConnectResult(false, localhostUrl, "Local gateway found, but the saved token was rejected. Scan the setup QR again.", discovered = true)
            }
            prefs.targetIpAddress = localhostUrl
            applyDescriptorSession(localhostUrl)
            Log.d("VoiceAgent", "Auto-connected to localhost gateway: $localhostUrl")
            return AutoConnectResult(true, localhostUrl, "Connected through local ADB reverse.", discovered = true)
        }

        // Phase 2: network discovery (LAN / Tailscale)
        return try {
            val machines = kotlinx.coroutines.runBlocking { discoverMachines() }
            val onlineMachine = machines.firstOrNull { it.status == "online" }
                ?: machines.firstOrNull()
            if (onlineMachine != null) {
                if (onlineMachine.requiresPairing && prefs.remoteToken.isBlank()) {
                    return AutoConnectResult(false, onlineMachine.ip, "Gateway found. Run /pk-remote on the computer and scan the setup QR to pair.", discovered = true)
                }
                if (prefs.remoteToken.isNotBlank() && onlineMachine.authRequired && !isAuthenticatedGateway(onlineMachine.ip)) {
                    return AutoConnectResult(false, onlineMachine.ip, "Discovered gateway rejected the saved token. Scan the setup QR again.", discovered = true)
                }
                prefs.targetIpAddress = onlineMachine.ip
                val firstSession = onlineMachine.activeSessions.firstOrNull()
                if (firstSession != null) {
                    prefs.codexSessionName = firstSession.sessionId
                }
                Log.d("VoiceAgent", "Auto-connected to network gateway: ${onlineMachine.ip}")
                AutoConnectResult(true, onlineMachine.ip, "Connected to discovered gateway.", discovered = true)
            } else {
                AutoConnectResult(false, currentUrl, "No reachable Pi Speak gateway found.")
            }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "Network auto-connect probe failed: ${e.message}")
            AutoConnectResult(false, currentUrl, "Gateway discovery failed: ${shortError(e)}")
        }
    }

    private fun getPairingState(baseUrl: String): PairingState {
        val normalized = baseUrl.trim().trimEnd('/')
        if (normalized.isBlank()) return PairingState(authRequired = true, pairingRequired = true)
        return try {
            val request = Request.Builder().url("$normalized/.well-known/pi-speak").get().build()
            healthClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return PairingState(authRequired = true, pairingRequired = true)
                val json = JSONObject(response.body?.string() ?: "{}")
                val authRequired = json.optBoolean("authRequired", true)
                val pairing = json.optJSONObject("pairing")
                val pairingRequired = pairing?.optBoolean("required", json.optBoolean("pairingRequired", authRequired))
                    ?: json.optBoolean("pairingRequired", authRequired)
                PairingState(authRequired = authRequired, pairingRequired = pairingRequired)
            }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "Pairing descriptor check failed for $baseUrl: ${e.message}")
            PairingState(authRequired = true, pairingRequired = true)
        }
    }

    private fun isAuthenticatedGateway(baseUrl: String): Boolean {
        val normalized = baseUrl.trim().trimEnd('/')
        if (normalized.isBlank()) return false
        return try {
            val request = Request.Builder()
                .url("$normalized/v1/status")
                .header("X-Pi-Speak-Token", prefs.remoteToken)
                .get()
                .build()
            healthClient.newCall(request).execute().use { response -> response.isSuccessful }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "Authenticated gateway check failed for $baseUrl: ${e.message}")
            false
        }
    }

    private fun setupUrl(baseUrl: String, setupPath: String): String {
        val normalizedBase = baseUrl.trim().trimEnd('/')
        val normalizedPath = if (setupPath.startsWith("/")) setupPath else "/$setupPath"
        return "$normalizedBase$normalizedPath"
    }

    private fun applyDescriptorSession(baseUrl: String) {
        try {
            val descRequest = Request.Builder().url("$baseUrl/.well-known/pi-speak").get().build()
            client.newCall(descRequest).execute().use { descResponse ->
                if (descResponse.isSuccessful) {
                    val descBody = descResponse.body?.string() ?: ""
                    val descJson = JSONObject(descBody)
                    val routing = descJson.optJSONObject("routing")
                    val currentSession = routing?.optString("currentSession", "")
                    if (!currentSession.isNullOrBlank()) {
                        prefs.codexSessionName = currentSession
                    }
                    val defaultTarget = routing?.optString("defaultTarget", "")
                    if (!defaultTarget.isNullOrBlank() && prefs.codexSessionName.isBlank()) {
                        prefs.codexSessionName = defaultTarget
                    }
                }
            }
        } catch (e: Exception) {
            Log.d("VoiceAgent", "Descriptor fetch failed: ${e.message}")
        }
    }

    private fun gatewayBaseUrl(): String = prefs.targetIpAddress.trim().trimEnd('/')

    private fun shortError(error: Exception): String = error.localizedMessage ?: error.javaClass.simpleName

    private fun activeGatewayProvider(): String = when (prefs.activeAgent) {
        "Gateway Claude (Claude Code)" -> "claude"
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
    val activeSessions: List<ActiveCodexSession>,
    val authRequired: Boolean = false,
    val pairingRequired: Boolean = false,
    val setupUrl: String? = null
) {
    val requiresPairing: Boolean
        get() = authRequired || pairingRequired
}

private data class PairingState(
    val authRequired: Boolean,
    val pairingRequired: Boolean
) {
    val requiresPairing: Boolean
        get() = authRequired || pairingRequired
}

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

data class RemoteSlashCommand(
    val name: String,
    val description: String,
    val usage: String,
    val examples: List<String>
)

data class ConnectionCheck(
    val label: String,
    val status: String,
    val detail: String
)

data class ConnectionTestReport(
    val ok: Boolean,
    val summary: String,
    val checks: List<ConnectionCheck>,
    val capabilities: List<String>
)

data class GatewayTurnResult(
    val transcript: String,
    val replyText: String,
    val progress: List<String> = emptyList(),
    val connectionError: Boolean = false,
    val statusCode: Int? = null
)

data class AutoConnectResult(
    val connected: Boolean,
    val baseUrl: String = "",
    val message: String = "",
    val discovered: Boolean = false
)
