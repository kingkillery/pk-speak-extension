package com.example.audio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.Assert.assertTrue

class InterruptedPcmBufferTest {
    @Test
    fun freezeRetainsAcceptedChunksAndTheirSampleRate() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)
        val first = byteArrayOf(1, 2, 3)
        val second = byteArrayOf(4, 5)

        buffer.append(first, sampleRate = 16_000)
        buffer.append(second, sampleRate = 16_000)

        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())
        val replay = requireNotNull(buffer.replaySnapshot())
        assertEquals(16_000, replay.sampleRate)
        assertEquals(2, replay.chunks.size)
        assertArrayEquals(first, replay.chunks[0])
        assertArrayEquals(second, replay.chunks[1])
    }

    @Test
    fun duplicateFreezeDoesNotErasePriorInterruptedAudioOrKeepResidualTail() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)
        buffer.append(byteArrayOf(1, 2), sampleRate = 24_000)
        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())
        buffer.append(byteArrayOf(9), sampleRate = 24_000)

        assertEquals(InterruptedPcmFreezeDisposition.DUPLICATE, buffer.freezeCurrentSegment())

        val replay = requireNotNull(buffer.replaySnapshot())
        assertEquals(24_000, replay.sampleRate)
        assertArrayEquals(byteArrayOf(1, 2), replay.chunks.single())
        assertEquals(InterruptedPcmFreezeDisposition.DUPLICATE, buffer.freezeCurrentSegment())
    }

    @Test
    fun firstEmptyFreezeLatchesUntilTheNextAssistantSegment() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)

        assertEquals(InterruptedPcmFreezeDisposition.FIRST_EMPTY, buffer.freezeCurrentSegment())
        assertEquals(InterruptedPcmFreezeDisposition.DUPLICATE, buffer.freezeCurrentSegment())

        buffer.beginSegment()

        assertEquals(InterruptedPcmFreezeDisposition.FIRST_EMPTY, buffer.freezeCurrentSegment())
    }

    @Test
    fun newAssistantSegmentBeforeEchoMakesInterruptFirstEmptyAndPreservesReplay() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)
        val captured = byteArrayOf(1, 2)
        buffer.append(captured, sampleRate = 24_000)
        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())

        buffer.beginSegment()

        assertEquals(InterruptedPcmFreezeDisposition.FIRST_EMPTY, buffer.freezeCurrentSegment())
        assertArrayEquals(captured, requireNotNull(buffer.replaySnapshot()).chunks.single())
        assertEquals(InterruptedPcmFreezeDisposition.DUPLICATE, buffer.freezeCurrentSegment())
    }

    @Test
    fun laterSegmentCanReplaceInterruptedAudio() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)
        buffer.append(byteArrayOf(1), sampleRate = 24_000)
        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())

        buffer.beginSegment()
        buffer.append(byteArrayOf(7, 8), sampleRate = 16_000)
        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())

        val replay = requireNotNull(buffer.replaySnapshot())
        assertEquals(16_000, replay.sampleRate)
        assertArrayEquals(byteArrayOf(7, 8), replay.chunks.single())
    }

    @Test
    fun sampleRateChangeDropsIncompatibleCurrentChunks() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)
        buffer.append(byteArrayOf(1, 2), sampleRate = 24_000)
        buffer.append(byteArrayOf(3, 4), sampleRate = 16_000)

        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())
        val replay = requireNotNull(buffer.replaySnapshot())
        assertEquals(16_000, replay.sampleRate)
        assertArrayEquals(byteArrayOf(3, 4), replay.chunks.single())
    }

    @Test
    fun bufferEvictsOldestChunksToRespectByteLimit() {
        val buffer = InterruptedPcmBuffer(maxBytes = 5)
        buffer.append(byteArrayOf(1, 2, 3), sampleRate = 24_000)
        buffer.append(byteArrayOf(4, 5, 6), sampleRate = 24_000)

        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())
        val replay = requireNotNull(buffer.replaySnapshot())
        assertEquals(1, replay.chunks.size)
        assertArrayEquals(byteArrayOf(4, 5, 6), replay.chunks.single())
    }

    @Test
    fun assistantTurnBeginsOnlyOnceAcrossAudioAndTranscriptCallbacks() {
        val coordinator = LiveAudioInterruptCoordinator()

        assertTrue(coordinator.beginAssistantTurn())
        assertFalse(coordinator.beginAssistantTurn())

        coordinator.completeAssistantTurn()

        assertTrue(coordinator.beginAssistantTurn())
    }

    @Test
    fun completionWaitsForEchoWhileLocalInterruptIsPending() {
        val coordinator = LiveAudioInterruptCoordinator()
        assertTrue(coordinator.beginAssistantTurn())
        assertTrue(
            coordinator.shouldSendLocalInterrupt(
                InterruptedPcmFreezeDisposition.CAPTURED,
            ),
        )

        coordinator.completeAssistantTurn()

        assertFalse(coordinator.beginAssistantTurn())
        coordinator.receiveInterrupt()
        assertTrue(coordinator.beginAssistantTurn())
    }

    @Test
    fun duplicateAndRepeatedLocalInterruptsDoNotCrossTheNetwork() {
        val coordinator = LiveAudioInterruptCoordinator()

        assertFalse(
            coordinator.shouldSendLocalInterrupt(
                InterruptedPcmFreezeDisposition.DUPLICATE,
            ),
        )
        assertTrue(
            coordinator.shouldSendLocalInterrupt(
                InterruptedPcmFreezeDisposition.FIRST_EMPTY,
            ),
        )
        assertFalse(
            coordinator.shouldSendLocalInterrupt(
                InterruptedPcmFreezeDisposition.CAPTURED,
            ),
        )
    }

    @Test
    fun queuedTailBeforeEchoCannotReplaceTheUsefulReplay() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)
        val coordinator = LiveAudioInterruptCoordinator()
        val captured = byteArrayOf(1, 2)

        assertTrue(coordinator.beginAssistantTurn())
        buffer.append(captured, sampleRate = 24_000)
        val disposition = buffer.freezeCurrentSegment()
        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, disposition)
        assertTrue(coordinator.shouldSendLocalInterrupt(disposition))

        coordinator.completeAssistantTurn()
        assertFalse(coordinator.beginAssistantTurn())
        buffer.append(byteArrayOf(9), sampleRate = 24_000)
        assertEquals(
            InterruptedPcmFreezeDisposition.DUPLICATE,
            buffer.freezeCurrentSegment(),
        )
        assertArrayEquals(captured, requireNotNull(buffer.replaySnapshot()).chunks.single())

        coordinator.receiveInterrupt()
        assertTrue(coordinator.beginAssistantTurn())
    }

    @Test
    fun resetClearsPendingInterruptForReplacementSession() {
        val coordinator = LiveAudioInterruptCoordinator()
        assertTrue(coordinator.beginAssistantTurn())
        assertTrue(
            coordinator.shouldSendLocalInterrupt(
                InterruptedPcmFreezeDisposition.CAPTURED,
            ),
        )

        coordinator.reset()

        assertTrue(coordinator.beginAssistantTurn())
        assertTrue(
            coordinator.shouldSendLocalInterrupt(
                InterruptedPcmFreezeDisposition.FIRST_EMPTY,
            ),
        )
    }

    @Test
    fun clearDropsCurrentAndInterruptedAudio() {
        val buffer = InterruptedPcmBuffer(maxBytes = 12)
        buffer.append(byteArrayOf(1), sampleRate = 24_000)
        assertEquals(InterruptedPcmFreezeDisposition.CAPTURED, buffer.freezeCurrentSegment())
        buffer.append(byteArrayOf(2), sampleRate = 24_000)

        buffer.clear()

        assertNull(buffer.replaySnapshot())
        assertEquals(InterruptedPcmFreezeDisposition.FIRST_EMPTY, buffer.freezeCurrentSegment())
    }

    @Test
    fun replayWaitsForStreamingWritesAndQueuedPlayback() {
        assertTrue(
            streamingAudioBlocksReplay(
                writesInFlight = 1,
                framesWritten = 0,
                framesPlayed = 0,
            ),
        )
        assertTrue(
            streamingAudioBlocksReplay(
                writesInFlight = 0,
                framesWritten = 480,
                framesPlayed = 240,
            ),
        )
        assertFalse(
            streamingAudioBlocksReplay(
                writesInFlight = 0,
                framesWritten = 480,
                framesPlayed = 480,
            ),
        )
    }
}
