package com.example

import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.runtime.Composable
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Shared ZXing setup-QR scanner launcher.
 *
 * Returns a [ManagedActivityResultLauncher] that invokes [onResult] with the raw
 * scanned content — typically a native `pi-speak://setup?...` deep link or an
 * http(s) URL carrying a `?token=` — or null when the scan is cancelled. Parsing
 * and applying the content is the caller's responsibility, so each caller keeps
 * its own accept/reject flow.
 *
 * CAMERA permission handling is also the caller's responsibility.
 */
@Composable
fun rememberSetupQrScanner(
    onResult: (content: String?) -> Unit
): ManagedActivityResultLauncher<ScanOptions, ScanIntentResult> {
    return rememberLauncherForActivityResult(ScanContract()) { result ->
        onResult(result.contents)
    }
}

/**
 * Scan options tuned for the pi-speak setup QR: orientation unlocked (phones and
 * e-ink handhelds alike), beep disabled, and the setup-specific prompt.
 */
fun setupScanOptions(): ScanOptions = ScanOptions().apply {
    setOrientationLocked(false)
    setBeepEnabled(false)
    setPrompt("Point at the pi-speak setup QR code")
}
