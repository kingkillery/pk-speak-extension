package com.example.audio

import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.SystemClock
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
        private const val MIN_SAMPLE_RATE = 8_000
        private const val BYTES_PER_PCM_FRAME = 2
        private const val REPLAY_COMPLETION_POLL_MS = 10L
        private const val MIN_REPLAY_COMPLETION_GRACE_MS = 250L
        private const val MAX_REPLAY_COMPLETION_GRACE_MS = 2_000L
        // Retain up to 30 seconds of 24 kHz mono 16-bit PCM (about 1.4 MiB).
        // The actual cap is byte-based so non-default sample rates remain bounded too.
        private const val MAX_RETAINED_PCM_BYTES = 1_440_000
        private const val MAX_REPLAY_DURATION_MS =
            (MAX_RETAINED_PCM_BYTES / BYTES_PER_PCM_FRAME) * 1_000L / MIN_SAMPLE_RATE
        private const val MAX_REPLAY_COMPLETION_TIMEOUT_MS =
            MAX_REPLAY_DURATION_MS + MAX_REPLAY_COMPLETION_GRACE_MS
    }

    private val interruptedAudio = InterruptedPcmBuffer(MAX_RETAINED_PCM_BYTES)

    private val lock = ReentrantLock()
    private var audioTrack: AudioTrack? = null

    // Initialized to MIN_VALUE so any valid seqId (including 0) is accepted first.
    private var lastSeqId: Int = Int.MIN_VALUE
    private var trackStarted: Boolean = false
    private var replayInProgress: Boolean = false
    private var replayTrack: AudioTrack? = null
    private var replayGeneration: Long = 0
    private var closed: Boolean = false
    private var audioSegmentGeneration: Long = 0
    private var streamingFramesWritten: Long = 0

    private var streamingWritesInFlight: Int = 0
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
        if (rate >= MIN_SAMPLE_RATE) {
            lock.withLock { sampleRate = rate }
        }
    }

    /**
     * Freezes accepted PCM from the current assistant segment for a local replay.
     *
     * [InterruptedPcmFreezeDisposition.DUPLICATE] identifies the echoed interrupt that must
     * not tear down a replay already in progress. An empty first interrupt still resets live
     * playback, while retaining any prior replay.
     */
    fun freezeInterruptedAudio(): InterruptedPcmFreezeDisposition = lock.withLock {
        interruptedAudio.freezeCurrentSegment()
    }

    fun hasRetainedInterruptedAudio(): Boolean = lock.withLock {
        interruptedAudio.replaySnapshot() != null
    }

    /**
     * Replays the last non-empty interrupted assistant segment entirely on this device.
     *
     * This neither touches the WebSocket nor restores audio the provider had not delivered.
     * Returns false when no interrupted PCM is available.
     */
    fun replayInterruptedAudio(): Boolean {
        var callGeneration = 0L
        val replay = lock.withLock {
            if (closed || replayInProgress || streamingAudioBlocksReplayLocked()) return false
            val retained = interruptedAudio.replaySnapshot() ?: return false
            replayGeneration += 1
            callGeneration = replayGeneration
            replayInProgress = true
            retained
        }

        var localReplayTrack: AudioTrack? = null
        var registered = false
        return try {
            val safeRate = replay.sampleRate.coerceAtLeast(MIN_SAMPLE_RATE)
            var totalBytes = 0L
            var chunkIndex = 0
            while (chunkIndex < replay.chunks.size) {
                totalBytes += replay.chunks[chunkIndex].size
                chunkIndex++
            }
            val totalFrames = totalBytes / BYTES_PER_PCM_FRAME
            if (totalFrames == 0L) return false

            val deadlineMs = SystemClock.elapsedRealtime() +
                replayCompletionTimeoutMs(totalFrames, safeRate)
            val track = createAudioTrack(safeRate, "replay")
            localReplayTrack = track
            registered = lock.withLock {
                if (
                    closed ||
                    !replayInProgress ||
                    replayGeneration != callGeneration
                ) {
                    false
                } else {
                    replayTrack = track
                    true
                }
            }
            if (!registered) return false

            track.play()
            if (!writeReplay(track, replay, deadlineMs)) {
                false
            } else {
                awaitReplayCompletion(track, totalFrames, deadlineMs)
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.w(TAG, "AudioTrack replay interrupted")
            false
        } catch (e: RuntimeException) {
            Log.w(TAG, "AudioTrack replay failed: ${e.message}")
            false
        } finally {
            val track = localReplayTrack
            val shouldRelease = lock.withLock {
                val ownsRegisteredTrack = registered && replayTrack === track
                if (ownsRegisteredTrack) {
                    replayTrack = null
                }
                if (replayGeneration == callGeneration) {
                    replayInProgress = false
                }
                !registered || ownsRegisteredTrack
            }
            if (shouldRelease && track != null) {
                releaseAudioTrack(track, "replay")
            }
        }
    }

    /** Removes retained PCM when the containing live session is torn down. */
    fun clearInterruptedAudio() {
        lock.withLock { interruptedAudio.clear() }
    }

    /** Marks later provider output as a new assistant segment that may replace the replay. */
    fun beginAssistantAudioSegment() {
        lock.withLock {
            audioSegmentGeneration += 1
            interruptedAudio.discardCurrentSegment()
            interruptedAudio.beginSegment()
        }
    }

    /**
     * Captures the streaming playback boundary for a normally completed assistant segment.
     *
     * Transcript completion can arrive while PCM is still queued in AudioTrack. The caller
     * should await this token on a background dispatcher before discarding retained PCM.
     */
    internal fun completeAssistantAudioSegment(): CompletedStreamingPcmSegment = lock.withLock {
        val track = audioTrack
        val expectedFrames = streamingFramesWritten
        if (track == null) {
            interruptedAudio.discardCurrentSegment()
            return CompletedStreamingPcmSegment(audioSegmentGeneration, null, 0, 0)
        }

        val playedFrames = streamingPlaybackHeadPosition(track)
        if (playedFrames >= expectedFrames) {
            interruptedAudio.discardCurrentSegment()
            return CompletedStreamingPcmSegment(audioSegmentGeneration, null, 0, 0)
        }

        val remainingFrames = expectedFrames - playedFrames
        CompletedStreamingPcmSegment(
            segmentGeneration = audioSegmentGeneration,
            track = track,
            expectedFrames = expectedFrames,
            deadlineMs = SystemClock.elapsedRealtime() +
                replayCompletionTimeoutMs(remainingFrames, sampleRate.coerceAtLeast(MIN_SAMPLE_RATE)),
        )
    }

    /**
     * Waits for a completed segment's queued streaming PCM to drain, then drops its capture.
     *
     * A new segment, interrupt, stop, or session close invalidates the token without touching
     * the newer segment or an already frozen replay.
     */
    internal fun discardCompletedAudioSegmentAfterPlayback(
        completion: CompletedStreamingPcmSegment,
    ) {
        val completedTrack = completion.track ?: return
        while (true) {
            val shouldWait = lock.withLock {
                if (
                    closed ||
                    audioTrack !== completedTrack ||
                    audioSegmentGeneration != completion.segmentGeneration
                ) {
                    return
                }

                val playedFrames = streamingPlaybackHeadPosition(completedTrack)
                val timedOut = SystemClock.elapsedRealtime() >= completion.deadlineMs
                if (playedFrames >= completion.expectedFrames || timedOut) {
                    if (timedOut) {
                        Log.w(
                            TAG,
                            "Streaming completion timed out at " +
                                "$playedFrames/${completion.expectedFrames} frames",
                        )
                    }
                    interruptedAudio.discardCurrentSegment()
                    false
                } else {
                    true
                }
            }
            if (!shouldWait) return
            try {
                Thread.sleep(REPLAY_COMPLETION_POLL_MS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    /** Stops playback and discards all retained audio for this session. */
    fun close() {
        val replayToRelease = lock.withLock {
            closed = true
            replayGeneration += 1
            replayInProgress = false
            releaseTrackLocked()
            interruptedAudio.clear()
            replayTrack.also { replayTrack = null }
        }
        replayToRelease?.let { releaseAudioTrack(it, "replay") }
    }

    /**
     * Creates and prepares the AudioTrack for streaming. Safe to call again after [stop].
     */
    fun start() {
        lock.withLock {
            closed = false
            if (audioTrack != null) {
                Log.w(TAG, "start() called while already running; stopping existing track first")
                releaseTrackLocked()
            }
            createTrackLocked(sampleRate)
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
        var replayToRelease: AudioTrack? = null
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
            if (replayInProgress) {
                replayGeneration += 1
                replayInProgress = false
                replayToRelease = replayTrack.also { replayTrack = null }
            }
            lastSeqId = seqId
            interruptedAudio.append(pcm, sampleRate.coerceAtLeast(MIN_SAMPLE_RATE))
            track = t
            shouldPlay = !trackStarted
            if (shouldPlay) {
                trackStarted = true
            }
            streamingWritesInFlight += 1
        }

        // Provider audio always wins over a local replay. Stop the replay before writing this
        // frame so a later assistant turn is neither mixed with replay nor silently truncated.
        replayToRelease?.let { releaseAudioTrack(it, "replay") }

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
            } else if (written > 0) {
                lock.withLock {
                    if (audioTrack === track) {
                        streamingFramesWritten += written / BYTES_PER_PCM_FRAME
                    }
                }
            }
        } catch (e: IllegalStateException) {
            // Raced with stop(); safe to swallow — the track is being torn down.
            Log.w(TAG, "AudioTrack write skipped (track stopped mid-stream): ${e.message}")
        } finally {
            lock.withLock {
                streamingWritesInFlight -= 1
            }
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
    private fun createTrackLocked(rate: Int) {
        val safeRate = rate.coerceAtLeast(MIN_SAMPLE_RATE)
        audioTrack = createAudioTrack(safeRate, "streaming")
        lastSeqId = Int.MIN_VALUE
        trackStarted = false
        streamingFramesWritten = 0
    }

    // Must be called with [lock] held.
    private fun releaseTrackLocked() {
        val track = audioTrack ?: return
        releaseAudioTrack(track, "streaming")
        audioTrack = null
        lastSeqId = Int.MIN_VALUE
        trackStarted = false
        streamingFramesWritten = 0
    }

    // Must be called with [lock] held.
    private fun streamingAudioBlocksReplayLocked(): Boolean {
        val playedFrames = audioTrack?.let(::streamingPlaybackHeadPosition)
            ?: streamingFramesWritten
        return streamingAudioBlocksReplay(
            writesInFlight = streamingWritesInFlight,
            framesWritten = streamingFramesWritten,
            framesPlayed = playedFrames,
        )
    }
    
    private fun createAudioTrack(rate: Int, purpose: String): AudioTrack {
        val minBuffer = AudioTrack.getMinBufferSize(rate, CHANNEL_CONFIG, ENCODING)
        // Use at least 1 second of buffer headroom (rate samples × 2 bytes).
        val bufferSize = maxOf(minBuffer, rate * BYTES_PER_PCM_FRAME)

        @Suppress("DEPRECATION")
        val track = AudioTrack(
            AudioManager.STREAM_MUSIC,
            rate,
            CHANNEL_CONFIG,
            ENCODING,
            bufferSize,
            AudioTrack.MODE_STREAM,
        )
        Log.d(TAG, "$purpose AudioTrack initialized: sampleRate=$rate, bufferSize=$bufferSize")
        return track
    }

    private fun writeReplay(track: AudioTrack, replay: RetainedPcm, deadlineMs: Long): Boolean {
        var chunkIndex = 0
        while (chunkIndex < replay.chunks.size) {
            val chunk = replay.chunks[chunkIndex]
            var offset = 0
            while (offset < chunk.size) {
                if (SystemClock.elapsedRealtime() >= deadlineMs) {
                    Log.w(TAG, "AudioTrack replay timed out while writing")
                    return false
                }
                val written = track.write(chunk, offset, chunk.size - offset)
                if (written < 0) {
                    Log.e(TAG, "AudioTrack replay write error code $written")
                    return false
                }
                if (written == 0) {
                    Thread.sleep(REPLAY_COMPLETION_POLL_MS)
                } else {
                    offset += written
                }
            }
            chunkIndex++
        }
        return true
    }

    private fun awaitReplayCompletion(
        track: AudioTrack,
        expectedFrames: Long,
        deadlineMs: Long,
    ): Boolean {
        while (true) {
            val playedFrames = track.playbackHeadPosition.toLong() and 0xFFFF_FFFFL
            if (playedFrames >= expectedFrames) return true

            val remainingMs = deadlineMs - SystemClock.elapsedRealtime()
            if (remainingMs <= 0L) {
                Log.w(
                    TAG,
                    "AudioTrack replay completion timed out at $playedFrames/$expectedFrames frames",
                )
                return false
            }
            Thread.sleep(minOf(REPLAY_COMPLETION_POLL_MS, remainingMs))
        }
    }

    private fun streamingPlaybackHeadPosition(track: AudioTrack): Long =
        track.playbackHeadPosition.toLong() and 0xFFFF_FFFFL

    private fun replayCompletionTimeoutMs(frameCount: Long, rate: Int): Long {
        val durationMs = (frameCount * 1_000L + rate - 1L) / rate
        val graceMs = (durationMs / 4L).coerceIn(
            MIN_REPLAY_COMPLETION_GRACE_MS,
            MAX_REPLAY_COMPLETION_GRACE_MS,
        )
        return (durationMs + graceMs).coerceAtMost(MAX_REPLAY_COMPLETION_TIMEOUT_MS)
    }

    private fun releaseAudioTrack(track: AudioTrack, purpose: String) {
        try {
            if (track.playState == AudioTrack.PLAYSTATE_PLAYING) {
                track.pause()
            }
            track.flush()
            track.stop()
        } catch (e: Exception) {
            Log.e(TAG, "Error while stopping $purpose AudioTrack", e)
        } finally {
            try {
                track.release()
            } catch (_: Exception) {}
        }
        Log.d(TAG, "$purpose AudioTrack stopped and released")
    }
}

internal fun streamingAudioBlocksReplay(
    writesInFlight: Int,
    framesWritten: Long,
    framesPlayed: Long,
): Boolean = writesInFlight > 0 || framesWritten > framesPlayed

internal data class CompletedStreamingPcmSegment(
    val segmentGeneration: Long,
    val track: AudioTrack?,
    val expectedFrames: Long,
    val deadlineMs: Long,
)

/**
 * Thread-confined by [StreamingPcmPlayer]'s lock. PCM arrays are retained by reference; replay
 * writes those same arrays directly, avoiding a second copy of normal-sized network chunks.
 */
internal data class RetainedPcm(val sampleRate: Int, val chunks: List<ByteArray>)

enum class InterruptedPcmFreezeDisposition {
    CAPTURED,
    DUPLICATE,
    FIRST_EMPTY,
}


internal class InterruptedPcmBuffer(private val maxBytes: Int) {
    private var currentChunks = ArrayDeque<ByteArray>()
    private var currentBytes = 0
    private var currentSampleRate = StreamingPcmPlayer.DEFAULT_SAMPLE_RATE
    private var interrupted: RetainedPcm? = null
    private var interruptLatched = false

    fun append(pcm: ByteArray, sampleRate: Int) {
        if (pcm.isEmpty()) return
        if (currentChunks.isNotEmpty() && currentSampleRate != sampleRate) {
            discardCurrentSegment()
        }
        if (currentChunks.isEmpty()) currentSampleRate = sampleRate

        val retainedChunk = if (pcm.size > maxBytes) {
            pcm.copyOfRange(pcm.size - maxBytes, pcm.size)
        } else {
            pcm
        }
        while (currentChunks.isNotEmpty() && currentBytes + retainedChunk.size > maxBytes) {
            currentBytes -= currentChunks.removeFirst().size
        }
        currentChunks.addLast(retainedChunk)
        currentBytes += retainedChunk.size
    }

    fun beginSegment() {
        interruptLatched = false
    }

    fun discardCurrentSegment() {
        currentChunks.clear()
        currentBytes = 0
    }

    fun freezeCurrentSegment(): InterruptedPcmFreezeDisposition {
        if (interruptLatched) {
            // A local interrupt and its echoed server event can straddle one final
            // provider chunk. Drop that tail instead of replacing the useful replay.
            discardCurrentSegment()
            return InterruptedPcmFreezeDisposition.DUPLICATE
        }
        interruptLatched = true
        if (currentChunks.isEmpty()) {
            return InterruptedPcmFreezeDisposition.FIRST_EMPTY
        }
        interrupted = RetainedPcm(currentSampleRate, currentChunks.toList())
        currentChunks = ArrayDeque()
        currentBytes = 0
        return InterruptedPcmFreezeDisposition.CAPTURED
    }

    fun replaySnapshot(): RetainedPcm? = interrupted

    fun clear() {
        currentChunks.clear()
        currentBytes = 0
        interrupted = null
        interruptLatched = false
    }
}

/**
 * Coordinates assistant-turn boundaries and de-duplicates locally-originated interrupts.
 *
 * The activities still reset streaming playback for every interrupt. This state only decides
 * when a new assistant segment starts and whether another interrupt should cross the network.
 */
internal class LiveAudioInterruptCoordinator {
    private val lock = ReentrantLock()
    private var assistantTurnActive = false
    private var localInterruptPending = false

    fun beginAssistantTurn(): Boolean = lock.withLock {
        if (assistantTurnActive) {
            false
        } else {
            assistantTurnActive = true
            true
        }
    }

    fun shouldSendLocalInterrupt(
        disposition: InterruptedPcmFreezeDisposition,
    ): Boolean = lock.withLock {
        if (
            disposition == InterruptedPcmFreezeDisposition.DUPLICATE ||
            localInterruptPending
        ) {
            false
        } else {
            localInterruptPending = true
            true
        }
    }

    fun completeAssistantTurn() {
        lock.withLock {
            if (!localInterruptPending) {
                assistantTurnActive = false
            }
        }
    }

    fun receiveInterrupt() {
        lock.withLock {
            localInterruptPending = false
            assistantTurnActive = false
        }
    }

    fun reset() {
        lock.withLock {
            localInterruptPending = false
            assistantTurnActive = false
        }
    }
}
