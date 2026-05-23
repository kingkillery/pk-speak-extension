package com.example.audio

import android.content.Context
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import java.io.File
import java.io.IOException

class AudioHelper(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var player: MediaPlayer? = null
    private var outputFile: File? = null

    fun getRecordedFile(fileName: String): File {
        return File(context.cacheDir, fileName)
    }

    fun startRecording(fileName: String): String? {
        val file = File(context.cacheDir, fileName)
        outputFile = file
        
        try {
            recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                MediaRecorder()
            }.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            return file.absolutePath
        } catch (e: Exception) {
            e.printStackTrace()
            return null
        }
    }

    fun getAmplitude(): Int {
        return try {
            recorder?.maxAmplitude ?: 0
        } catch (e: Exception) {
            0
        }
    }

    fun stopRecording() {
        try {
            recorder?.apply {
                stop()
                release()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            recorder = null
        }
    }

    fun startPlayback(fileNameOrPath: String, onComplete: () -> Unit = {}) {
        val absolutePath = if (fileNameOrPath.startsWith("/")) {
            fileNameOrPath
        } else {
            File(context.cacheDir, fileNameOrPath).absolutePath
        }

        stopPlayback()

        player = MediaPlayer().apply {
            try {
                setDataSource(absolutePath)
                prepare()
                setOnCompletionListener {
                    onComplete()
                    stopPlayback()
                }
                start()
            } catch (e: Exception) {
                e.printStackTrace()
                onComplete()
            }
        }
    }

    fun stopPlayback() {
        try {
            player?.apply {
                if (isPlaying) {
                    stop()
                }
                release()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            player = null
        }
    }

    fun isPlaying(): Boolean {
        return try {
            player?.isPlaying ?: false
        } catch (e: Exception) {
            false
        }
    }
}
