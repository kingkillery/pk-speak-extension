package com.pkkidking.pispeak.core

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AppAudioPlayer @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private var player: MediaPlayer? = null

    fun play(
        url: String,
        headers: Map<String, String> = emptyMap(),
        onStart: () -> Unit = {},
        onComplete: () -> Unit = {},
        onError: (String) -> Unit = {},
    ) {
        stop()
        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build(),
            )
            setOnPreparedListener {
                it.start()
                onStart()
            }
            setOnCompletionListener {
                onComplete()
                stop()
            }
            setOnErrorListener { _, what, extra ->
                onError("Audio playback failed ($what/$extra)")
                stop()
                true
            }
            setDataSource(context, Uri.parse(url), headers)
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
