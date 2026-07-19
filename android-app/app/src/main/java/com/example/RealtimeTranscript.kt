package com.example

/**
 * Buffers incremental Gemini Live transcript deltas without making each network chunk a
 * persisted chat message or a Compose-visible state update.
 */
internal class RealtimeTranscriptBuffer {
    private val lock = Any()
    private val text = StringBuilder()
    private var discardUntilCompletion = false
    private var closed = false

    fun append(chunk: String) {
        if (chunk.isEmpty()) return
        synchronized(lock) {
            if (!closed && !discardUntilCompletion) text.append(chunk)
        }
    }

    fun drain(): String = synchronized(lock) {
        if (closed) return@synchronized ""
        if (discardUntilCompletion) {
            text.setLength(0)
            discardUntilCompletion = false
            return@synchronized ""
        }
        val result = text.toString().trim()
        text.setLength(0)
        result
    }

    fun discardCurrentTurn() {
        synchronized(lock) {
            if (!closed) {
                text.setLength(0)
                discardUntilCompletion = true
            }
        }
    }

    fun clear() {
        synchronized(lock) { text.setLength(0) }
    }

    fun close() {
        synchronized(lock) {
            text.setLength(0)
            discardUntilCompletion = true
            closed = true
        }
    }
}

/** Ensures one approval gesture can produce at most one terminal rejection. */
internal class TerminalApprovalRejectionGuard {
    private val rejectedIds = mutableSetOf<String>()

    fun rejectOnce(approvalId: String, reject: (String) -> Boolean): Boolean = synchronized(rejectedIds) {
        if (approvalId in rejectedIds) return@synchronized false
        if (!reject(approvalId)) return@synchronized false
        rejectedIds.add(approvalId)
        true
    }

    fun clear(approvalId: String) {
        synchronized(rejectedIds) { rejectedIds.remove(approvalId) }
    }
}
