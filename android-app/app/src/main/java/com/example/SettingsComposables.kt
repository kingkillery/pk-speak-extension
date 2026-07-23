package com.example

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.api.VoiceAgentClient
import com.example.api.WorkspaceEntry
import com.example.api.WorkspaceFilePreview
import com.example.data.AppPreferences
import com.example.ui.theme.Accent
import com.example.ui.theme.AccentSoft
import com.example.ui.theme.Canvas
import com.example.ui.theme.Error
import com.example.ui.theme.Ink
import com.example.ui.theme.InkMuted
import com.example.ui.theme.Line
import com.example.ui.theme.SelectedFill
import com.example.ui.theme.Success
import com.example.ui.theme.SurfaceMuted
import com.example.ui.theme.SurfacePaper
import com.example.ui.theme.SurfaceSubtle
import com.example.ui.theme.Warn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsTabContent(
    prefs: AppPreferences,
    onConfigChanged: () -> Unit
) {
    var agentType by remember(prefs.activeAgent) { mutableStateOf(prefs.activeAgent) }
    var codexSessionName by remember(prefs.codexSessionName) { mutableStateOf(prefs.codexSessionName) }
    var machineProfileName by remember(prefs.machineProfileName) { mutableStateOf(prefs.machineProfileName) }
    var elevenLabsApiKey by remember(prefs.elevenLabsApiKey) { mutableStateOf(prefs.elevenLabsApiKey) }
    var elevenLabsVoiceId by remember(prefs.elevenLabsVoiceId) { mutableStateOf(prefs.elevenLabsVoiceId) }
    var transmissionMode by remember(prefs.transmissionMode) { mutableStateOf(prefs.transmissionMode) }
    var targetIpAddress by remember(prefs.targetIpAddress) { mutableStateOf(prefs.targetIpAddress) }
    var remoteToken by remember(prefs.remoteToken) { mutableStateOf(prefs.remoteToken) }
    var connectionMode by remember(prefs.connectionMode) { mutableStateOf(prefs.connectionMode) }
    var agentModel by remember(prefs.agentModel) { mutableStateOf(prefs.agentModel) }
    var showTurnProgress by remember(prefs.showTurnProgress) { mutableStateOf(prefs.showTurnProgress) }
    var speakTurnProgress by remember(prefs.speakTurnProgress) { mutableStateOf(prefs.speakTurnProgress) }
    var workspaceRoot by remember(prefs.workspaceRoot) { mutableStateOf(prefs.workspaceRoot) }
    var workspacePath by remember(prefs.workspacePath) { mutableStateOf(prefs.workspacePath) }
    var workspaceEntries by remember { mutableStateOf<List<WorkspaceEntry>>(emptyList()) }
    var workspaceTruncated by remember { mutableStateOf(false) }
    var workspaceParent by remember { mutableStateOf<String?>(null) }
    var workspaceLoading by remember { mutableStateOf(false) }
    var filePreview by remember { mutableStateOf<WorkspaceFilePreview?>(null) }
    var filePreviewLoading by remember { mutableStateOf(false) }
    var connectionTesting by remember { mutableStateOf(false) }
    var connectionReport by remember { mutableStateOf<com.example.api.ConnectionTestReport?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // Provider picker is intentionally exactly these four; voice/TTS backends are
    // configured elsewhere, and legacy prefs values (ElevenLabs/Gemini) still work.
    val agents = listOf("Gateway OMPK (oh-my-pk)", "Gateway Claude (Claude Code)", "Local Codex (Pi)", "Gateway Hermes")
    val workspacePresets = listOf(
        "C:/Dev" to AppPreferences.DEFAULT_WORKSPACE_PATH
    )
    val modelPresets = listOf(
        "Gemini 3.1 Live" to "gemini-3.1-flash-live-preview",
        "Gemini 3.5 Flash" to "gemini-3.5-flash",
        "9Router Gemini 3.5 Flash High" to "9router/ag/gemini-3-5-flash-high",
        "Server default" to "",
        "Legacy 2.5 Live" to "gemini-live-2.5-flash-native-audio"
    )

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 12.dp)
    ) {
        item {
            Text(
                text = "Voice engine control matrix",
                color = InkMuted,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
        }

        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(
                    1.dp,
                    when {
                        connectionReport?.ok == true -> Success
                        connectionReport != null -> Accent
                        else -> Line
                    }
                )
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Connection test",
                                color = Ink,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(3.dp))
                            Text(
                                text = connectionReport?.summary ?: "Check gateway reachability, setup token, workspace, and capabilities.",
                                color = when {
                                    connectionReport?.ok == true -> Success
                                    connectionReport != null -> Error
                                    else -> InkMuted
                                },
                                fontSize = 11.sp,
                                lineHeight = 15.sp
                            )
                        }
                        Button(
                            onClick = {
                                scope.launch {
                                    connectionTesting = true
                                    connectionReport = VoiceAgentClient(context, prefs).testConnection()
                                    connectionTesting = false
                                }
                            },
                            enabled = !connectionTesting,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Accent,
                                contentColor = SurfacePaper
                            ),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text(if (connectionTesting) "Testing" else "Test", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }

                    val report = connectionReport
                    if (report != null) {
                        Spacer(modifier = Modifier.height(12.dp))
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
                                                else -> Accent
                                            }
                                        )
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = check.label,
                                        color = Ink,
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Text(
                                        text = check.detail,
                                        color = InkMuted,
                                        fontSize = 10.sp,
                                        lineHeight = 14.sp
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // Active Voice Agent Matrix Config
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Active voice agent",
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    agents.forEach { agent ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(40.dp)
                                .clickable {
                                    agentType = agent
                                    prefs.activeAgent = agent
                                    onConfigChanged()
                                }
                        ) {
                            RadioButton(
                                selected = (agentType == agent),
                                onClick = {
                                    agentType = agent
                                    prefs.activeAgent = agent
                                    onConfigChanged()
                                },
                                colors = RadioButtonDefaults.colors(
                                    selectedColor = Accent,
                                    unselectedColor = InkMuted
                                )
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = agent, color = Ink, fontSize = 14.sp)
                        }
                    }
                }
            }
        }

        // Tactical Trigger Setup
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Microphone action strategy",
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        listOf("PTT" to "Hold to talk", "TOGGLE" to "Tap to toggle mic").forEach { (mode, label) ->
                            val isSelected = transmissionMode == mode
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(horizontal = 4.dp)
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(if (isSelected) SelectedFill else SurfaceSubtle)
                                    .clickable {
                                        transmissionMode = mode
                                        prefs.transmissionMode = mode
                                        onConfigChanged()
                                    }
                                    .heightIn(min = 44.dp)
                                    .padding(vertical = 10.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = label,
                                    color = if (isSelected) Accent else InkMuted,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Checkbox(
                            checked = showTurnProgress,
                            onCheckedChange = {
                                showTurnProgress = it
                                prefs.showTurnProgress = it
                                onConfigChanged()
                            }
                        )
                        Text(text = "Show turn progress text", color = Ink, fontSize = 13.sp)
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Checkbox(
                            checked = speakTurnProgress,
                            onCheckedChange = {
                                speakTurnProgress = it
                                prefs.speakTurnProgress = it
                                onConfigChanged()
                            }
                        )
                        Text(text = "Speak periodic progress updates", color = Ink, fontSize = 13.sp)
                    }
                }
            }
        }

        // Connection IP & Codex Session Targets Configuration
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Remote Codex matrix profile",
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // Machine profile label
                    Text(text = "Machine profile name", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = machineProfileName,
                        onValueChange = {
                            machineProfileName = it
                            prefs.machineProfileName = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Session tag
                    Text(text = "Target session name", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = codexSessionName,
                        onValueChange = {
                            codexSessionName = it
                            prefs.codexSessionName = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Text(text = "Agent model", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = agentModel,
                        onValueChange = {
                            agentModel = it
                            prefs.agentModel = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("Server default", color = InkMuted) },
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(text = "Model presets", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        modelPresets.forEach { (label, model) ->
                            val selected = if (model.isBlank()) agentModel.isBlank() else agentModel.equals(model, ignoreCase = true)
                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(12.dp))
                                    .clickable {
                                        agentModel = model
                                        prefs.agentModel = model
                                        onConfigChanged()
                                    },
                                color = if (selected) SelectedFill else SurfaceSubtle,
                                shape = RoundedCornerShape(12.dp),
                                border = BorderStroke(1.dp, if (selected) Accent else Line)
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(
                                        selected = selected,
                                        onClick = {
                                            agentModel = model
                                            prefs.agentModel = model
                                            onConfigChanged()
                                        },
                                        colors = RadioButtonDefaults.colors(
                                            selectedColor = Accent,
                                            unselectedColor = InkMuted
                                        )
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(label, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                        Text(if (model.isBlank()) "Gateway default" else model, color = InkMuted, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Gateway IP Address
                    Text(text = "Local Gateway URL host", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = targetIpAddress,
                        onValueChange = {
                            targetIpAddress = it
                            prefs.targetIpAddress = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Text(text = "Workspace folder", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = workspacePath,
                        onValueChange = {
                            workspacePath = it
                            prefs.workspacePath = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(workspaceRoot, color = InkMuted) }
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(text = "Workspace presets", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        workspacePresets.forEach { (label, path) ->
                            val selected = workspacePath.equals(path, ignoreCase = true)
                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(12.dp))
                                    .clickable {
                                        workspaceRoot = path
                                        workspacePath = path
                                        prefs.workspaceRoot = path
                                        prefs.workspacePath = path
                                        onConfigChanged()
                                    },
                                color = if (selected) SelectedFill else SurfaceSubtle,
                                shape = RoundedCornerShape(12.dp),
                                border = BorderStroke(1.dp, if (selected) Accent else Line)
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    RadioButton(
                                        selected = selected,
                                        onClick = {
                                            workspaceRoot = path
                                            workspacePath = path
                                            prefs.workspaceRoot = path
                                            prefs.workspacePath = path
                                            onConfigChanged()
                                        },
                                        colors = RadioButtonDefaults.colors(
                                            selectedColor = Accent,
                                            unselectedColor = InkMuted
                                        )
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(label, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                        Text(path, color = InkMuted, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        TextButton(
                            onClick = {
                                scope.launch {
                                    workspaceLoading = true
                                    val listing = withContext(kotlinx.coroutines.Dispatchers.IO) {
                                        VoiceAgentClient(context, prefs).listWorkspace(workspaceRoot)
                                    }
                                    if (listing != null) {
                                        workspaceRoot = listing.root
                                        workspacePath = listing.current
                                        workspaceParent = listing.parent
                                        workspaceEntries = listing.entries
                                        workspaceTruncated = listing.truncated
                                        prefs.workspaceRoot = listing.root
                                        prefs.workspacePath = listing.current
                                        onConfigChanged()
                                    }
                                    workspaceLoading = false
                                }
                            }
                        ) { Text("Browse root") }
                        TextButton(
                            enabled = workspaceParent != null,
                            onClick = {
                                val parent = workspaceParent ?: return@TextButton
                                scope.launch {
                                    workspaceLoading = true
                                    val listing = withContext(kotlinx.coroutines.Dispatchers.IO) {
                                        VoiceAgentClient(context, prefs).listWorkspace(parent)
                                    }
                                    if (listing != null) {
                                        workspacePath = listing.current
                                        workspaceParent = listing.parent
                                        workspaceEntries = listing.entries
                                        workspaceTruncated = listing.truncated
                                        prefs.workspacePath = listing.current
                                        onConfigChanged()
                                    }
                                    workspaceLoading = false
                                }
                            }
                        ) { Text("Up") }
                    }
                    if (workspaceLoading) {
                        Text(text = "Loading folders...", color = InkMuted, fontSize = 11.sp)
                    }
                    if (filePreviewLoading) {
                        Text(text = "Loading file preview...", color = InkMuted, fontSize = 11.sp)
                    }
                    if (workspaceTruncated || workspaceEntries.size > 24) {
                        Text(
                            text = if (workspaceTruncated) "Showing first 24 entries from a capped folder. Open a narrower folder to see the rest." else "Showing first 24 entries.",
                            color = InkMuted,
                            fontSize = 11.sp
                        )
                    }
                    workspaceEntries.take(24).forEach { entry ->
                        if (entry.isFile) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        if (!filePreviewLoading) {
                                            scope.launch {
                                                filePreviewLoading = true
                                                filePreview = VoiceAgentClient(context, prefs).readWorkspaceFile(entry.path)
                                                filePreviewLoading = false
                                            }
                                        }
                                    }
                                    .padding(vertical = 6.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = entry.name,
                                    color = Ink,
                                    fontSize = 12.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                Text(
                                    text = formatWorkspaceFileSize(entry.size),
                                    color = InkMuted,
                                    fontSize = 10.sp
                                )
                            }
                        } else {
                            Text(
                                text = "${entry.name}/",
                                color = Accent,
                                fontSize = 12.sp,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        scope.launch {
                                            workspaceLoading = true
                                            val listing = withContext(kotlinx.coroutines.Dispatchers.IO) {
                                                VoiceAgentClient(context, prefs).listWorkspace(entry.path)
                                            }
                                            if (listing != null) {
                                                workspacePath = listing.current
                                                workspaceParent = listing.parent
                                                workspaceEntries = listing.entries
                                                workspaceTruncated = listing.truncated
                                                prefs.workspacePath = listing.current
                                                onConfigChanged()
                                            }
                                            workspaceLoading = false
                                        }
                                    }
                                    .padding(vertical = 6.dp)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Gateway Auth Token
                    Text(text = "Gateway authentication token", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = remoteToken,
                        onValueChange = {
                            remoteToken = it
                            prefs.remoteToken = it
                            onConfigChanged()
                        },
                        visualTransformation = PasswordVisualTransformation(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Default Gateway Network Interface
                    Text(text = "Default gateway network interface", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        listOf("Tailscale" to "Tailscale", "Bluetooth" to "Bluetooth", "Manual" to "Manual").forEach { (mode, label) ->
                            val isSelected = connectionMode == mode
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(horizontal = 4.dp)
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(if (isSelected) SelectedFill else SurfaceSubtle)
                                    .clickable {
                                        connectionMode = mode
                                        prefs.connectionMode = mode
                                        onConfigChanged()
                                    }
                                    .heightIn(min = 44.dp)
                                    .padding(vertical = 10.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = label,
                                    color = if (isSelected) Accent else InkMuted,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }
                }
            }
        }

        // Hardware Audio & VAD Settings
        item {
            val aecVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getBoolean("aec_enabled", true)) }
            val nsVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getBoolean("ns_enabled", true)) }
            val vadVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getBoolean("vad_enabled", true)) }
            val thresholdVal = remember { mutableStateOf(context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE).getFloat("vad_threshold", 1500f)) }

            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Hardware audio & VAD strategy",
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Switch(
                            checked = aecVal.value,
                            onCheckedChange = {
                                aecVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putBoolean("aec_enabled", it).apply()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Accent,
                                checkedTrackColor = SurfaceMuted
                            )
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Column {
                            Text(text = "Acoustic Echo Cancellation (AEC)", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(text = "Prevents speaker audio from leaking back into the mic", color = InkMuted, fontSize = 11.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Switch(
                            checked = nsVal.value,
                            onCheckedChange = {
                                nsVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putBoolean("ns_enabled", it).apply()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Accent,
                                checkedTrackColor = SurfaceMuted
                            )
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Column {
                            Text(text = "Noise Suppression (NS)", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(text = "Reduces ambient background noise", color = InkMuted, fontSize = 11.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(16.dp))
                    Spacer(modifier = Modifier.height(1.dp).fillMaxWidth().background(Line))
                    Spacer(modifier = Modifier.height(16.dp))

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Switch(
                            checked = vadVal.value,
                            onCheckedChange = {
                                vadVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putBoolean("vad_enabled", it).apply()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Accent,
                                checkedTrackColor = SurfaceMuted
                            )
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Column {
                            Text(text = "Voice Activity Detection (VAD) Barge-in", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(text = "Interrupts assistant speech when you start speaking", color = InkMuted, fontSize = 11.sp)
                        }
                    }

                    if (vadVal.value) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(text = "VAD Threshold: ${thresholdVal.value.toInt()}", color = InkMuted, fontSize = 11.sp)
                        Slider(
                            value = thresholdVal.value,
                            onValueChange = {
                                thresholdVal.value = it
                                context.getSharedPreferences("pi_speak_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putFloat("vad_threshold", it).apply()
                            },
                            valueRange = 0f..5000f,
                            colors = SliderDefaults.colors(
                                thumbColor = Accent,
                                activeTrackColor = Accent,
                                inactiveTrackColor = Line
                            )
                        )
                    }
                }
            }
        }

        // ElevenLabs API Security and voice synthesis wiring fields (Requested)
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "ElevenLabs API wiring hub",
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // api key input fields (Must be masked unless requested)
                    Text(text = "ElevenLabs API key", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = elevenLabsApiKey,
                        onValueChange = {
                            elevenLabsApiKey = it
                            prefs.elevenLabsApiKey = it
                            onConfigChanged()
                        },
                        visualTransformation = PasswordVisualTransformation(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("Unset / local built-in only", color = InkMuted) }
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // voice id selector input
                    Text(text = "ElevenLabs custom voice ID", color = InkMuted, fontSize = 11.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    OutlinedTextField(
                        value = elevenLabsVoiceId,
                        onValueChange = {
                            elevenLabsVoiceId = it
                            prefs.elevenLabsVoiceId = it
                            onConfigChanged()
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Accent,
                            unfocusedBorderColor = Line,
                            focusedTextColor = Ink,
                            unfocusedTextColor = Ink
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        // Tactical Voice Synthesis Feedback Control
        item {
            var autoSpeak by remember(prefs.autoSpeakEnabled) { mutableStateOf(prefs.autoSpeakEnabled) }
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = SurfacePaper,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, Line)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "System voice feedback loop",
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Auto-speak audio replies",
                                color = Ink,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Spacer(modifier = Modifier.height(2.dp))
                            Text(
                                text = "Instantly synthesize incoming responses out loud via phone speakers or active synthesizer node.",
                                color = InkMuted,
                                fontSize = 11.sp
                            )
                        }
                        Switch(
                            checked = autoSpeak,
                            onCheckedChange = {
                                autoSpeak = it
                                prefs.autoSpeakEnabled = it
                                onConfigChanged()
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Accent,
                                checkedTrackColor = Accent,
                                uncheckedThumbColor = InkMuted,
                                uncheckedTrackColor = SurfaceMuted
                            )
                        )
                    }
                }
            }
        }
    }

    filePreview?.let { preview ->
        WorkspaceFileViewerDialog(preview = preview, onDismiss = { filePreview = null })
    }
}

private fun formatWorkspaceFileSize(size: Long?): String = when {
    size == null -> ""
    size >= 1_048_576L -> "%.1f MB".format(size / 1_048_576.0)
    size >= 1_024L -> "%.1f KB".format(size / 1_024.0)
    else -> "$size B"
}

@Composable
private fun WorkspaceFileViewerDialog(
    preview: WorkspaceFilePreview,
    onDismiss: () -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.85f),
            color = SurfacePaper,
            shape = RoundedCornerShape(16.dp),
            border = BorderStroke(1.dp, Line)
        ) {
            Column(modifier = Modifier.padding(14.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.Top,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = preview.name.ifBlank { preview.path.substringAfterLast('/').substringAfterLast('\\') }.ifBlank { "File" },
                            color = Ink,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Text(
                            text = listOfNotNull(
                                preview.path.takeIf { it.isNotBlank() },
                                formatWorkspaceFileSize(preview.size.takeIf { it > 0L }).takeIf { it.isNotBlank() }
                            ).joinToString(" · "),
                            color = InkMuted,
                            fontSize = 10.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    TextButton(onClick = onDismiss) {
                        Text("Close", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
                when {
                    preview.error != null -> {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(preview.error, color = Error, fontSize = 12.sp)
                    }
                    preview.binary -> {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Binary file — no preview available.", color = InkMuted, fontSize = 12.sp)
                    }
                    else -> {
                        if (preview.truncated) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("Preview shows the first 512 KB of this file.", color = Warn, fontSize = 10.sp)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .border(1.dp, Line, RoundedCornerShape(8.dp))
                                .background(SurfaceSubtle, RoundedCornerShape(8.dp))
                                .padding(10.dp)
                        ) {
                            Text(
                                text = preview.content ?: "",
                                color = Ink,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace
                            )
                        }
                    }
                }
            }
        }
    }
}
