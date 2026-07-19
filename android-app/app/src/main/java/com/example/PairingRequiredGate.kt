package com.example

import android.app.Activity
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.example.api.ConnectionReason
import com.example.api.ConnectionTestReport
import com.example.api.VoiceAgentClient
import com.example.data.AppPreferences
import com.example.ui.theme.Accent
import com.example.ui.theme.Error
import com.example.ui.theme.Ink
import com.example.ui.theme.InkMuted
import com.example.ui.theme.Line
import com.example.ui.theme.Success
import com.example.ui.theme.SurfacePaper
import com.example.ui.theme.SurfaceSubtle
import com.example.ui.theme.Warn
import kotlinx.coroutines.launch

internal fun parsePairingSetupInput(value: String, token: String = ""): SetupDeepLink? {
    val raw = value.trim()
    if (raw.isBlank()) return null
    val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return null
    parseSetupDeepLink(uri)?.let { return it }

    val scheme = uri.scheme?.lowercase()
    val host = uri.host
    if ((scheme != "http" && scheme != "https") || host.isNullOrBlank()) return null
    val resolvedToken = uri.getQueryParameter("token")?.takeIf { it.isNotBlank() }
        ?: token.trim().takeIf { it.isNotBlank() }
        ?: return null
    val formattedHost = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host
    val baseUrl = buildString {
        append(scheme)
        append("://")
        append(formattedHost)
        if (uri.port != -1) {
            append(':')
            append(uri.port)
        }
    }
    val synthetic = Uri.Builder()
        .scheme("pi-speak")
        .authority("setup")
        .appendQueryParameter("base_url", baseUrl)
        .appendQueryParameter("token", resolvedToken)
        .build()
    return parseSetupDeepLink(synthetic)
}

@Composable
fun PairingRequiredGate(
    connectionReason: ConnectionReason,
    detail: String,
    prefs: AppPreferences,
    client: VoiceAgentClient,
    onPairingApplied: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var showPasteFields by remember { mutableStateOf(false) }
    var setupInput by remember { mutableStateOf("") }
    var tokenInput by remember { mutableStateOf("") }
    var inputError by remember { mutableStateOf<String?>(null) }
    var connectionReport by remember { mutableStateOf<ConnectionTestReport?>(null) }
    var connectionTesting by remember { mutableStateOf(false) }
    var cameraSettingsRequired by remember { mutableStateOf(false) }

    fun applySetup(setup: SetupDeepLink) {
        applySetupDeepLink(prefs, setup)
        inputError = null
        setupInput = ""
        tokenInput = ""
        showPasteFields = false
        connectionReport = null
        cameraSettingsRequired = false
        onPairingApplied()
    }

    val scanLauncher = rememberSetupQrScanner { content ->
        val raw = content?.trim().orEmpty()
        if (raw.isBlank()) return@rememberSetupQrScanner
        val setup = parsePairingSetupInput(raw)
        if (setup != null) {
            applySetup(setup)
        } else if (raw.startsWith("http://", ignoreCase = true) || raw.startsWith("https://", ignoreCase = true)) {
            setupInput = raw
            showPasteFields = true
            inputError = "Enter the setup token, then apply the link."
        } else {
            inputError = "That QR code is not a Pi Speak setup link."
        }
    }
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            cameraSettingsRequired = false
            scanLauncher.launch(setupScanOptions())
        } else {
            val activity = context as? Activity
            cameraSettingsRequired = activity == null ||
                !ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.CAMERA)
            inputError = if (cameraSettingsRequired) {
                "Camera access is blocked. Open app settings to allow QR scanning."
            } else {
                "Camera permission is required to scan the setup QR."
            }
        }
    }

    val title = when (connectionReason) {
        ConnectionReason.PairingRequired -> "Pairing required"
        else -> "Token rejected"
    }
    val fallbackDetail = when (connectionReason) {
        ConnectionReason.PairingRequired -> "Pair this phone with the gateway before sending another turn."
        else -> "The gateway rejected the saved token. Apply a fresh setup link to reconnect."
    }

    Dialog(
        onDismissRequest = {},
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false
        )
    ) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(Ink.copy(alpha = 0.56f))
                .padding(20.dp),
            contentAlignment = Alignment.Center
        ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = 560.dp),
            color = SurfacePaper,
            shape = RoundedCornerShape(24.dp),
            border = BorderStroke(1.dp, Line)
        ) {
            Column(
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .imePadding()
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    text = title,
                    color = Ink,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = detail.ifBlank { fallbackDetail },
                    color = InkMuted,
                    fontSize = 14.sp,
                    lineHeight = 20.sp
                )

                Button(
                    onClick = {
                        inputError = null
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            cameraSettingsRequired = false
                            scanLauncher.launch(setupScanOptions())
                        } else {
                            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = SurfacePaper),
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Text("Scan setup QR", fontWeight = FontWeight.SemiBold)
                }

                OutlinedButton(
                    onClick = {
                        showPasteFields = !showPasteFields
                        inputError = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, Line)
                ) {
                    Text("Paste setup link", color = Ink, fontWeight = FontWeight.SemiBold)
                }

                if (showPasteFields) {
                    OutlinedTextField(
                        value = setupInput,
                        onValueChange = { setupInput = it; inputError = null },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Setup link or gateway URL") },
                        singleLine = true
                    )
                    OutlinedTextField(
                        value = tokenInput,
                        onValueChange = { tokenInput = it; inputError = null },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Token for http(s) URL") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation()
                    )
                    Button(
                        onClick = {
                            val setup = parsePairingSetupInput(setupInput, tokenInput)
                            if (setup == null) {
                                inputError = "Paste a pi-speak setup link, or enter an http(s) URL and token."
                            } else {
                                applySetup(setup)
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = Success, contentColor = SurfacePaper),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Text("Apply", fontWeight = FontWeight.SemiBold)
                    }
                }

                OutlinedButton(
                    onClick = {
                        scope.launch {
                            connectionTesting = true
                            connectionReport = try {
                                client.testConnection()
                            } finally {
                                connectionTesting = false
                            }
                        }
                    },
                    enabled = !connectionTesting,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, Line)
                ) {
                    Text(
                        if (connectionTesting) "Testing connection" else "Run connection test",
                        color = if (connectionTesting) InkMuted else Ink,
                        fontWeight = FontWeight.SemiBold
                    )
                }

                inputError?.let { message ->
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        color = SurfaceSubtle,
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(1.dp, Error)
                    ) {
                        Text(message, color = Error, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
                    }
                }

                if (cameraSettingsRequired) {
                    OutlinedButton(
                        onClick = {
                            val intent = Intent(
                                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:${context.packageName}")
                            )
                            context.startActivity(intent)
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(14.dp),
                        border = BorderStroke(1.dp, Line)
                    ) {
                        Text("Open app settings", color = Ink, fontWeight = FontWeight.SemiBold)
                    }
                }

                connectionReport?.let { report ->
                    ConnectionTestReportRows(report)
                }
            }
        }
    }
    }
}

@Composable
private fun ConnectionTestReportRows(report: ConnectionTestReport) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = SurfaceSubtle,
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, if (report.ok) Success else Line)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = report.summary,
                color = if (report.ok) Success else Error,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold
            )
            if (report.checks.isNotEmpty()) Spacer(modifier = Modifier.height(8.dp))
            report.checks.forEach { check ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.Top
                ) {
                    Box(
                        modifier = Modifier
                            .padding(top = 4.dp)
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(
                                when (check.status) {
                                    "ok" -> Success
                                    "warn" -> Warn
                                    else -> Error
                                }
                            )
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text("${check.label} — ${check.status}", color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        Text(check.detail, color = InkMuted, fontSize = 10.sp, lineHeight = 14.sp)
                    }
                }
            }
        }
    }
}
