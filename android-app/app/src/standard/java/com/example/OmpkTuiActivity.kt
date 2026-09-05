package com.example

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.example.data.AppPreferences
import org.json.JSONObject
import java.io.File
import java.net.URI

class OmpkTuiActivity : ComponentActivity() {
    private lateinit var preferences: AppPreferences
    private lateinit var webView: WebView
    private var gatewayBaseUrl: String? = null
    private var tokenScriptHandler: ScriptHandler? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var nativeAudioPort: WebMessagePort? = null
    private var nativeRecorder: MediaRecorder? = null
    private var nativeRecordingFile: File? = null
    private var pendingNativeStartRequestId: String? = null
    private var gatewayLoadFailed = false
    private var reconnectAttempt = 0
    private var reconnectRunnable: Runnable? = null
    private val webPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        val request = pendingWebPermission
        pendingWebPermission = null
        if (request == null || !isGatewayOrigin(request.origin)) return@registerForActivityResult
        val resources = grantableWebResources(request)
        if (resources.isEmpty()) request.deny() else request.grant(resources.toTypedArray())
    }
    private val nativeMicPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val requestId = pendingNativeStartRequestId
        pendingNativeStartRequestId = null
        if (requestId == null) return@registerForActivityResult
        if (!granted) {
            postNativeAudioError(requestId, "Microphone permission was denied.")
            return@registerForActivityResult
        }
        startNativeRecording(requestId)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = false
        preferences = AppPreferences(this)
        applySetupIntent(intent)
        webView = createWebView()
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(24, 24, 30))
            addView(
                webView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val params = webView.layoutParams as FrameLayout.LayoutParams
            params.setMargins(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            webView.layoutParams = params
            insets
        }
        ViewCompat.requestApplyInsets(root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
        loadOmpkTui()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applySetupIntent(intent)
        loadOmpkTui()
    }

    override fun onDestroy() {
        pendingWebPermission?.deny()
        pendingWebPermission = null
        pendingNativeStartRequestId = null
        releaseNativeRecording()
        cancelGatewayReconnect()
        tokenScriptHandler?.remove()
        tokenScriptHandler = null
        nativeAudioPort?.close()
        nativeAudioPort = null
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }

    private fun createWebView(): WebView = WebView(this).apply {
        setBackgroundColor(Color.rgb(24, 24, 30))
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.safeBrowsingEnabled = true
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                if (target.scheme == "pi-speak" && target.host == "configure") {
                    startActivity(Intent(this@OmpkTuiActivity, MainActivity::class.java))
                    return true
                }
                val candidate = runCatching { URI(target.toString()) }.getOrNull()
                val baseUrl = gatewayBaseUrl
                if (candidate != null && baseUrl != null && sameOmpkGatewayOrigin(candidate, baseUrl)) return false
                if (target.scheme == "http" || target.scheme == "https") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, target)) }
                }
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                gatewayLoadFailed = true
                view.post {
                    if (gatewayLoadFailed) {
                        showSetupPage("The gateway could not be reached. Reconnecting automatically; check Tailscale or Wi-Fi.")
                    }
                }
                scheduleGatewayReconnect()
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (gatewayLoadFailed || !isGatewayPage(url)) return
                reconnectAttempt = 0
                cancelGatewayReconnect()
                connectNativeAudioBridge()
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleWebPermissionRequest(request) }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingWebPermission === request) pendingWebPermission = null
            }
        }
    }

    private fun loadOmpkTui(resetReconnectAttempts: Boolean = true) {
        if (resetReconnectAttempts) {
            reconnectAttempt = 0
            cancelGatewayReconnect()
        }
        val baseUrl = normalizeOmpkGatewayBaseUrl(preferences.targetIpAddress)
        val token = preferences.remoteToken
        if (baseUrl == null || token.isBlank()) {
            gatewayBaseUrl = null
            showSetupPage("Scan the setup QR from the gateway, or open configuration and enter the gateway address and token.")
            return
        }
        gatewayBaseUrl = baseUrl
        tokenScriptHandler?.remove()
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            showSetupPage("Android System WebView needs an update before this app can load the gateway token securely.")
            return
        }
        tokenScriptHandler = WebViewCompat.addDocumentStartJavaScript(
            webView,
            buildOmpkTokenInjectionScript(token),
            setOf(baseUrl),
        )
        gatewayLoadFailed = false
        webView.loadUrl("$baseUrl/app/")
    }

    private fun scheduleGatewayReconnect() {
        if (reconnectRunnable != null || gatewayBaseUrl == null || isFinishing || isDestroyed) return
        val delayMillis = ompkReconnectDelayMillis(reconnectAttempt)
        reconnectAttempt += 1
        reconnectRunnable = Runnable {
            reconnectRunnable = null
            loadOmpkTui(resetReconnectAttempts = false)
        }.also { webView.postDelayed(it, delayMillis) }
    }

    private fun cancelGatewayReconnect() {
        reconnectRunnable?.let { webView.removeCallbacks(it) }
        reconnectRunnable = null
    }

    private fun showSetupPage(message: String) {
        webView.loadDataWithBaseURL(
            "https://appassets.androidplatform.net/",
            buildOmpkSetupHtml(message),
            "text/html",
            "utf-8",
            null,
        )
    }

    private fun applySetupIntent(intent: Intent?) {
        val setup = parseSetupDeepLink(intent?.data) ?: return
        applySetupDeepLink(preferences, setup)
    }

    private fun handleWebPermissionRequest(request: PermissionRequest) {
        if (!isGatewayOrigin(request.origin)) {
            request.deny()
            return
        }
        val androidPermissions = requiredAndroidPermissions(request)
        if (androidPermissions.isEmpty()) {
            request.deny()
            return
        }
        val missingPermissions = androidPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missingPermissions.isEmpty()) {
            request.grant(grantableWebResources(request).toTypedArray())
            return
        }
        pendingWebPermission?.deny()
        pendingWebPermission = request
        webPermissionLauncher.launch(missingPermissions.toTypedArray())
    }

    private fun requiredAndroidPermissions(request: PermissionRequest): List<String> = buildList {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources) add(Manifest.permission.RECORD_AUDIO)
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources) add(Manifest.permission.CAMERA)
    }

    private fun grantableWebResources(request: PermissionRequest): List<String> = buildList {
        if (
            PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources &&
            ContextCompat.checkSelfPermission(this@OmpkTuiActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        ) add(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        if (
            PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources &&
            ContextCompat.checkSelfPermission(this@OmpkTuiActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        ) add(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
    }

    private fun isGatewayOrigin(origin: Uri): Boolean {
        val baseUrl = gatewayBaseUrl ?: return false
        val candidate = runCatching { URI(origin.toString()) }.getOrNull() ?: return false
        return sameOmpkGatewayOrigin(candidate, baseUrl)
    }

    private fun isGatewayPage(url: String?): Boolean {
        val baseUrl = gatewayBaseUrl ?: return false
        val candidate = runCatching { URI(url) }.getOrNull() ?: return false
        return sameOmpkGatewayOrigin(candidate, baseUrl) && candidate.path.startsWith("/app/")
    }

    private fun connectNativeAudioBridge() {
        val baseUrl = gatewayBaseUrl ?: return
        nativeAudioPort?.close()
        nativeAudioPort = null
        val ports = webView.createWebMessageChannel()
        nativeAudioPort = ports[0].apply {
            setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                override fun onMessage(port: WebMessagePort, message: WebMessage) {
                    handleNativeAudioMessage(message.data)
                }
            })
        }
        webView.postWebMessage(WebMessage("ompk-native-audio", arrayOf(ports[1])), Uri.parse(baseUrl))
    }

    private fun handleNativeAudioMessage(rawMessage: String?) {
        if (!isGatewayPage(webView.url)) return
        val message = runCatching { JSONObject(rawMessage.orEmpty()) }.getOrNull() ?: return
        val requestId = message.optString("id").takeIf { it.isNotBlank() && it.length <= 64 } ?: return
        when (message.optString("type")) {
            "start" -> requestNativeRecording(requestId)
            "stop" -> stopNativeRecording(requestId)
            else -> postNativeAudioError(requestId, "Unsupported microphone request.")
        }
    }

    private fun requestNativeRecording(requestId: String) {
        if (nativeRecorder != null || pendingNativeStartRequestId != null) {
            postNativeAudioError(requestId, "Microphone is already recording.")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startNativeRecording(requestId)
            return
        }
        pendingNativeStartRequestId = requestId
        nativeMicPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    @Suppress("DEPRECATION")
    private fun startNativeRecording(requestId: String) {
        if (!isGatewayPage(webView.url)) {
            postNativeAudioError(requestId, "Microphone is unavailable on this page.")
            return
        }
        val outputFile = runCatching { File.createTempFile("ompk-voice-", ".m4a", cacheDir) }.getOrElse {
            postNativeAudioError(requestId, "Could not prepare microphone recording.")
            return
        }
        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else MediaRecorder()
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioSamplingRate(44_100)
            recorder.setAudioEncodingBitRate(96_000)
            recorder.setOutputFile(outputFile.absolutePath)
            recorder.prepare()
            recorder.start()
            nativeRecorder = recorder
            nativeRecordingFile = outputFile
            postNativeAudioSuccess(requestId, JSONObject().put("event", "started"))
        } catch (_: Exception) {
            recorder.release()
            outputFile.delete()
            postNativeAudioError(requestId, "Could not start microphone recording.")
        }
    }

    private fun stopNativeRecording(requestId: String) {
        val recorder = nativeRecorder
        val outputFile = nativeRecordingFile
        nativeRecorder = null
        nativeRecordingFile = null
        if (recorder == null || outputFile == null) {
            postNativeAudioError(requestId, "Microphone is not recording.")
            return
        }
        val stopped = runCatching { recorder.stop() }.isSuccess
        recorder.release()
        if (!stopped || !outputFile.isFile || outputFile.length() == 0L) {
            outputFile.delete()
            postNativeAudioError(requestId, "Recording was too short. Hold the mic button a little longer.")
            return
        }
        if (outputFile.length() > MAX_NATIVE_AUDIO_BYTES) {
            outputFile.delete()
            postNativeAudioError(requestId, "Recording is too long. Keep voice turns under a few minutes.")
            return
        }
        val audio = runCatching { Base64.encodeToString(outputFile.readBytes(), Base64.NO_WRAP) }.getOrNull()
        outputFile.delete()
        if (audio == null) {
            postNativeAudioError(requestId, "Could not read microphone recording.")
            return
        }
        postNativeAudioSuccess(
            requestId,
            JSONObject()
                .put("mimeType", "audio/mp4")
                .put("data", audio),
        )
    }

    private fun releaseNativeRecording() {
        val recorder = nativeRecorder
        nativeRecorder = null
        runCatching { recorder?.stop() }
        recorder?.release()
        nativeRecordingFile?.delete()
        nativeRecordingFile = null
    }

    private fun postNativeAudioSuccess(requestId: String, payload: JSONObject) {
        payload.put("id", requestId).put("ok", true)
        nativeAudioPort?.postMessage(WebMessage(payload.toString()))
    }

    private fun postNativeAudioError(requestId: String, message: String) {
        nativeAudioPort?.postMessage(
            WebMessage(
                JSONObject()
                    .put("id", requestId)
                    .put("ok", false)
                    .put("error", message)
                    .toString(),
            ),
        )
    }

    private companion object {
        const val MAX_NATIVE_AUDIO_BYTES = 16L * 1024L * 1024L
    }
}
