package com.example

import android.util.Base64
import java.net.URI

internal const val OMPK_WEB_TOKEN_KEY = "piSpeakRemoteToken"

private val OMPK_RECONNECT_DELAYS_MS = longArrayOf(1_000L, 2_000L, 5_000L, 10_000L)

internal fun ompkReconnectDelayMillis(attempt: Int): Long =
    OMPK_RECONNECT_DELAYS_MS[attempt.coerceIn(0, OMPK_RECONNECT_DELAYS_MS.lastIndex)]

internal fun normalizeOmpkGatewayBaseUrl(value: String): String? {
    val parsed = runCatching { URI(value.trim()) }.getOrNull() ?: return null
    val scheme = parsed.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return null
    if (parsed.host.isNullOrBlank() || parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) return null
    if (!parsed.path.isNullOrBlank() && parsed.path != "/") return null
    return URI(scheme, null, parsed.host, parsed.port, null, null, null).toString().trimEnd('/')
}

internal fun sameOmpkGatewayOrigin(candidate: URI, gatewayBaseUrl: String): Boolean {
    val gateway = runCatching { URI(gatewayBaseUrl) }.getOrNull() ?: return false
    return candidate.scheme.equals(gateway.scheme, ignoreCase = true) &&
        candidate.host.equals(gateway.host, ignoreCase = true) &&
        effectivePort(candidate) == effectivePort(gateway)
}

internal fun buildOmpkTokenInjectionScript(token: String): String {
    val encodedToken = Base64.encodeToString(token.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    return "sessionStorage.setItem('$OMPK_WEB_TOKEN_KEY', atob('$encodedToken')); sessionStorage.getItem('$OMPK_WEB_TOKEN_KEY') !== null;"
}

internal fun buildOmpkSetupHtml(message: String): String {
    val safeMessage = message
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
    return """
        <!doctype html>
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#18181e;color:#f4f1ed;font:14px monospace">
          <main style="width:min(88vw,420px);border:1px solid #3d424a;padding:20px">
            <div style="color:#febc38;font-weight:800;letter-spacing:.08em">OMPK / ANDROID</div>
            <h1 style="font-size:18px">Gateway setup required</h1>
            <p style="color:#9ca3af;line-height:1.6">$safeMessage</p>
            <a href="pi-speak://configure" style="display:block;border:1px solid #178fb9;padding:12px;color:#febc38;text-align:center;text-decoration:none">OPEN CONFIGURATION</a>
          </main>
        </body></html>
    """.trimIndent()
}

private fun effectivePort(uri: URI): Int = when {
    uri.port >= 0 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    else -> 80
}
