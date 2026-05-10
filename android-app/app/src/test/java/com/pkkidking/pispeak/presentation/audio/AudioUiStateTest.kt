package com.pkkidking.pispeak.presentation.audio

import com.pkkidking.pispeak.presentation.common.PlaybackState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioUiStateTest {

    @Test
    fun `defaults favor audio replies and autoplay`() {
        val state = AudioUiState()

        assertTrue(state.requestAudioReplies)
        assertTrue(state.autoplayReplyAudio)
        assertFalse(state.continuousConversation)
        assertEquals(PlaybackState.Idle, state.playbackState)
        assertNull(state.currentAudioUrl)
        assertNull(state.error)
    }

    @Test
    fun `hands free requires all audio flags enabled`() {
        val handsFree = AudioUiState(
            requestAudioReplies = true,
            speakEnabled = true,
            autoplayReplyAudio = true,
        )

        assertTrue(handsFree.canUseHandsFreeReplies)
    }

    @Test
    fun `hands free disabled when audio replies off`() {
        val textOnly = AudioUiState(
            requestAudioReplies = false,
            autoplayReplyAudio = true,
        )

        assertFalse(textOnly.canUseHandsFreeReplies)
    }

    @Test
    fun `hands free disabled when autoplay off`() {
        val manualPlay = AudioUiState(
            requestAudioReplies = true,
            autoplayReplyAudio = false,
        )

        assertFalse(manualPlay.canUseHandsFreeReplies)
    }

    @Test
    fun `reply mode labels match expectations`() {
        assertEquals("Text replies", AudioUiState(requestAudioReplies = false).replyModeLabel())
        assertEquals("Tap to play", AudioUiState(speakEnabled = true, autoplayReplyAudio = false).replyModeLabel())
        assertEquals("Loop on", AudioUiState(speakEnabled = true, continuousConversation = true).replyModeLabel())
        assertEquals("Hands-free", AudioUiState(speakEnabled = true).replyModeLabel())
    }
}
