package com.example.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.math.max

/**
 * One-shot front-camera JPEG capture for realtime [camera_snapshot] tool calls.
 * Uses CameraX ImageCapture without a preview surface.
 */
object CameraSnapshot {
    private const val TAG = "CameraSnapshot"
    private val cameraExecutor: Executor = Executors.newSingleThreadExecutor()

    data class Frame(val mimeType: String, val base64: String)

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    suspend fun captureJpegBase64(
        context: Context,
        lifecycleOwner: LifecycleOwner,
        maxEdge: Int = 768,
        quality: Int = 70,
    ): Frame? = suspendCoroutine { cont ->
        if (!hasPermission(context)) {
            cont.resume(null)
            return@suspendCoroutine
        }
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                val provider = future.get()
                val imageCapture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                provider.unbindAll()
                provider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_FRONT_CAMERA,
                    imageCapture,
                )
                imageCapture.takePicture(
                    cameraExecutor,
                    object : ImageCapture.OnImageCapturedCallback() {
                        override fun onCaptureSuccess(image: ImageProxy) {
                            try {
                                val jpeg = imageProxyToJpeg(image, maxEdge, quality)
                                cont.resume(
                                    if (jpeg != null) Frame("image/jpeg", Base64.encodeToString(jpeg, Base64.NO_WRAP))
                                    else null,
                                )
                            } catch (e: Exception) {
                                Log.e(TAG, "encode failed", e)
                                cont.resume(null)
                            } finally {
                                image.close()
                                mainExecutor.execute {
                                    try { provider.unbindAll() } catch (_: Exception) {}
                                }
                            }
                        }

                        override fun onError(exception: ImageCaptureException) {
                            Log.e(TAG, "capture failed", exception)
                            mainExecutor.execute {
                                try { provider.unbindAll() } catch (_: Exception) {}
                            }
                            cont.resume(null)
                        }
                    },
                )
            } catch (e: Exception) {
                Log.e(TAG, "bind failed", e)
                cont.resume(null)
            }
        }, mainExecutor)
    }

    private fun imageProxyToJpeg(image: ImageProxy, maxEdge: Int, quality: Int): ByteArray? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        // ImageCapture defaults to JPEG output when possible; if not, decode/re-encode.
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        val scaled = scaleDown(bitmap, maxEdge)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(40, 95), out)
        if (scaled !== bitmap) scaled.recycle()
        bitmap.recycle()
        return out.toByteArray()
    }

    private fun scaleDown(src: Bitmap, maxEdge: Int): Bitmap {
        val longest = max(src.width, src.height)
        if (longest <= maxEdge) return src
        val scale = maxEdge.toFloat() / longest.toFloat()
        val w = (src.width * scale).toInt().coerceAtLeast(1)
        val h = (src.height * scale).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(src, w, h, true)
    }
}
