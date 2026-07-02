package com.example.api

import android.util.Log
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Tails the gateway's /v1/events SSE feed. The server flushes every buffered
 * event past `since` on connect, then polls twice a second and emits
 * `:keep-alive` comments every 15s, so a bounded read timeout doubles as a
 * dead-connection detector. Reconnects with an updated `since` offset (the
 * server offset is a line count, so received-event count carries it forward).
 */
class GatewayEventStream(
    private val baseUrl: String,
    private val token: String,
    private val startOffset: Int = 0,
    private val onEvent: (GatewayEvent) -> Unit,
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
    private var receivedCount = 0
    private var thread: Thread? = null

    fun start() {
        if (thread != null) return
        thread = Thread({ runLoop() }, "gateway-event-stream").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        stopped = true
        activeCall?.cancel()
    }

    private fun runLoop() {
        var attempt = 0
        while (!stopped) {
            val normalized = baseUrl.trim().trimEnd('/')
            if (normalized.isBlank()) {
                onStateChange(false, "No gateway URL configured.")
                return
            }
            val since = startOffset + receivedCount
            val request = Request.Builder()
                .url("$normalized/v1/events?since=$since")
                .header("X-Pi-Speak-Token", token)
                .header("Accept", "text/event-stream")
                .get()
                .build()
            val call = client.newCall(request)
            activeCall = call
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) {
                        onStateChange(false, "Events unavailable (${response.code}).")
                        // 401/501 will not fix themselves by retrying quickly.
                        if (response.code == 401 || response.code == 501) return
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
                                        val event = parseGatewayEventData(dataBuffer.toString())
                                        dataBuffer = StringBuilder()
                                        if (event != null) {
                                            // Only session events advance the server's line offset;
                                            // `event: error` frames are out-of-band.
                                            if (frameEventName != "error") receivedCount++
                                            onEvent(event)
                                        }
                                    }
                                    frameEventName = ""
                                }
                                // Comment lines (":keep-alive") need no handling.
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                if (stopped) break
                Log.d("GatewayEventStream", "Event stream dropped: ${e.message}")
            }
            if (stopped) break
            onStateChange(false, "Reconnecting…")
            attempt++
            try {
                Thread.sleep((2000L * attempt).coerceAtMost(15_000L))
            } catch (_: InterruptedException) {
                break
            }
        }
        onStateChange(false, "Stopped")
    }
}
