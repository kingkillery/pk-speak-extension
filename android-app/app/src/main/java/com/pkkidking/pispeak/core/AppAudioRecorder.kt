package com.pkkidking.pispeak.core

import android.content.Context
import android.media.MediaRecorder
import dagger.hilt.android.qualifiers.ApplicationContext
import com.pkkidking.pispeak.domain.model.RecordedAudio
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AppAudioRecorder @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private var mediaRecorder: MediaRecorder? = null
    private var outputFile: File? = null

    fun start() {
        if (mediaRecorder != null) return
        val file = File(context.cacheDir, "pi-speak-${System.currentTimeMillis()}.m4a")
        outputFile = file
        mediaRecorder = MediaRecorder().apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioSamplingRate(44_100)
            setAudioEncodingBitRate(128_000)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }
    }

    fun stop(): RecordedAudio {
        val recorder = requireNotNull(mediaRecorder) { "Recorder is not active" }
        val file = requireNotNull(outputFile) { "Output file missing" }
        recorder.stop()
        recorder.reset()
        recorder.release()
        mediaRecorder = null
        outputFile = null
        return RecordedAudio(filePath = file.absolutePath, mimeType = "audio/mp4")
    }

    fun cancel() {
        mediaRecorder?.runCatching { stop() }
        mediaRecorder?.release()
        mediaRecorder = null
        outputFile?.delete()
        outputFile = null
    }
}
