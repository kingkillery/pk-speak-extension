package com.pkkidking.pispeak.core

import android.media.AudioAttributes
import android.media.MediaPlayer
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AppAudioPlayer @Inject constructor() {
    private var player: MediaPlayer? = null

    fun play(url: String, onComplete: () -> Unit = {}, onError: (String) -> Unit = {}) {
        stop()
        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build(),
            )
            setOnPreparedListener { it.start() }
            setOnCompletionListener {
                onComplete()
                stop()
            }
            setOnErrorListener { _, what, extra ->
                onError("Audio playback failed ($what/$extra)")
                stop()
                true
            }
            setDataSource(url)
            prepareAsync()
        }
    }

    fun stop() {
        player?.runCatching {
            if (isPlaying) stop()
            reset()
            release()
        }
        player = null
    }
}
