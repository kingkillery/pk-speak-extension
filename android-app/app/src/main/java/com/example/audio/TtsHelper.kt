package com.example.audio

import android.content.Context
import android.speech.tts.TextToSpeech
import android.util.Log
import java.util.Locale

class TtsHelper(context: Context) : TextToSpeech.OnInitListener {
    private var tts: TextToSpeech? = TextToSpeech(context, this)
    private var isInitialized = false
    private var pendingText: String? = null
    private var onCompleteCallback: (() -> Unit)? = null

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts?.setLanguage(Locale.US)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                Log.e("TTS", "Language is not supported or missing data")
            } else {
                isInitialized = true
                Log.d("TTS", "TextToSpeech successfully initialized")
                tts?.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        onCompleteCallback?.invoke()
                        onCompleteCallback = null
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        onCompleteCallback?.invoke()
                        onCompleteCallback = null
                    }
                })
                pendingText?.let {
                    speak(it)
                    pendingText = null
                }
            }
        } else {
            Log.e("TTS", "Initialization failed")
        }
    }

    fun speak(text: String, onComplete: (() -> Unit)? = null) {
        if (!isInitialized) {
            pendingText = text
            onCompleteCallback = onComplete
            Log.d("TTS", "TTS not ready yet, queuing text: $text")
            return
        }
        try {
            tts?.stop()
            onCompleteCallback = onComplete
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "PiSpeakUtterance")
            Log.d("TTS", "Speaking text out loud: $text")
        } catch (e: Exception) {
            Log.e("TTS", "Error during speak", e)
            onComplete?.invoke()
            onCompleteCallback = null
        }
    }

    fun stop() {
        try {
            tts?.stop()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun shutdown() {
        try {
            tts?.shutdown()
        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            tts = null
            isInitialized = false
        }
    }
}
