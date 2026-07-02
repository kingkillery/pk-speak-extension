package com.example

import android.util.Log
import com.example.data.AppPreferences
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

interface RealtimeVoiceSessionListener {
    fun onConnected(sessionId: String)
    fun onAudioChunk(seqId: Int, pcm: ByteArray)
    fun onTranscript(text: String)
    fun onInterrupt()
    fun onToolStart(name: String)
    fun onToolComplete(name: String, output: String)
    fun onApprovalRequired(approvalId: String, command: String, reason: String, cwd: String, timeoutMs: Int)
    fun onApprovalResolved(approvalId: String)
    fun onError(message: String)
    fun onDisconnected()
}

class RealtimeVoiceSession(
    private val prefs: AppPreferences,
    private val listener: RealtimeVoiceSessionListener
) {

    companion object {
        private const val TAG = "RealtimeVoiceSession"
        private const val MAX_RECONNECT_ATTEMPTS = 5
        private const val BASE_RECONNECT_DELAY_MS = 2000L
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var sessionId: String? = null
    @Volatile private var lastServerSequenceId: Int = 0

    private val clientSequenceCounter = AtomicInteger(0)
    private val intentionalDisconnect = AtomicBoolean(false)
    private val reconnectAttempts = AtomicInteger(0)

    @Volatile private var reconnectThread: Thread? = null

    fun connect() {
        intentionalDisconnect.set(false)
        reconnectAttempts.set(0)
        reconnectThread?.interrupt()
        reconnectThread = null
        sessionId = null
        lastServerSequenceId = 0
        openWebSocket(isReconnect = false)
    }

    private fun openWebSocket(isReconnect: Boolean) {
        val wsUrl = buildWsUrl()
        val request = Request.Builder()
            .url(wsUrl)
            .header("X-Pi-Speak-Token", prefs.remoteToken)
            .build()

        Log.d(TAG, "Opening WebSocket: $wsUrl (reconnect=$isReconnect)")

        webSocket = client.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d(TAG, "WebSocket opened (reconnect=$isReconnect)")
                reconnectAttempts.set(0)
                if (isReconnect) {
                    val sid = sessionId
                    if (sid != null) {
                        val msg = JSONObject()
                            .put("type", "reconnect")
                            .put("session", sid)
                            .put("serverSequenceId", lastServerSequenceId)
                        ws.send(msg.toString())
                        Log.d(TAG, "Sent reconnect for session=$sid serverSequenceId=$lastServerSequenceId")
                    }
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleTextMessage(text)
            }

            override fun onMessage(ws: WebSocket, bytes: okio.ByteString) {
                handleBinaryMessage(bytes.toByteArray())
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closing: code=$code reason=$reason")
                ws.close(1000, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closed: code=$code reason=$reason")
                handleDisconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}", t)
                if (!intentionalDisconnect.get()) {
                    listener.onError(t.localizedMessage ?: t.javaClass.simpleName)
                }
                handleDisconnect()
            }
        })
    }

    private fun handleDisconnect() {
        if (intentionalDisconnect.get()) {
            listener.onDisconnected()
            return
        }
        val sid = sessionId
        val attempt = reconnectAttempts.incrementAndGet()
        if (sid != null && attempt <= MAX_RECONNECT_ATTEMPTS) {
            val delayMs = reconnectDelayMs(attempt)
            Log.d(TAG, "Scheduling reconnect attempt $attempt/$MAX_RECONNECT_ATTEMPTS in ${delayMs}ms for session=$sid")
            reconnectThread = Thread {
                try {
                    Thread.sleep(delayMs)
                    if (!intentionalDisconnect.get()) {
                        openWebSocket(isReconnect = true)
                    }
                } catch (_: InterruptedException) {
                    Log.d(TAG, "Reconnect thread interrupted")
                }
            }.also { it.isDaemon = true; it.start() }
        } else {
            if (sid == null) {
                Log.d(TAG, "No session established — not attempting reconnect")
            } else {
                Log.d(TAG, "Max reconnect attempts ($MAX_RECONNECT_ATTEMPTS) exhausted for session=$sid")
            }
            listener.onDisconnected()
        }
    }

    private fun handleTextMessage(text: String) {
        try {
            val json = JSONObject(text)
            val seqId = json.optInt("serverSequenceId", -1)
            if (seqId >= 0) {
                lastServerSequenceId = seqId
            }
            when (json.optString("type")) {
                "start" -> {
                    val sid = json.optString("session", "")
                    sessionId = sid
                    Log.d(TAG, "Session started: $sid serverSequenceId=$seqId")
                    listener.onConnected(sid)
                }
                "transcript" -> {
                    listener.onTranscript(json.optString("text", ""))
                }
                "interrupt" -> {
                    listener.onInterrupt()
                }
                "error" -> {
                    listener.onError(json.optString("message", "Unknown error from server"))
                }
                "tool_start" -> {
                    listener.onToolStart(json.optString("name", ""))
                }
                "tool_complete" -> {
                    listener.onToolComplete(
                        json.optString("name", ""),
                        json.optString("output", "")
                    )
                }
                "tool_approval_required" -> {
                    listener.onApprovalRequired(
                        json.optString("approvalId", ""),
                        json.optString("command", ""),
                        json.optString("reason", ""),
                        json.optString("cwd", ""),
                        json.optInt("timeoutMs", 0)
                    )
                }
                "tool_approval_resolved" -> {
                    val approvalId = json.optString("approvalId", "")
                    if (approvalId.isNotBlank()) {
                        listener.onApprovalResolved(approvalId)
                    }
                }
                "reconnecting" -> {
                    Log.d(TAG, "Server reported reconnecting, serverSequenceId=$seqId")
                }
                else -> {
                    Log.d(TAG, "Unhandled server message type: ${json.optString("type")}")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse server text message", e)
        }
    }

    private fun handleBinaryMessage(bytes: ByteArray) {
        if (bytes.size < 4) {
            Log.w(TAG, "Binary message too short: ${bytes.size} bytes, ignoring")
            return
        }
        val seqId = ByteBuffer.wrap(bytes, 0, 4).int
        val pcm = bytes.copyOfRange(4, bytes.size)
        listener.onAudioChunk(seqId, pcm)
    }

    fun sendAudioChunk(seqId: Int, pcm: ByteArray) {
        val ws = webSocket ?: return
        val buffer = ByteBuffer.allocate(4 + pcm.size)
        buffer.putInt(seqId)
        buffer.put(pcm)
        val sent = ws.send(buffer.array().toByteString())
        if (!sent) {
            Log.w(TAG, "sendAudioChunk: WebSocket send returned false (buffer full or closed)")
        }
    }

    fun sendText(text: String) {
        val ws = webSocket ?: return
        val seqId = clientSequenceCounter.incrementAndGet()
        val msg = JSONObject()
            .put("type", "text")
            .put("text", text)
            .put("clientSequenceId", seqId)
        ws.send(msg.toString())
    }

    fun sendInterrupt() {
        val ws = webSocket ?: return
        val msg = JSONObject().put("type", "interrupt")
        ws.send(msg.toString())
    }

    fun approveTerminal(approvalId: String) {
        val ws = webSocket ?: return
        val msg = JSONObject()
            .put("type", "terminal_approve")
            .put("approvalId", approvalId)
        ws.send(msg.toString())
    }

    fun rejectTerminal(approvalId: String) {
        val ws = webSocket ?: return
        val msg = JSONObject()
            .put("type", "terminal_reject")
            .put("approvalId", approvalId)
        ws.send(msg.toString())
    }

    fun disconnect() {
        intentionalDisconnect.set(true)
        reconnectThread?.interrupt()
        reconnectThread = null
        webSocket?.close(1000, "Disconnected by client")
    }

    private fun buildWsUrl(): String {
        val base = prefs.targetIpAddress.trim().trimEnd('/')
        return when {
            base.startsWith("wss://") -> "$base/v1/live"
            base.startsWith("ws://") -> "$base/v1/live"
            base.startsWith("https://") -> base.replaceFirst("https://", "wss://") + "/v1/live"
            base.startsWith("http://") -> base.replaceFirst("http://", "ws://") + "/v1/live"
            else -> "ws://$base/v1/live"
        }
    }

    private fun reconnectDelayMs(attempt: Int): Long =
        minOf(BASE_RECONNECT_DELAY_MS * (1L shl (attempt - 1).coerceAtMost(4)), 30_000L)
}
