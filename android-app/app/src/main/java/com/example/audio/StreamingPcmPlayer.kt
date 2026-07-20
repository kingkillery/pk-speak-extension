package com.example.audio

import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Plays a stream of 24 kHz mono 16-bit PCM audio delivered as chunks from a WebSocket.
 *
 * Each frame from the server is: [4-byte Int32BE seq ID][raw PCM bytes].
 * The caller is responsible for parsing the frame and passing the extracted seqId and
 * pcm bytes to [write]. Duplicate or out-of-order frames are silently dropped.
 */
class StreamingPcmPlayer(
    private var sampleRate: Int = DEFAULT_SAMPLE_RATE,
) {

    companion object {
        private const val TAG = "StreamingPcmPlayer"
        const val DEFAULT_SAMPLE_RATE = 24_000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_OUT_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }

    private val lock = ReentrantLock()
    private var audioTrack: AudioTrack? = null

    // Initialized to MIN_VALUE so any valid seqId (including 0) is accepted first.
    private var lastSeqId: Int = Int.MIN_VALUE
    private var trackStarted: Boolean = false

    /**
     * True when the underlying AudioTrack is in the playing state.
     */
    val isPlaying: Boolean
        get() = lock.withLock {
            audioTrack?.playState == AudioTrack.PLAYSTATE_PLAYING
        }

    /**
     * Updates the output sample rate. Takes effect on the next [start] (recreates the track).
     */
    fun setSampleRate(rate: Int) {
        if (rate >= 8_000) sampleRate = rate
    }

    /**
     * Creates and prepares the AudioTrack for streaming. Safe to call again after [stop].
     */
    fun start() {
        lock.withLock {
            if (audioTrack != null) {
                Log.w(TAG, "start() called while already running; stopping existing track first")
                releaseTrackLocked()
            }
            val rate = sampleRate.coerceAtLeast(8_000)
            val minBuffer = AudioTrack.getMinBufferSize(rate, CHANNEL_CONFIG, ENCODING)
            // Use at least 1 second of buffer headroom (rate samples × 2 bytes).
            val bufferSize = maxOf(minBuffer, rate * 2)

            @Suppress("DEPRECATION")
            val track = AudioTrack(
                AudioManager.STREAM_MUSIC,
                rate,
                CHANNEL_CONFIG,
                ENCODING,
                bufferSize,
                AudioTrack.MODE_STREAM
            )
            audioTrack = track
            lastSeqId = Int.MIN_VALUE
            trackStarted = false
            Log.d(TAG, "AudioTrack initialized: sampleRate=$rate, bufferSize=$bufferSize")
        }
    }

    /**
     * Writes a decoded PCM chunk to the AudioTrack.
     *
     * @param seqId  The 4-byte Int32BE sequence ID already extracted from the binary frame.
     * @param pcm    The raw 16-bit PCM payload (seq ID header already stripped).
     *
     * Frames with [seqId] <= the last accepted seqId are dropped (dedup / reorder guard).
     * [AudioTrack.play] is called automatically on the first accepted chunk after [start].
     * Safe to call from any thread.
     */
    fun write(seqId: Int, pcm: ByteArray) {
        val track: AudioTrack
        val shouldPlay: Boolean

        lock.withLock {
            val t = audioTrack ?: run {
                Log.w(TAG, "write() called before start(); ignoring frame seqId=$seqId")
                return
            }
            if (seqId <= lastSeqId) {
                Log.d(TAG, "Dropping duplicate/out-of-order frame seqId=$seqId (lastSeqId=$lastSeqId)")
                return
            }
            lastSeqId = seqId
            track = t
            shouldPlay = !trackStarted
            if (shouldPlay) {
                trackStarted = true
            }
        }

        // AudioTrack.write() is thread-safe; play()/write() are called outside the lock
        // to avoid holding it during potentially blocking I/O.
        try {
            if (shouldPlay) {
                track.play()
                Log.d(TAG, "AudioTrack.play() — first chunk seqId=$seqId")
            }
            val written = track.write(pcm, 0, pcm.size)
            if (written < 0) {
                Log.e(TAG, "AudioTrack.write() error code $written for seqId=$seqId")
            }
        } catch (e: IllegalStateException) {
            // Raced with stop(); safe to swallow — the track is being torn down.
            Log.w(TAG, "AudioTrack write skipped (track stopped mid-stream): ${e.message}")
        }
    }

    /**
     * Pauses, flushes, and releases the AudioTrack. After this call [start] may be invoked
     * again to begin a new playback session.
     */
    fun stop() {
        lock.withLock {
            releaseTrackLocked()
        }
    }

    // Must be called with [lock] held.
    private fun releaseTrackLocked() {
        val track = audioTrack ?: return
        try {
            if (track.playState == AudioTrack.PLAYSTATE_PLAYING) {
                track.pause()
            }
            track.flush()
            track.stop()
        } catch (e: Exception) {
            Log.e(TAG, "Error while stopping AudioTrack", e)
        } finally {
            try {
                track.release()
            } catch (_: Exception) {}
            audioTrack = null
            lastSeqId = Int.MIN_VALUE
            trackStarted = false
        }
        Log.d(TAG, "AudioTrack stopped and released")
    }
}
