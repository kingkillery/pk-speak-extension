package com.example.api

import android.util.Log
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Tails one hub agent's live transcript via /v1/herdr/stream/:id (SSE). Mirrors
 * GatewayEventStream's reconnect/backoff shape, but for a single agent's `append`/`status`
 * frames. Only one stream per agent id may be open on the gateway at a time -- opening a
 * second one server-side "supersedes" the first, so callers should stop() before switching
 * to a different agent.
 */
class HerdrAgentStream(
    private val baseUrl: String,
    private val token: String,
    private val agentId: String,
    private val startFromByte: Long = 0L,
    private val onAppend: (fromByte: Long, newSize: Long, text: String) -> Unit,
    private val onStatus: (status: String, lastActivityMs: Long) -> Unit,
    private val onStateChange: (connected: Boolean, detail: String) -> Unit
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .build()

    @Volatile
    private var stopped = false
    @Volatile
    private var activeCall: Call? = null
    private var fromByte = startFromByte
    private var thread: Thread? = null

    fun start() {
        if (thread != null) return
        thread = Thread({ runLoop() }, "herdr-agent-stream-$agentId").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        stopped = true
        activeCall?.cancel()
        thread?.interrupt()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private fun runLoop() {
        var attempt = 0
        while (!stopped) {
            val normalized = baseUrl.trim().trimEnd('/')
            if (normalized.isBlank()) {
                onStateChange(false, "No gateway URL configured.")
                return
            }
            var call: Call? = null
            try {
                val encodedId = URLEncoder.encode(agentId, "UTF-8").replace("+", "%20")
                val request = Request.Builder()
                    .url("$normalized/v1/herdr/stream/$encodedId?fromByte=$fromByte")
                    .header("X-Pi-Speak-Token", token)
                    .header("Accept", "text/event-stream")
                    .get()
                    .build()
                val currentCall = client.newCall(request)
                call = currentCall
                activeCall = currentCall
                currentCall.execute().use { response ->
                    if (!response.isSuccessful) {
                        onStateChange(false, "Stream unavailable (${response.code}).")
                        if (response.code == 401 || response.code == 404) return
                    } else {
                        attempt = 0
                        onStateChange(true, "Live")
                        val source = response.body?.source() ?: return@use
                        var dataBuffer = StringBuilder()
                        var frameEventName = ""
                        while (!stopped) {
                            val line = source.readUtf8Line() ?: break
                            when {
                                line.startsWith("event:") -> frameEventName = line.removePrefix("event:").trim()
                                line.startsWith("data:") -> dataBuffer.append(line.removePrefix("data:").trim())
                                line.isEmpty() -> {
                                    if (dataBuffer.isNotEmpty()) {
                                        handleFrame(frameEventName, dataBuffer.toString())
                                        dataBuffer = StringBuilder()
                                    }
                                    frameEventName = ""
                                }
                                // "retry:" and ":heartbeat" comment lines need no handling.
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                if (stopped) break
                Log.d("HerdrAgentStream", "Stream dropped for $agentId: ${e.message}")
            } finally {
                if (activeCall === call) activeCall = null
            }
            if (stopped) break
            onStateChange(false, "Reconnecting…")
            attempt++
            try {
                Thread.sleep((2000L * attempt).coerceAtMost(15_000L))
            } catch (_: InterruptedException) {
                if (stopped) break
                Thread.currentThread().interrupt()
                break
            }
        }
        onStateChange(false, "Stopped")
    }

    private fun handleFrame(eventName: String, data: String) {
        val json = try { JSONObject(data) } catch (_: Exception) { return }
        when (eventName) {
            "append" -> {
                val newSize = json.optLong("newSize", fromByte)
                onAppend(json.optLong("fromByte", fromByte), newSize, json.optString("text"))
                fromByte = newSize
            }
            "status" -> onStatus(json.optString("status"), json.optLong("lastActivityMs", 0L))
            "superseded" -> {
                stopped = true
                onStateChange(false, "Opened elsewhere.")
            }
        }
    }
}
