package com.example.audio

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder.AudioSource
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.min

class AudioHelper(private val context: Context) {
    private var recorder: AudioRecord? = null
    private var recordingThread: Thread? = null
    private val recording = AtomicBoolean(false)
    private var player: MediaPlayer? = null
    private var outputFile: File? = null
    @Volatile private var lastAmplitude: Int = 0

    fun getRecordedFile(fileName: String): File {
        return File(context.cacheDir, fileName)
    }

    fun startRecording(fileName: String): String? {
        val file = File(context.cacheDir, fileName)
        outputFile = file
        if (file.exists()) {
            file.delete()
        }
        
        try {
            val sampleRate = 16_000
            val channelConfig = AudioFormat.CHANNEL_IN_MONO
            val encoding = AudioFormat.ENCODING_PCM_16BIT
            val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelConfig, encoding)
            val bufferSize = maxOf(minBuffer, sampleRate)
            val audioRecord = AudioRecord(
                AudioSource.MIC,
                sampleRate,
                channelConfig,
                encoding,
                bufferSize
            )
            recorder = audioRecord
            recording.set(true)
            audioRecord.startRecording()
            Log.d("AudioHelper", "Started WAV recording: ${file.absolutePath}")
            recordingThread = thread(start = true, name = "pi-speak-wav-recorder") {
                writeWavFile(file, audioRecord, bufferSize, sampleRate)
            }
            return file.absolutePath
        } catch (e: Exception) {
            e.printStackTrace()
            return null
        }
    }

    fun getAmplitude(): Int {
        return lastAmplitude
    }

    fun stopRecording(): Boolean {
        var stopped = false
        try {
            recording.set(false)
            recordingThread?.join(1500)
            recorder?.stop()
            stopped = true
            Log.d("AudioHelper", "Stopped WAV recording: ${outputFile?.absolutePath}, bytes=${outputFile?.length() ?: 0}")
        } catch (e: Exception) {
            Log.e("AudioHelper", "Failed to stop WAV recording", e)
            e.printStackTrace()
        } finally {
            try {
                recorder?.release()
            } catch (_: Exception) {}
            recorder = null
            recordingThread = null
            lastAmplitude = 0
        }
        return stopped
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

    private fun writeWavFile(file: File, audioRecord: AudioRecord, bufferSize: Int, sampleRate: Int) {
        var pcmBytes = 0L
        RandomAccessFile(file, "rw").use { wav ->
            wav.setLength(0)
            writeWavHeader(wav, sampleRate, 0)
            val buffer = ShortArray(bufferSize / 2)
            while (recording.get()) {
                val read = audioRecord.read(buffer, 0, buffer.size)
                if (read <= 0) continue
                var peak = 0
                for (i in 0 until read) {
                    peak = maxOf(peak, min(abs(buffer[i].toInt()), Short.MAX_VALUE.toInt()))
                    wav.write(buffer[i].toInt() and 0xff)
                    wav.write((buffer[i].toInt() shr 8) and 0xff)
                }
                lastAmplitude = peak
                pcmBytes += read * 2L
            }
            wav.seek(0)
            writeWavHeader(wav, sampleRate, pcmBytes)
            Log.d("AudioHelper", "Finalized WAV recording: ${file.absolutePath}, pcmBytes=$pcmBytes, totalBytes=${file.length()}")
        }
    }

    private fun writeWavHeader(wav: RandomAccessFile, sampleRate: Int, dataBytes: Long) {
        val channels = 1
        val bitsPerSample = 16
        val byteRate = sampleRate * channels * bitsPerSample / 8
        wav.writeBytes("RIFF")
        writeIntLE(wav, (36 + dataBytes).toInt())
        wav.writeBytes("WAVE")
        wav.writeBytes("fmt ")
        writeIntLE(wav, 16)
        writeShortLE(wav, 1)
        writeShortLE(wav, channels)
        writeIntLE(wav, sampleRate)
        writeIntLE(wav, byteRate)
        writeShortLE(wav, channels * bitsPerSample / 8)
        writeShortLE(wav, bitsPerSample)
        wav.writeBytes("data")
        writeIntLE(wav, dataBytes.toInt())
    }

    private fun writeIntLE(file: RandomAccessFile, value: Int) {
        file.write(value and 0xff)
        file.write((value shr 8) and 0xff)
        file.write((value shr 16) and 0xff)
        file.write((value shr 24) and 0xff)
    }

    private fun writeShortLE(file: RandomAccessFile, value: Int) {
        file.write(value and 0xff)
        file.write((value shr 8) and 0xff)
    }
}
