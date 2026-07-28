package com.example.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AppPreferencesTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun generatedMoshiAdaptersRoundTripPersistedModels() {
        val preferences = AppPreferences(context)
        val session = RecordedSession(
            id = "session-1",
            timestamp = 42L,
            durationSeconds = 3,
            recordingPath = "recording.wav",
            transcriptionText = "hello",
            replyText = "ready",
        )
        val message = ChatMessage(
            id = "message-1",
            role = "assistant",
            text = "ready",
            timestampMs = 42L,
            baseUrl = "https://gateway.example",
        )

        preferences.saveRecordedSessions(listOf(session))
        preferences.saveChatMessages("conversation", listOf(message))

        assertEquals(listOf(session), preferences.getRecordedSessions())
        assertEquals(listOf(message), preferences.getChatMessages("conversation"))
    }
}
