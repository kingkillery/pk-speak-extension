package com.example.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder.AudioSource
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Streams raw PCM audio from the microphone to a caller-supplied callback.
 *
 * Each call to [onChunk] delivers:
 *   - [seqId]  monotonically increasing sequence counter starting at 1
 *   - [pcm]    3200-byte (1600 × Int16 little-endian) payload representing
 *              ~100 ms of 16 kHz mono 16-bit PCM
 *
 * The WebSocket layer should assemble the wire frame as:
 *   [4-byte Int32BE seqId] ++ pcm
 */
class StreamingPcmRecorder(private val context: Context) {

    companion object {
        private const val TAG = "StreamingPcmRecorder"
        private const val SAMPLE_RATE = 16_000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /** 1600 shorts = 3200 bytes ≈ 100 ms at 16 kHz mono */
        private const val CHUNK_SHORTS = 1600
    }

    private val active = AtomicBoolean(false)
    private val seqCounter = AtomicInteger(0)

    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var readThread: Thread? = null
    @Volatile private var echoCanceler: android.media.audiofx.AcousticEchoCanceler? = null
    @Volatile private var noiseSuppressor: android.media.audiofx.NoiseSuppressor? = null

    val isRecording: Boolean
        get() = active.get()

    /**
     * Starts the AudioRecord loop on a background thread.
     *
     * @param onChunk called on the recording thread for every ~100 ms chunk;
     *                implementations should be non-blocking.
     * @throws IllegalStateException if RECORD_AUDIO permission is not granted.
     */
    fun start(onChunk: (seqId: Int, pcm: ByteArray) -> Unit) {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            throw IllegalStateException("RECORD_AUDIO not granted")
        }

        if (active.getAndSet(true)) {
            Log.w(TAG, "start() called while already recording — ignoring")
            return
        }

        seqCounter.set(0)

        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, ENCODING)
        // Use at least 2× the chunk size so the driver never blocks a full read.
        val bufferBytes = maxOf(minBuffer, CHUNK_SHORTS * 2 * 2)

        val audioRecord = AudioRecord(
            AudioSource.MIC,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            ENCODING,
            bufferBytes
        )

        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
            active.set(false)
            audioRecord.release()
            throw IllegalStateException("AudioRecord failed to initialize")
        }

        recorder = audioRecord
        applyAudioEffects(audioRecord)
        audioRecord.startRecording()
        Log.d(TAG, "Recording started (bufferBytes=$bufferBytes)")

        readThread = thread(start = true, name = "pi-speak-pcm-streamer") {
            val buffer = ShortArray(CHUNK_SHORTS)
            while (active.get()) {
                val read = audioRecord.read(buffer, 0, CHUNK_SHORTS)
                if (read <= 0) {
                    if (read < 0) Log.w(TAG, "audioRecord.read returned error $read")
                    continue
                }

                val pcm = shortsToLittleEndianBytes(buffer, read)
                val seq = seqCounter.incrementAndGet()
                try {
                    onChunk(seq, pcm)
                } catch (e: Exception) {
                    Log.e(TAG, "onChunk threw an exception (seq=$seq)", e)
                }
            }
            Log.d(TAG, "Read loop exited")
        }
    }

    /**
     * Stops recording and releases the AudioRecord resource.
     * Safe to call from any thread, including before [start].
     */
    fun stop() {
        if (!active.getAndSet(false)) {
            return
        }

        try {
            readThread?.join(1500)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }

        try {
            recorder?.stop()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping AudioRecord", e)
        }

        try {
            recorder?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing AudioRecord", e)
        }

        releaseAudioEffects()
        recorder = null
        readThread = null
        Log.d(TAG, "Recording stopped")
    }

    /**
     * Attaches platform AEC/NS effects to the AudioRecord session when enabled in
     * `pi_speak_prefs` ("aec_enabled" / "ns_enabled", both default true) and supported
     * by the device. Replaces the old reflection-based wiring in MainActivity.
     */
    private fun applyAudioEffects(audioRecord: AudioRecord) {
        val sharedPrefs = context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE)
        val aecEnabled = sharedPrefs.getBoolean("aec_enabled", true)
        val nsEnabled = sharedPrefs.getBoolean("ns_enabled", true)
        val sessionId = audioRecord.audioSessionId
        try {
            if (aecEnabled && android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                echoCanceler = android.media.audiofx.AcousticEchoCanceler.create(sessionId)?.also {
                    it.enabled = true
                    Log.d(TAG, "AEC attached to session $sessionId")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to attach AEC", e)
        }
        try {
            if (nsEnabled && android.media.audiofx.NoiseSuppressor.isAvailable()) {
                noiseSuppressor = android.media.audiofx.NoiseSuppressor.create(sessionId)?.also {
                    it.enabled = true
                    Log.d(TAG, "NS attached to session $sessionId")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to attach NS", e)
        }
    }

    private fun releaseAudioEffects() {
        try {
            echoCanceler?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing AEC", e)
        }
        try {
            noiseSuppressor?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing NS", e)
        }
        echoCanceler = null
        noiseSuppressor = null
    }

    /**
     * Converts the first [count] entries of [shorts] to a little-endian byte array.
     */
    private fun shortsToLittleEndianBytes(shorts: ShortArray, count: Int): ByteArray {
        val bytes = ByteArray(count * 2)
        var i = 0
        repeat(count) { idx ->
            val s = shorts[idx].toInt()
            bytes[i++] = (s and 0xff).toByte()
            bytes[i++] = ((s shr 8) and 0xff).toByte()
        }
        return bytes
    }
}
