package com.example.api

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log
import com.example.data.AppPreferences
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

interface RealtimeListener {
    fun onTranscript(text: String)
    fun onTextReply(text: String)
    fun onInterrupt()
    fun onError(message: String)
    fun onStatusChanged(connected: Boolean)
}

class RealtimeVoiceClient(private val context: Context, private val prefs: AppPreferences) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // Infinite timeout for persistent WebSocket
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    var listener: RealtimeListener? = null

    private var audioRecord: AudioRecord? = null
    private val isRecording = AtomicBoolean(false)
    private var recordingThread: Thread? = null

    private var audioTrack: AudioTrack? = null
    private val isPlaying = AtomicBoolean(false)
    private val audioQueue = LinkedBlockingQueue<ByteArray>()
    private var playbackThread: Thread? = null

    // Resilience and sequence tracking state
    private val isStarted = AtomicBoolean(false)
    private val isWebSocketConnected = AtomicBoolean(false)
    private val isReconnecting = AtomicBoolean(false)
    @Volatile private var retryAttempt = 0
    @Volatile private var nextClientSequenceId = 1
    @Volatile private var lastReceivedServerSequenceId = 0
    @Volatile private var currentSessionId: String? = null

    // Stateful FIFO retry queue for offline audio buffering (capped at 10 seconds of raw recording data)
    data class PendingFrame(val seqId: Int, val data: ByteArray)
    private val retryQueue = java.util.Collections.synchronizedList(ArrayList<PendingFrame>())
    private var queueBytes = 0
    private val MAX_QUEUE_BYTES = 320000 // 10 seconds of 16kHz 16-bit mono PCM (16000 * 2 * 10)

    private val wsListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i("RealtimeVoiceClient", "WebSocket Connection opened successfully")
            isWebSocketConnected.set(true)
            retryAttempt = 0
            listener?.onStatusChanged(true)

            // Send reconnect handshake if we have prior sequence history
            val sessId = currentSessionId
            if (nextClientSequenceId > 1 || lastReceivedServerSequenceId > 0) {
                val reconnectMsg = RealtimeControlMessage(
                    type = "reconnect",
                    clientSequenceId = nextClientSequenceId - 1,
                    serverSequenceId = lastReceivedServerSequenceId,
                    session = sessId
                )
                sendControlMessage(reconnectMsg)
            }

            flushRetryQueue()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            Log.d("RealtimeVoiceClient", "Received text message: $text")
            try {
                val json = JSONObject(text)
                val type = json.optString("type")
                
                if (json.has("serverSequenceId")) {
                    val seqId = json.getInt("serverSequenceId")
                    lastReceivedServerSequenceId = maxOf(lastReceivedServerSequenceId, seqId)
                }

                if (json.has("session")) {
                    currentSessionId = json.getString("session")
                }

                val messageText = json.optString("text") ?: json.optString("message") ?: ""
                when (type) {
                    "transcript" -> {
                        listener?.onTranscript(messageText)
                    }
                    "text_reply" -> {
                        listener?.onTextReply(messageText)
                    }
                    "interrupt" -> {
                        clearPlaybackQueueAndFlush()
                        listener?.onInterrupt()
                    }
                    "error" -> {
                        listener?.onError(messageText)
                    }
                }
            } catch (e: Exception) {
                Log.e("RealtimeVoiceClient", "Error parsing JSON text message", e)
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val byteArray = bytes.toByteArray()
            if (byteArray.size >= 4) {
                val buffer = ByteBuffer.wrap(byteArray).order(ByteOrder.BIG_ENDIAN)
                val seqId = buffer.int
                lastReceivedServerSequenceId = maxOf(lastReceivedServerSequenceId, seqId)
                val audioData = ByteArray(byteArray.size - 4)
                buffer.get(audioData)
                audioQueue.offer(audioData)
            } else {
                audioQueue.offer(byteArray)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.i("RealtimeVoiceClient", "WebSocket closing: $code / $reason")
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i("RealtimeVoiceClient", "WebSocket closed: $code / $reason")
            isWebSocketConnected.set(false)
            this@RealtimeVoiceClient.webSocket = null
            listener?.onStatusChanged(false)
            
            if (isStarted.get()) {
                scheduleReconnect()
            } else {
                stopInternal()
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.e("RealtimeVoiceClient", "WebSocket failure", t)
            isWebSocketConnected.set(false)
            this@RealtimeVoiceClient.webSocket = null
            listener?.onStatusChanged(false)
            listener?.onError(t.localizedMessage ?: "WebSocket failure")
            
            if (isStarted.get()) {
                scheduleReconnect()
            } else {
                stopInternal()
            }
        }
    }

    fun start() {
        if (isStarted.get()) {
            Log.w("RealtimeVoiceClient", "Already started.")
            return
        }
        isStarted.set(true)
        retryAttempt = 0
        isWebSocketConnected.set(false)
        nextClientSequenceId = 1
        lastReceivedServerSequenceId = 0
        currentSessionId = null
        synchronized(retryQueue) {
            retryQueue.clear()
            queueBytes = 0
        }

        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            listener?.onError("Record Audio permission not granted.")
            isStarted.set(false)
            return
        }

        initAudioTrack()
        
        // Start recording and playback immediately so they continue during offline drops
        startRecordingThread()
        startPlaybackThread()

        connectWebSocket()
    }

    fun stop() {
        isStarted.set(false)
        stopInternal()
    }

    fun interrupt() {
        clearPlaybackQueueAndFlush()
        sendControlMessage(RealtimeControlMessage(type = "interrupt"))
    }

    private fun connectWebSocket() {
        if (webSocket != null) {
            Log.w("RealtimeVoiceClient", "WebSocket connection already exists.")
            return
        }

        val rawTarget = prefs.targetIpAddress.trim().trimEnd('/')
        if (rawTarget.isEmpty()) {
            listener?.onError("Target IP address is not configured.")
            return
        }

        val wsUrl = when {
            rawTarget.startsWith("https://") -> rawTarget.replaceFirst("https://", "wss://") + "/v1/live"
            rawTarget.startsWith("http://") -> rawTarget.replaceFirst("http://", "ws://") + "/v1/live"
            else -> {
                val hasPort = rawTarget.contains(":")
                if (hasPort) {
                    "ws://$rawTarget/v1/live"
                } else {
                    "ws://$rawTarget:8767/v1/live"
                }
            }
        }

        val token = prefs.remoteToken.trim()
        val finalUrl = if (token.isNotEmpty()) {
            if (wsUrl.contains("?")) "$wsUrl&token=$token" else "$wsUrl?token=$token"
        } else {
            wsUrl
        }

        val request = Request.Builder()
            .url(finalUrl)
            .apply {
                if (token.isNotEmpty()) {
                    addHeader("X-Pi-Speak-Token", token)
                    addHeader("Authorization", "Bearer $token")
                }
            }
            .build()

        webSocket = client.newWebSocket(request, wsListener)
    }

    private fun scheduleReconnect() {
        if (!isStarted.get()) return
        if (isReconnecting.get()) {
            Log.d("RealtimeVoiceClient", "Reconnection already scheduled.")
            return
        }
        isReconnecting.set(true)

        val attempt = retryAttempt++
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s limit
        val backoffMs = minOf(1000L * (1 shl attempt), 32000L)
        // Jitter modifier: add random duration up to 1000ms
        val jitter = (Math.random() * 1000).toLong()
        val delay = backoffMs + jitter

        Log.i("RealtimeVoiceClient", "Scheduling reconnect attempt $attempt in $delay ms (backoff: $backoffMs ms, jitter: $jitter ms)")

        thread(start = true, name = "realtime-reconnect") {
            try {
                Thread.sleep(delay)
            } catch (e: InterruptedException) {
                isReconnecting.set(false)
                return@thread
            }
            isReconnecting.set(false)
            if (isStarted.get() && !isWebSocketConnected.get()) {
                Log.i("RealtimeVoiceClient", "Executing reconnect attempt...")
                connectWebSocket()
            }
        }
    }

    private fun sendControlMessage(message: RealtimeControlMessage) {
        val seqId = nextClientSequenceId++
        val messageWithSeq = message.copy(clientSequenceId = seqId)
        try {
            webSocket?.send(messageWithSeq.toJsonString())
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Failed to send control message: ${message.type}", e)
        }
    }

    private fun sendAudioFrame(data: ByteArray) {
        val seq = nextClientSequenceId++
        // Prepare binary frame with 4-byte clientSequenceId header followed by raw PCM bytes
        val buffer = ByteBuffer.allocate(4 + data.size)
            .order(ByteOrder.BIG_ENDIAN)
            .putInt(seq)
            .put(data)
            .array()
        val byteString = buffer.toByteString()

        if (isWebSocketConnected.get()) {
            try {
                val sent = webSocket?.send(byteString) ?: false
                if (!sent) {
                    queueFrame(seq, data)
                }
            } catch (e: Exception) {
                Log.e("RealtimeVoiceClient", "Error sending audio frame, queuing instead", e)
                queueFrame(seq, data)
            }
        } else {
            queueFrame(seq, data)
        }
    }

    private fun queueFrame(seqId: Int, data: ByteArray) {
        synchronized(retryQueue) {
            retryQueue.add(PendingFrame(seqId, data))
            queueBytes += data.size
            while (queueBytes > MAX_QUEUE_BYTES && retryQueue.isNotEmpty()) {
                val removed = retryQueue.removeAt(0)
                queueBytes -= removed.data.size
            }
        }
    }

    private fun flushRetryQueue() {
        synchronized(retryQueue) {
            if (retryQueue.isEmpty()) return
            Log.i("RealtimeVoiceClient", "Flushing retry queue: ${retryQueue.size} frames")
            val iterator = retryQueue.iterator()
            while (iterator.hasNext()) {
                val frame = iterator.next()
                val buffer = ByteBuffer.allocate(4 + frame.data.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .putInt(frame.seqId)
                    .put(frame.data)
                    .array()
                try {
                    val sent = webSocket?.send(buffer.toByteString()) ?: false
                    if (sent) {
                        iterator.remove()
                        queueBytes -= frame.data.size
                    } else {
                        Log.w("RealtimeVoiceClient", "Failed to send frame during flush, stopping flush")
                        break
                    }
                } catch (e: Exception) {
                    Log.e("RealtimeVoiceClient", "Error flushing frame, stopping flush", e)
                    break
                }
            }
        }
    }

    private fun startRecordingThread() {
        if (isRecording.get()) {
            Log.d("RealtimeVoiceClient", "Recording thread already running.")
            return
        }

        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.w("RealtimeVoiceClient", "Record Audio permission not granted.")
            return
        }

        try {
            val sampleRate = 16000
            val channelConfig = AudioFormat.CHANNEL_IN_MONO
            val encoding = AudioFormat.ENCODING_PCM_16BIT
            val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, encoding)
            val bufferSize = maxOf(minBufferSize, sampleRate)
            
            val record = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                channelConfig,
                encoding,
                bufferSize
            )
            
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.e("RealtimeVoiceClient", "AudioRecord could not be initialized")
                record.release()
                return
            }
            
            audioRecord = record
            isRecording.set(true)
            record.startRecording()
            
            recordingThread = thread(start = true, name = "realtime-audio-record") {
                val buffer = ByteArray(2048)
                while (isRecording.get()) {
                    val read = record.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        val data = buffer.copyOfRange(0, read)
                        sendAudioFrame(data)
                    } else if (read < 0) {
                        Log.e("RealtimeVoiceClient", "AudioRecord read error: $read")
                        break
                    }
                }
            }
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Failed to start recording", e)
        }
    }

    private fun initAudioTrack() {
        try {
            val sampleRate = 24000
            val channelConfig = AudioFormat.CHANNEL_OUT_MONO
            val audioFormat = AudioFormat.ENCODING_PCM_16BIT
            val minBufferSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, audioFormat)
            val bufferSize = maxOf(minBufferSize, sampleRate)

            val track = AudioTrack(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelConfig)
                    .setEncoding(audioFormat)
                    .build(),
                bufferSize,
                AudioTrack.MODE_STREAM,
                AudioManager.AUDIO_SESSION_ID_GENERATE
            )
            
            if (track.state != AudioTrack.STATE_INITIALIZED) {
                Log.e("RealtimeVoiceClient", "AudioTrack could not be initialized")
                track.release()
                return
            }
            
            audioTrack = track
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Failed to initialize AudioTrack", e)
        }
    }

    private fun startPlaybackThread() {
        if (isPlaying.get()) {
            Log.d("RealtimeVoiceClient", "Playback thread already running.")
            return
        }
        isPlaying.set(true)
        audioQueue.clear()
        playbackThread = thread(start = true, name = "realtime-audio-playback") {
            try {
                audioTrack?.apply {
                    if (state == AudioTrack.STATE_INITIALIZED) {
                        play()
                    }
                }
                while (isPlaying.get()) {
                    val data = audioQueue.take()
                    if (data.isNotEmpty() && isPlaying.get()) {
                        audioTrack?.apply {
                            if (state == AudioTrack.STATE_INITIALIZED) {
                                write(data, 0, data.size)
                            }
                        }
                    }
                }
            } catch (e: InterruptedException) {
                // Normal termination
            } catch (e: Exception) {
                Log.e("RealtimeVoiceClient", "Playback loop error", e)
            }
        }
    }

    private fun clearPlaybackQueueAndFlush() {
        audioQueue.clear()
        try {
            audioTrack?.apply {
                if (state == AudioTrack.STATE_INITIALIZED) {
                    pause()
                    flush()
                    play()
                }
            }
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Error flushing AudioTrack", e)
        }
    }

    private fun stopPlaybackThread() {
        isPlaying.set(false)
        playbackThread?.interrupt()
        playbackThread = null
        audioQueue.clear()
    }

    private fun releaseAudioTrack() {
        try {
            audioTrack?.apply {
                if (playState == AudioTrack.PLAYSTATE_PLAYING) {
                    stop()
                }
                release()
            }
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Error releasing AudioTrack", e)
        } finally {
            audioTrack = null
        }
    }

    private fun stopInternal() {
        isRecording.set(false)
        try {
            audioRecord?.apply {
                if (recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    stop()
                }
                release()
            }
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Error releasing AudioRecord", e)
        } finally {
            audioRecord = null
            recordingThread = null
        }

        try {
            webSocket?.close(1000, "Normal closure")
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Error closing WebSocket", e)
        } finally {
            webSocket = null
        }

        stopPlaybackThread()
        releaseAudioTrack()

        synchronized(retryQueue) {
            retryQueue.clear()
            queueBytes = 0
        }
    }
}
