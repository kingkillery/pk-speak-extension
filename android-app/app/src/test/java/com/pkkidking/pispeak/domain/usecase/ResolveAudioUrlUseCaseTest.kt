package com.pkkidking.pispeak.domain.usecase

import org.junit.Assert.assertEquals
import org.junit.Test

class ResolveAudioUrlUseCaseTest {
    private val useCase = ResolveAudioUrlUseCase()

    @Test
    fun `resolves relative audio urls against server origin`() {
        assertEquals(
            "https://example.com/audio/reply.mp3",
            useCase("https://example.com/v1/status", "/audio/reply.mp3"),
        )
    }

    @Test
    fun `returns absolute audio urls unchanged`() {
        assertEquals(
            "https://cdn.example.com/reply.mp3",
            useCase("https://example.com/", "https://cdn.example.com/reply.mp3"),
        )
    }
}
