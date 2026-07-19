package com.example

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.api.HubAgent
import com.example.api.HubSnapshot
import com.example.api.VoiceAgentClient
import com.example.data.AppPreferences
import com.example.ui.theme.Accent
import com.example.ui.theme.Error
import com.example.ui.theme.Ink
import com.example.ui.theme.InkMuted
import com.example.ui.theme.Line
import com.example.ui.theme.SelectedFill
import com.example.ui.theme.SurfacePaper
import com.example.ui.theme.SurfaceSubtle
import kotlinx.coroutines.launch

/**
 * The Agent Hub "portal": a live lane -> subagent tree (from /v1/herdr/agent*) with per-agent
 * chat + archive controls, a live transcript stream, and a general task launcher. This is the
 * newer, hierarchical sibling of GatewaySessionsPane's flat oh-my-pk lane list above -- both read
 * the same underlying oh-my-pk background lanes, but this one exposes subagents and lets you
 * act on a lane instead of only viewing it.
 *
 * Revive is deliberately NOT offered here: an archived lane is invisible to this same scan
 * (that's what "archived" means to the underlying dashboard), so there is no reachable state in
 * this tree from which reviving would find anything. It stays available as a client method for
 * whichever surface ends up tracking archived-lane names persistently.
 */
sealed class HubPortalUiState {
    data object Idle : HubPortalUiState()
    data object Loading : HubPortalUiState()
    data class Loaded(val snapshot: HubSnapshot) : HubPortalUiState()
    data object Empty : HubPortalUiState()
    data class Error(val message: String) : HubPortalUiState()
}

data class HubTreeGroup(val folderKey: String, val folderName: String, val nodes: List<HubAgent>)

/** Groups agents by folder, ordering each lane immediately followed by its own subagents. */
fun buildHubTree(agents: List<HubAgent>): List<HubTreeGroup> {
    val lanes = agents.filter { it.kind != "sub" }
    val byFolder = lanes.groupBy { it.folderKey }
    return byFolder.entries.sortedBy { it.key }.map { (folderKey, folderLanes) ->
        val nodes = mutableListOf<HubAgent>()
        for (lane in folderLanes.sortedByDescending { it.lastActivityMs }) {
            nodes.add(lane)
            nodes.addAll(agents.filter { it.parentId == lane.id }.sortedBy { it.displayName })
        }
        val name = folderKey.trim().trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
        HubTreeGroup(folderKey = folderKey, folderName = name.ifBlank { "(unknown folder)" }, nodes = nodes)
    }
}

@Composable
fun HubPortalPane(
    client: VoiceAgentClient,
    prefs: AppPreferences,
    modifier: Modifier = Modifier
) {
    var state by remember { mutableStateOf<HubPortalUiState>(HubPortalUiState.Idle) }
    var selectedAgentId by remember { mutableStateOf<String?>(null) }
    var showLauncher by remember { mutableStateOf(false) }
    var statusText by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    fun refresh() {
        state = HubPortalUiState.Loading
        scope.launch {
            val snapshot = client.getHubSnapshot()
            state = when {
                snapshot == null -> HubPortalUiState.Error("This gateway does not expose the Agent Hub API.")
                snapshot.agents.isEmpty() -> HubPortalUiState.Empty
                else -> HubPortalUiState.Loaded(snapshot)
            }
        }
    }

    LaunchedEffect(prefs.targetIpAddress, prefs.remoteToken) { refresh() }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Agent Hub", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            OutlinedButton(
                onClick = { showLauncher = true },
                border = BorderStroke(1.dp, Accent),
                shape = RoundedCornerShape(12.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                modifier = Modifier.heightIn(min = 40.dp)
            ) {
                Text("+ Launch task", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(modifier = Modifier.width(8.dp))
            TextButton(onClick = { refresh() }, modifier = Modifier.heightIn(min = 40.dp)) {
                Text("Refresh", color = InkMuted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        if (statusText.isNotBlank()) {
            Text(
                text = statusText,
                color = Ink,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }

        when (val current = state) {
            HubPortalUiState.Idle, HubPortalUiState.Loading -> HubPortalStatus("Loading agent hub...")
            HubPortalUiState.Empty -> HubPortalStatus("No active background lanes. Launch a task to get started.")
            is HubPortalUiState.Error -> HubPortalStatus(current.message)
            is HubPortalUiState.Loaded -> {
                val groups = buildHubTree(current.snapshot.agents)
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 12.dp)
                ) {
                    groups.forEach { group ->
                        item(key = "folder:${group.folderKey}") {
                            Text(
                                text = group.folderName,
                                color = InkMuted,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)
                            )
                        }
                        items(group.nodes, key = { it.id }) { agent ->
                            val expanded = selectedAgentId == agent.id
                            HubAgentRow(
                                agent = agent,
                                expanded = expanded,
                                onToggle = { selectedAgentId = if (expanded) null else agent.id }
                            )
                            if (expanded) {
                                HubAgentDetailPanel(
                                    client = client,
                                    agentId = agent.id,
                                    agentSummary = agent,
                                    onStatus = { statusText = it },
                                    onMutated = { refresh() }
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showLauncher) {
        LaunchTaskDialog(
            client = client,
            prefs = prefs,
            onDismiss = { showLauncher = false },
            onLaunched = { message ->
                statusText = message
                showLauncher = false
                refresh()
            }
        )
    }
}

@Composable
fun HubPortalStatus(message: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = message,
            color = InkMuted,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(24.dp)
        )
    }
}

@Composable
fun HubAgentRow(agent: HubAgent, expanded: Boolean, onToggle: () -> Unit) {
    val indent = if (agent.kind == "sub") 20.dp else 0.dp
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = indent, top = 2.dp, bottom = 2.dp)
            .clickable(onClick = onToggle)
            .border(1.dp, if (expanded) Accent else Line, RoundedCornerShape(12.dp))
            .background(if (expanded) SelectedFill else SurfacePaper, RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = if (agent.kind == "sub") "└ ${agent.displayName}" else agent.displayName,
                    color = Ink,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (agent.needsAttention) {
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("!", color = Error, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                }
            }
            val subtitle = listOfNotNull(agent.model, agent.cwd).joinToString(" · ")
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    color = InkMuted,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = agent.status,
            color = if (agent.needsAttention) Error else InkMuted,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold
        )
    }
}

@Composable
fun HubAgentDetailPanel(
    client: VoiceAgentClient,
    agentId: String,
    agentSummary: HubAgent,
    onStatus: (String) -> Unit,
    onMutated: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var transcriptLines by remember(agentId) { mutableStateOf<List<String>>(emptyList()) }
    var chatText by remember(agentId) { mutableStateOf("") }
    var sending by remember(agentId) { mutableStateOf(false) }
    var pendingKillToken by remember(agentId) { mutableStateOf<String?>(null) }
    var killing by remember(agentId) { mutableStateOf(false) }
    var streamConnected by remember(agentId) { mutableStateOf(false) }
    var streamStatusText by remember(agentId) { mutableStateOf("Connecting…") }
    val canAct = agentSummary.kind != "sub"

    DisposableEffect(agentId) {
        // openHubAgentStream's callbacks fire from its background reader thread, so every
        // Compose state write below must be marshalled back to the main thread first.
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        // fromByte defaults to 0, so the first "append" frame delivers the full backlog --
        // no separate transcript-tail fetch needed before this stream connects.
        val stream = client.openHubAgentStream(
            id = agentId,
            onAppend = { _, _, text ->
                if (text.isNotBlank()) {
                    val newLines = text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
                    if (newLines.isNotEmpty()) {
                        handler.post { transcriptLines = (transcriptLines + newLines).takeLast(300) }
                    }
                }
            },
            onStatus = { _, _ -> },
            onStateChange = { connected, detail ->
                handler.post {
                    streamConnected = connected
                    streamStatusText = detail
                }
            }
        )
        onDispose { stream.stop() }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, top = 4.dp, bottom = 8.dp)
            .border(1.dp, Line, RoundedCornerShape(12.dp))
            .background(SurfaceSubtle, RoundedCornerShape(12.dp))
            .padding(12.dp)
    ) {
        Text(
            text = if (streamConnected) "Live · $streamStatusText" else streamStatusText,
            color = InkMuted,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold
        )
        Spacer(modifier = Modifier.height(6.dp))

        val listState = rememberLazyListState()
        LaunchedEffect(transcriptLines.size) {
            if (transcriptLines.isNotEmpty()) listState.animateScrollToItem(transcriptLines.size - 1)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 220.dp)
                .border(1.dp, Line, RoundedCornerShape(8.dp))
                .background(SurfacePaper, RoundedCornerShape(8.dp))
                .padding(8.dp)
        ) {
            LazyColumn(state = listState) {
                if (transcriptLines.isEmpty()) {
                    item {
                        Text("No transcript yet.", color = InkMuted, fontSize = 11.sp)
                    }
                }
                items(transcriptLines) { line ->
                    Text(
                        text = line,
                        color = Ink,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(8.dp))

        if (canAct) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = chatText,
                    onValueChange = { chatText = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Send a message to this lane…", fontSize = 12.sp, color = InkMuted) },
                    enabled = !sending,
                    singleLine = true,
                    textStyle = LocalTextStyle.current.copy(fontSize = 12.sp, color = Ink),
                    shape = RoundedCornerShape(12.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Accent,
                        unfocusedBorderColor = Line,
                        cursorColor = Accent,
                        focusedTextColor = Ink,
                        unfocusedTextColor = Ink
                    )
                )
                Spacer(modifier = Modifier.width(8.dp))
                Button(
                    onClick = {
                        val text = chatText.trim()
                        if (text.isNotEmpty() && !sending) {
                            sending = true
                            scope.launch {
                                val result = client.sendHubAgentChat(agentId, text)
                                sending = false
                                if (result.ok) {
                                    chatText = ""
                                } else {
                                    onStatus(result.error ?: "Message failed.")
                                }
                            }
                        }
                    },
                    enabled = !sending && chatText.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = SurfacePaper),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.heightIn(min = 44.dp)
                ) {
                    Text(if (sending) "…" else "Send", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedButton(
                onClick = {
                    if (killing) return@OutlinedButton
                    killing = true
                    scope.launch {
                        val outcome = client.killHubAgent(agentId, pendingKillToken)
                        killing = false
                        when {
                            outcome.ok -> {
                                pendingKillToken = null
                                onStatus("Archived ${agentSummary.displayName}.")
                                onMutated()
                            }
                            outcome.code == "confirm_required" -> {
                                pendingKillToken = outcome.confirmToken
                                onStatus("Tap Archive again to confirm.")
                            }
                            else -> {
                                pendingKillToken = null
                                onStatus(outcome.error ?: "Archive failed.")
                            }
                        }
                    }
                },
                enabled = !killing,
                border = BorderStroke(1.dp, if (pendingKillToken != null) Error else Line),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.heightIn(min = 44.dp)
            ) {
                Text(
                    text = if (pendingKillToken != null) "Confirm archive" else "Archive",
                    color = if (pendingKillToken != null) Error else Ink,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        } else {
            Text(
                text = "Subagents are read-only in this version. Open the parent lane to chat.",
                color = InkMuted,
                fontSize = 11.sp
            )
        }
    }
}

@Composable
fun LaunchTaskDialog(
    client: VoiceAgentClient,
    prefs: AppPreferences,
    onDismiss: () -> Unit,
    onLaunched: (String) -> Unit
) {
    var cwd by remember { mutableStateOf(prefs.workspacePath) }
    var prompt by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var provider by remember { mutableStateOf("") }
    var launching by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = Accent,
        unfocusedBorderColor = Line,
        cursorColor = Accent,
        focusedTextColor = Ink,
        unfocusedTextColor = Ink
    )

    AlertDialog(
        onDismissRequest = { if (!launching) onDismiss() },
        title = { Text("Launch task", color = Ink, fontWeight = FontWeight.Bold) },
        text = {
            Column {
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    label = { Text("Working directory", fontSize = 12.sp) },
                    singleLine = true,
                    enabled = !launching,
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors
                )
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = { Text("Prompt", fontSize = 12.sp) },
                    enabled = !launching,
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row {
                    OutlinedTextField(
                        value = model,
                        onValueChange = { model = it },
                        label = { Text("Model (optional)", fontSize = 11.sp) },
                        singleLine = true,
                        enabled = !launching,
                        modifier = Modifier.weight(1f),
                        colors = fieldColors
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    OutlinedTextField(
                        value = provider,
                        onValueChange = { provider = it },
                        label = { Text("Provider (optional)", fontSize = 11.sp) },
                        singleLine = true,
                        enabled = !launching,
                        modifier = Modifier.weight(1f),
                        colors = fieldColors
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (!launching) {
                        launching = true
                        scope.launch {
                            val message = client.launchSession(
                                cwd = cwd.trim().ifBlank { null },
                                prompt = prompt.trim().ifBlank { null },
                                model = model.trim().ifBlank { null },
                                provider = provider.trim().ifBlank { null }
                            )
                            launching = false
                            onLaunched(message)
                        }
                    }
                },
                enabled = !launching,
                colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = SurfacePaper)
            ) {
                Text(if (launching) "Launching…" else "Launch", fontWeight = FontWeight.Bold)
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!launching) onDismiss() }) {
                Text("Cancel", color = InkMuted)
            }
        },
        containerColor = SurfacePaper
    )
}
