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

    private val wsListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i("RealtimeVoiceClient", "WebSocket Connection opened successfully")
            listener?.onStatusChanged(true)
            startRecordingThread()
            startPlaybackThread()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            Log.d("RealtimeVoiceClient", "Received text message: $text")
            try {
                val json = JSONObject(text)
                val type = json.optString("type")
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
            audioQueue.offer(bytes.toByteArray())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.i("RealtimeVoiceClient", "WebSocket closing: $code / $reason")
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i("RealtimeVoiceClient", "WebSocket closed: $code / $reason")
            listener?.onStatusChanged(false)
            stopInternal()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.e("RealtimeVoiceClient", "WebSocket failure", t)
            listener?.onError(t.localizedMessage ?: "WebSocket failure")
            listener?.onStatusChanged(false)
            stopInternal()
        }
    }

    fun start() {
        if (webSocket != null) {
            Log.w("RealtimeVoiceClient", "Already started/connected.")
            return
        }

        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            listener?.onError("Record Audio permission not granted.")
            return
        }

        initAudioTrack()

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

    fun stop() {
        stopInternal()
    }

    fun interrupt() {
        clearPlaybackQueueAndFlush()
        try {
            webSocket?.send("{\"type\":\"interrupt\"}")
        } catch (e: Exception) {
            Log.e("RealtimeVoiceClient", "Failed to send interrupt control signal", e)
        }
    }

    private fun startRecordingThread() {
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
                        val byteString = buffer.toByteString(0, read)
                        webSocket?.send(byteString)
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
    }
}
