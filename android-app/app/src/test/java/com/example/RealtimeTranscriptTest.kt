package com.example

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeTranscriptTest {
    @Test
    fun transcriptChunksDrainAsOneMessage() {
        val buffer = RealtimeTranscriptBuffer()

        buffer.append("Hello ")
        buffer.append("")
        buffer.append("world")

        assertEquals("Hello world", buffer.drain())
        assertEquals("", buffer.drain())
    }

    @Test
    fun repeatedTranscriptDeltaIsPreserved() {
        val buffer = RealtimeTranscriptBuffer()

        buffer.append("go ")
        buffer.append("go")

        assertEquals("go go", buffer.drain())
    }

    @Test
    fun interruptedTurnDiscardsLateChunksUntilCompletion() {
        val buffer = RealtimeTranscriptBuffer()

        buffer.append("partial")
        buffer.discardCurrentTurn()
        buffer.append(" late")

        assertEquals("", buffer.drain())
        buffer.append("next turn")
        assertEquals("next turn", buffer.drain())
    }

    @Test
    fun approvalRejectionIsSentOnceUntilResolved() {
        val guard = TerminalApprovalRejectionGuard()
        val rejectedIds = mutableListOf<String>()

        assertTrue(guard.rejectOnce("approval-1") { rejectedIds.add(it); true })
        assertFalse(guard.rejectOnce("approval-1") { rejectedIds.add(it); true })
        assertEquals(listOf("approval-1"), rejectedIds)

        guard.clear("approval-1")
        assertFalse(guard.rejectOnce("approval-1") { false })
        assertTrue(guard.rejectOnce("approval-1") { rejectedIds.add(it); true })
        assertEquals(listOf("approval-1", "approval-1"), rejectedIds)
    }
}
