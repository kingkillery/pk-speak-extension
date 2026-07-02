package com.example

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.api.AgentInventory
import com.example.api.GatewayEvent
import com.example.api.GatewayRoute
import com.example.api.GatewayRouteSlot
import com.example.api.GatewayRouteUpdate
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
import com.example.api.GatewaySessionErrorKind
import com.example.api.GatewaySessionException
import com.example.api.VoiceAgentClient
import com.example.audio.AudioHelper
import com.example.audio.TtsHelper
import com.example.data.AppPreferences
import com.example.ui.theme.Accent
import com.example.ui.theme.AccentSoft
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SessionsTabContent(
    client: VoiceAgentClient,
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
    onRemoteSessionSelected: (GatewaySessionEntry, GatewaySessionDashboard) -> Unit
) {
    var selectedPane by remember { mutableStateOf("gateway") }

    Column(
        modifier = Modifier.fillMaxSize()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            SessionsPaneToggle("gateway", "Hub", selectedPane, Modifier.weight(1f)) { selectedPane = it }
            SessionsPaneToggle("ops", "Ops", selectedPane, Modifier.weight(1f)) { selectedPane = it }
            SessionsPaneToggle("history", "History", selectedPane, Modifier.weight(1f)) { selectedPane = it }
        }

        when (selectedPane) {
            "gateway" -> GatewaySessionsPane(
                client = client,
                prefs = prefs,
                onRemoteSessionSelected = onRemoteSessionSelected,
                modifier = Modifier.weight(1f)
            )
            "ops" -> GatewayOpsPane(
                client = client,
                prefs = prefs,
                modifier = Modifier.weight(1f)
            )
            else -> LocalTurnHistoryPane(
                audioHelper = audioHelper,
                ttsHelper = ttsHelper,
                prefs = prefs,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
fun SessionsPaneToggle(
    pane: String,
    label: String,
    selectedPane: String,
    modifier: Modifier = Modifier,
    onSelect: (String) -> Unit
) {
    val selected = selectedPane == pane
    OutlinedButton(
        onClick = { onSelect(pane) },
        border = BorderStroke(1.dp, if (selected) Accent else Line),
        modifier = modifier.heightIn(min = 44.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = if (selected) SelectedFill else SurfacePaper,
            contentColor = Ink
        ),
        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 8.dp)
    ) {
        Text(
            label,
            color = if (selected) Accent else Ink,
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
            maxLines = 1
        )
    }
}

@Composable
fun GatewaySessionsPane(
    client: VoiceAgentClient,
    prefs: AppPreferences,
    onRemoteSessionSelected: (GatewaySessionEntry, GatewaySessionDashboard) -> Unit,
    modifier: Modifier = Modifier
) {
    var state by remember { mutableStateOf<GatewaySessionsUiState>(GatewaySessionsUiState.Idle) }
    var filterText by remember { mutableStateOf("") }
    var pendingRemoveKey by remember { mutableStateOf<String?>(null) }
    var launchStatus by remember { mutableStateOf("") }
    var launchingHub by remember { mutableStateOf(false) }
    var launchingColab by remember { mutableStateOf(false) }
    var joiningCollab by remember { mutableStateOf(false) }
    var showAllSessions by remember { mutableStateOf(false) }
    var selectedOmpSessionPath by remember { mutableStateOf<String?>(null) }
    val expandedLanes = remember { mutableStateMapOf<String, Boolean>() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    fun refresh() {
        state = GatewaySessionsUiState.Loading
        pendingRemoveKey = null
        scope.launch {
            state = try {
                val dashboard = client.getSessionDashboard()
                if (dashboard.sessions.isEmpty()) GatewaySessionsUiState.Empty else GatewaySessionsUiState.Loaded(dashboard)
            } catch (e: GatewaySessionException) {
                when (e.kind) {
                    GatewaySessionErrorKind.Unauthorized -> GatewaySessionsUiState.Unauthorized
                    GatewaySessionErrorKind.Unsupported -> GatewaySessionsUiState.Unsupported
                    else -> GatewaySessionsUiState.Error(e.message ?: "Could not load gateway sessions.")
                }
            } catch (e: Exception) {
                GatewaySessionsUiState.Error(e.message ?: "Could not load gateway sessions.")
            }
        }
    }

    LaunchedEffect(prefs.targetIpAddress, prefs.remoteToken) {
        refresh()
        selectedOmpSessionPath = client.getSelectedOmpSession()
    }

    LaunchedEffect(pendingRemoveKey) {
        val key = pendingRemoveKey ?: return@LaunchedEffect
        delay(3_000)
        if (pendingRemoveKey == key) {
            pendingRemoveKey = null
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        GatewaySessionsHeader(
            prefs = prefs,
            state = state,
            filterText = filterText,
            onFilterTextChange = { filterText = it },
            launchingHub = launchingHub,
            launchingColab = launchingColab,
            joiningCollab = joiningCollab,
            onLaunchHub = {
                if (!launchingHub) {
                    launchingHub = true
                    launchStatus = "Launching OMPK hub..."
                    prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
                    scope.launch {
                        launchStatus = client.launchOmpHub()
                        launchingHub = false
                        refresh()
                    }
                }
            },
            onLaunchColab = {
                if (!launchingColab) {
                    launchingColab = true
                    launchStatus = "Launching Colab..."
                    scope.launch {
                        launchStatus = client.launchColabWorkspace(prefs.workspacePath)
                        launchingColab = false
                        refresh()
                    }
                }
            },
            onJoinCollab = {
                if (!joiningCollab) {
                    joiningCollab = true
                    launchStatus = "Checking collab..."
                    scope.launch {
                        val collab = client.getCollabLink()
                        if (collab.active && !collab.webLink.isNullOrBlank()) {
                            try {
                                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(collab.webLink)).apply {
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                                context.startActivity(intent)
                                launchStatus = "Opening collab in browser..."
                            } catch (e: Exception) {
                                launchStatus = "Couldn't open collab link: ${e.message}"
                            }
                        } else {
                            launchStatus = "No active collab. Run /collab in the OMPK hub on the host."
                        }
                        joiningCollab = false
                    }
                }
            },
            onRefresh = { refresh() },
            showAllSessions = showAllSessions,
            onToggleShowAll = { showAllSessions = !showAllSessions }
        )
        if (launchStatus.isNotBlank()) {
            Text(
                text = launchStatus,
                color = Ink,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 4.dp, end = 4.dp, bottom = 8.dp)
            )
        }

        when (val currentState = state) {
            GatewaySessionsUiState.Idle,
            GatewaySessionsUiState.Loading -> GatewaySessionsStatus("Loading gateway sessions...")
            GatewaySessionsUiState.Empty -> GatewaySessionsStatus("No gateway sessions found.")
            GatewaySessionsUiState.Unauthorized -> GatewaySessionsStatus("Gateway token required or invalid. Check Configure.")
            GatewaySessionsUiState.Unsupported -> GatewaySessionsStatus("This gateway does not expose the session dashboard.")
            is GatewaySessionsUiState.Error -> GatewaySessionsStatus(currentState.message)
            is GatewaySessionsUiState.Loaded -> {
                val groups = buildGatewayAgentHubGroups(
                    dashboard = currentState.dashboard,
                    currentWorkspace = prefs.workspacePath,
                    query = filterText,
                    ompOnly = !showAllSessions
                )
                if (groups.isEmpty()) {
                    GatewaySessionsStatus(
                        when {
                            filterText.isNotBlank() -> "No sessions match \"$filterText\"."
                            showAllSessions -> "No gateway sessions found."
                            else -> "No oh-my-pk background lanes found."
                        }
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        contentPadding = PaddingValues(bottom = 12.dp)
                    ) {
                        groups.forEach { group ->
                            item(key = "folder:${group.key}") {
                                GatewayAgentHubFolderHeader(group)
                            }
                            items(
                                group.sessions,
                                key = { entry -> "${group.key}:${gatewaySessionKey(entry)}" }
                            ) { entry ->
                                val laneKey = gatewaySessionKey(entry)
                                val defaultExpanded = entry.isCurrentIn(currentState.dashboard)
                                val expanded = expandedLanes[laneKey] ?: defaultExpanded
                                GatewaySessionRow(
                                    entry = entry,
                                    dashboard = currentState.dashboard,
                                    prefs = prefs,
                                    expanded = expanded,
                                    pendingRemove = pendingRemoveKey == laneKey,
                                    selectedOmpSessionPath = selectedOmpSessionPath,
                                    onToggleExpanded = {
                                        expandedLanes[laneKey] = !expanded
                                    },
                                    onUse = {
                                        onRemoteSessionSelected(entry, currentState.dashboard)
                                        Toast.makeText(
                                            context,
                                            if (entry.isRouteCapableIn(currentState.dashboard)) "Gateway session target selected." else "Gateway workspace selected.",
                                            Toast.LENGTH_SHORT
                                        ).show()
                                    },
                                    onResume = if (entry.resumable) {
                                        {
                                            scope.launch {
                                                val message = client.resumeGatewaySession(entry)
                                                onRemoteSessionSelected(entry, currentState.dashboard)
                                                refresh()
                                                Toast.makeText(
                                                    context,
                                                    message,
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    } else {
                                        null
                                    },
                                    onRemove = if (!entry.canonicalSessionPath.isNullOrBlank()) {
                                        {
                                            if (pendingRemoveKey == laneKey) {
                                                scope.launch {
                                                    val message = client.removeGatewaySession(entry)
                                                    pendingRemoveKey = null
                                                    refresh()
                                                    Toast.makeText(
                                                        context,
                                                        message,
                                                        Toast.LENGTH_SHORT
                                                    ).show()
                                                }
                                            } else {
                                                pendingRemoveKey = laneKey
                                                Toast.makeText(
                                                    context,
                                                    "Tap Remove again to remove this lane.",
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    } else {
                                        null
                                    },
                                    onRouteOmpSession = gatewaySessionOmpRoutePath(entry)?.let {
                                        { sessionPath ->
                                            scope.launch {
                                                val message = client.selectOmpSession(sessionPath)
                                                selectedOmpSessionPath = sessionPath
                                                prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
                                                onRemoteSessionSelected(entry, currentState.dashboard)
                                                launchStatus = message
                                                refresh()
                                                Toast.makeText(
                                                    context,
                                                    message,
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    },
                                    onRename = entry.canonicalSessionPath?.let { sessionPath ->
                                        { newName ->
                                            scope.launch {
                                                val message = client.renameGatewaySession(sessionPath, newName)
                                                refresh()
                                                Toast.makeText(
                                                    context,
                                                    message,
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    },
                                    onAlias = entry.canonicalSessionPath?.let { sessionPath ->
                                        { alias ->
                                            scope.launch {
                                                val message = client.aliasGatewaySession(sessionPath, alias)
                                                refresh()
                                                Toast.makeText(
                                                    context,
                                                    message,
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    },
                                    onArchive = entry.canonicalSessionPath?.let { sessionPath ->
                                        {
                                            scope.launch {
                                                val message = client.archiveGatewaySession(sessionPath)
                                                refresh()
                                                Toast.makeText(
                                                    context,
                                                    message,
                                                    Toast.LENGTH_SHORT
                                                ).show()
                                            }
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun GatewaySessionsHeader(
    prefs: AppPreferences,
    state: GatewaySessionsUiState,
    filterText: String,
    onFilterTextChange: (String) -> Unit,
    launchingHub: Boolean,
    launchingColab: Boolean,
    joiningCollab: Boolean,
    onLaunchHub: () -> Unit,
    onLaunchColab: () -> Unit,
    onJoinCollab: () -> Unit,
    onRefresh: () -> Unit,
    showAllSessions: Boolean = false,
    onToggleShowAll: (() -> Unit)? = null
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 10.dp)
            .border(1.dp, Line, RoundedCornerShape(16.dp))
            .background(SurfacePaper, RoundedCornerShape(16.dp))
            .padding(12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("OMPK agent hub", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(3.dp))
                Text(
                    "Persistent oh-my-pk sessions on the host. Route voice/text turns into a lane or launch a new hub.",
                    color = InkMuted,
                    fontSize = 11.sp,
                    lineHeight = 15.sp
                )
                Spacer(modifier = Modifier.height(5.dp))
                Text("Gateway: ${prefs.targetIpAddress.ifBlank { "(no gateway)" }}", color = Ink, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Target: ${prefs.codexSessionName.ifBlank { "default" }}", color = Ink, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Workspace: ${prefs.workspacePath}", color = InkMuted, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (state is GatewaySessionsUiState.Loaded) {
                    val dashboard = state.dashboard
                    val ompLaneCount = dashboard.sessions.count { gatewaySessionIsOmpLane(it) }
                    Text(
                        "Current: ${dashboard.current.ifBlank { "none" }} | Ready: ${dashboard.ready.size} | OMPK lanes: $ompLaneCount",
                        color = InkMuted,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            OutlinedButton(
                onClick = onRefresh,
                enabled = state !is GatewaySessionsUiState.Loading,
                border = BorderStroke(1.dp, Line),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.heightIn(min = 44.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
            ) {
                Text("Refresh", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(modifier = Modifier.height(8.dp))
        GatewayHubCommandButton(
            text = if (launchingHub) "Launching..." else "Launch OMPK hub",
            enabled = !launchingHub,
            onClick = onLaunchHub
        )
        Spacer(modifier = Modifier.height(6.dp))
        GatewayHubCommandButton(
            text = if (launchingColab) "Launching..." else "Launch Colab",
            enabled = !launchingColab,
            onClick = onLaunchColab
        )
        Spacer(modifier = Modifier.height(6.dp))
        GatewayHubCommandButton(
            text = if (joiningCollab) "Joining..." else "Join collab",
            enabled = !joiningCollab,
            onClick = onJoinCollab
        )
        if (onToggleShowAll != null) {
            Spacer(modifier = Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = { if (showAllSessions) onToggleShowAll() },
                    border = BorderStroke(1.dp, if (!showAllSessions) Accent else Line),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.outlinedButtonColors(
                        containerColor = if (!showAllSessions) SelectedFill else SurfacePaper
                    ),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f).heightIn(min = 44.dp)
                ) {
                    Text(
                        "OMPK lanes",
                        color = if (!showAllSessions) Accent else Ink,
                        fontSize = 11.sp,
                        fontWeight = if (!showAllSessions) FontWeight.Bold else FontWeight.Medium
                    )
                }
                OutlinedButton(
                    onClick = { if (!showAllSessions) onToggleShowAll() },
                    border = BorderStroke(1.dp, if (showAllSessions) Accent else Line),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.outlinedButtonColors(
                        containerColor = if (showAllSessions) SelectedFill else SurfacePaper
                    ),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f).heightIn(min = 44.dp)
                ) {
                    Text(
                        "All sessions",
                        color = if (showAllSessions) Accent else Ink,
                        fontSize = 11.sp,
                        fontWeight = if (showAllSessions) FontWeight.Bold else FontWeight.Medium
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(10.dp))
        OutlinedTextField(
            value = filterText,
            onValueChange = onFilterTextChange,
            modifier = Modifier.fillMaxWidth(),
            leadingIcon = {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = InkMuted
                )
            },
            placeholder = { Text("Filter sessions, paths, aliases", fontSize = 12.sp, color = InkMuted) },
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontSize = 12.sp, color = Ink, fontFamily = FontFamily.Monospace),
            shape = RoundedCornerShape(12.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Accent,
                unfocusedBorderColor = Line,
                cursorColor = Accent,
                focusedTextColor = Ink,
                unfocusedTextColor = Ink
            )
        )
    }
}

@Composable
fun GatewaySessionsStatus(message: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
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
fun GatewayOpsPane(
    client: VoiceAgentClient,
    prefs: AppPreferences,
    modifier: Modifier = Modifier
) {
    var route by remember { mutableStateOf<GatewayRoute?>(null) }
    var slots by remember { mutableStateOf<List<GatewayRouteSlot>>(emptyList()) }
    var inventory by remember { mutableStateOf<AgentInventory?>(null) }
    var opsStatus by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    val events = remember { mutableStateListOf<GatewayEvent>() }
    var eventStreamConnected by remember { mutableStateOf(false) }
    var eventStreamDetail by remember { mutableStateOf("Connecting…") }
    val scope = rememberCoroutineScope()

    fun refresh() {
        if (loading) return
        loading = true
        scope.launch {
            try {
                route = client.getRoute()
                slots = client.getRouteSlots() ?: emptyList()
                inventory = client.getAgentInventory()
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(prefs.targetIpAddress, prefs.remoteToken) { refresh() }

    DisposableEffect(prefs.targetIpAddress, prefs.remoteToken) {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val stream = client.openEventStream(
            onEvent = { event ->
                handler.post {
                    events.add(0, event)
                    while (events.size > 100) events.removeAt(events.size - 1)
                }
            },
            onStateChange = { connected, detail ->
                handler.post {
                    eventStreamConnected = connected
                    eventStreamDetail = detail
                }
            }
        )
        onDispose { stream.stop() }
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(bottom = 12.dp)
    ) {
        item(key = "ops-routing") {
            GatewayOpsCard(title = "Routing", trailing = {
                OutlinedButton(
                    onClick = { refresh() },
                    enabled = !loading,
                    border = BorderStroke(1.dp, Line),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.heightIn(min = 44.dp),
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp)
                ) {
                    Text("Refresh", color = Ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }) {
                val currentRoute = route
                if (currentRoute == null) {
                    GatewayOpsMutedLine(if (loading) "Loading route…" else "Route status unavailable on this gateway.")
                } else {
                    GatewayOpsMutedLine("Default target: ${currentRoute.defaultTarget ?: "current session"}")
                    GatewayOpsMutedLine("Current session: ${currentRoute.currentSession ?: "unknown"}")
                    Spacer(modifier = Modifier.height(6.dp))
                    if (currentRoute.availableTargets.isEmpty()) {
                        GatewayOpsMutedLine("No named targets available.")
                    } else {
                        currentRoute.availableTargets.forEach { target ->
                            val active = target == currentRoute.defaultTarget || (currentRoute.defaultTarget == null && target == currentRoute.currentSession)
                            Text(
                                text = target,
                                color = if (active) Accent else Ink,
                                fontSize = 12.sp,
                                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(if (active) SelectedFill else Color.Transparent)
                                    .clickable {
                                        scope.launch {
                                            val update = client.setRoute(target)
                                            opsStatus = update.message
                                            update.route?.let { route = it }
                                            applyGatewayRouteUpdateToPrefs(update, target, prefs)
                                        }
                                    }
                                    .padding(horizontal = 8.dp, vertical = 12.dp)
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(6.dp))
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                val update = client.setRoute("")
                                opsStatus = update.message
                                update.route?.let { route = it }
                                applyGatewayRouteUpdateToPrefs(update, "", prefs)
                            }
                        },
                        border = BorderStroke(1.dp, Line),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)
                    ) {
                        Text("Use current session", color = Ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                if (opsStatus.isNotBlank()) {
                    Spacer(modifier = Modifier.height(4.dp))
                    GatewayOpsMutedLine(opsStatus)
                }
            }
        }

        item(key = "ops-slots") {
            GatewayOpsCard(title = "Route slots") {
                if (slots.isEmpty()) {
                    GatewayOpsMutedLine(if (loading) "Loading slots…" else "No compact route slots reported.")
                } else {
                    slots.forEach { slot ->
                        val detail = when (slot.status) {
                            "mapped" -> slot.sessionName ?: "unknown"
                            "ambiguous" -> "ambiguous: ${slot.labels.joinToString(", ")}"
                            else -> "unassigned"
                        }
                        Text(
                            text = "PK${slot.family} → $detail",
                            color = Ink,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(vertical = 3.dp)
                        )
                        if (slot.status == "mapped" && slot.labels.isNotEmpty()) {
                            GatewayOpsMutedLine("say: ${slot.labels.joinToString(", ")}")
                        }
                    }
                }
            }
        }

        item(key = "ops-agents") {
            GatewayOpsCard(title = "Discovered agents") {
                val agentInventory = inventory
                if (agentInventory == null) {
                    GatewayOpsMutedLine(if (loading) "Scanning agents…" else "Agent discovery unavailable on this gateway.")
                } else {
                    val discoveredTargets = if (agentInventory.running.isEmpty()) agentInventory.agents else emptyList()
                    if (agentInventory.running.isEmpty() && discoveredTargets.isEmpty() && agentInventory.recent.isEmpty()) {
                        GatewayOpsMutedLine("No running or recent agents found on the host.")
                    }
                    if (agentInventory.running.isNotEmpty() || discoveredTargets.isNotEmpty()) {
                        GatewayOpsMutedLine("Running — tap to target")
                        agentInventory.running.forEach { agent ->
                            GatewayOpsRow(
                                title = agent.target,
                                subtitle = listOfNotNull(agent.provider, agent.cwd ?: agent.cwdBasename).joinToString(" | "),
                                onClick = {
                                    scope.launch {
                                        val update = client.setRoute(agent.target)
                                        opsStatus = update.message
                                        update.route?.let { route = it }
                                        applyGatewayRouteUpdateToPrefs(update, agent.target, prefs)
                                    }
                                }
                            )
                        }
                        discoveredTargets.forEach { target ->
                            GatewayOpsRow(
                                title = target,
                                subtitle = target.substringBefore(':').ifBlank { "agent" },
                                onClick = {
                                    scope.launch {
                                        val update = client.setRoute(target)
                                        opsStatus = update.message
                                        update.route?.let { route = it }
                                        applyGatewayRouteUpdateToPrefs(update, target, prefs)
                                    }
                                }
                            )
                        }
                    }
                    if (agentInventory.recent.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(6.dp))
                        GatewayOpsMutedLine("Recent sessions — tap to mount workspace")
                        agentInventory.recent.take(10).forEach { session ->
                            GatewayOpsRow(
                                title = session.title ?: session.path.substringAfterLast('/').substringAfterLast('\\'),
                                subtitle = listOfNotNull(session.provider, session.cwd ?: session.cwdBasename).joinToString(" | "),
                                onClick = {
                                    val cwd = session.cwd
                                    if (!cwd.isNullOrBlank()) {
                                        prefs.workspacePath = cwd
                                        opsStatus = "Workspace mounted: $cwd"
                                    } else {
                                        opsStatus = "Session has no recorded workspace."
                                    }
                                }
                            )
                        }
                    }
                }
            }
        }

        item(key = "ops-events") {
            GatewayOpsCard(title = "Events", trailing = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (eventStreamConnected) Success else Warn)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        if (eventStreamConnected) "Live · $eventStreamDetail" else eventStreamDetail,
                        color = InkMuted,
                        fontSize = 10.sp
                    )
                }
            }) {
                if (events.isEmpty()) {
                    GatewayOpsMutedLine("No session events yet. Voice and admin actions on the host appear here live.")
                } else {
                    events.forEach { event ->
                        val time = if (event.ts > 0L) {
                            SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(event.ts))
                        } else {
                            "--:--:--"
                        }
                        Column(modifier = Modifier.padding(vertical = 3.dp)) {
                            Text(
                                text = "$time ${event.source}/${event.kind}",
                                color = Ink,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            if (event.summary.isNotBlank()) {
                                Text(
                                    text = event.summary,
                                    color = InkMuted,
                                    fontSize = 10.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun GatewayOpsCard(
    title: String,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Line, RoundedCornerShape(16.dp))
            .background(SurfacePaper, RoundedCornerShape(16.dp))
            .padding(12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(title, color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            trailing?.invoke()
        }
        Spacer(modifier = Modifier.height(6.dp))
        content()
    }
}

@Composable
fun GatewayOpsMutedLine(text: String) {
    Text(
        text = text,
        color = InkMuted,
        fontSize = 11.sp,
        lineHeight = 15.sp,
        modifier = Modifier.padding(vertical = 1.dp)
    )
}

@Composable
fun GatewayOpsRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable { onClick() }
            .padding(horizontal = 8.dp, vertical = 8.dp)
    ) {
        Text(
            text = title,
            color = Ink,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        if (subtitle.isNotBlank()) {
            Text(
                text = subtitle,
                color = InkMuted,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
fun GatewayHubCommandButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp),
        border = BorderStroke(1.dp, Line),
        shape = RoundedCornerShape(12.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = Ink,
            disabledContentColor = InkMuted
        )
    ) {
        Text(
            text,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold
        )
    }
}

@Composable
fun GatewaySessionRow(
    entry: GatewaySessionEntry,
    dashboard: GatewaySessionDashboard,
    prefs: AppPreferences,
    expanded: Boolean,
    pendingRemove: Boolean,
    selectedOmpSessionPath: String?,
    onToggleExpanded: () -> Unit,
    onUse: () -> Unit,
    onResume: (() -> Unit)? = null,
    onRemove: (() -> Unit)? = null,
    onRouteOmpSession: ((String) -> Unit)? = null,
    onRename: ((String) -> Unit)? = null,
    onAlias: ((String) -> Unit)? = null,
    onArchive: (() -> Unit)? = null
) {
    val isRouteCapable = entry.isRouteCapableIn(dashboard)
    val isSelectedFile = prefs.selectedGatewaySessionPath.isNotBlank() && prefs.selectedGatewaySessionPath == entry.canonicalSessionPath
    val isSelectedTarget = isRouteCapable && prefs.codexSessionName == entry.name
    val isCurrent = entry.isCurrentIn(dashboard)
    val isReady = entry.isReadyIn(dashboard)
    val statusText = gatewaySessionStatusText(entry, dashboard)
    val statusGlyph = when {
        isCurrent -> "[+]"
        isReady -> "[+]"
        entry.activity.equals("busy", ignoreCase = true) -> "[*]"
        entry.activity.equals("idle", ignoreCase = true) -> "[~]"
        entry.activity.isNullOrBlank() -> "[ ]"
        else -> "[!]"
    }
    val statusBorderWeight = if (isCurrent || isReady) 2.dp else 1.dp
    val borderColor = when {
        isSelectedTarget || isSelectedFile -> Accent
        isCurrent -> Success
        isReady -> Warn
        else -> Line
    }
    val ompRoutePath = gatewaySessionOmpRoutePath(entry)
    val isOmpRouteSelected = !ompRoutePath.isNullOrBlank() && ompRoutePath == selectedOmpSessionPath

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = if (isOmpRouteSelected) SelectedFill else SurfacePaper,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(if (isOmpRouteSelected || isSelectedTarget || isSelectedFile) 2.dp else 1.dp, if (isOmpRouteSelected) Accent else borderColor)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onToggleExpanded() },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                    contentDescription = if (expanded) "Collapse session lane" else "Expand session lane",
                    tint = InkMuted,
                    modifier = Modifier.size(22.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = entry.name.ifBlank { "Unnamed session" },
                        color = Ink,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(3.dp))
                    Text(
                        text = gatewaySessionSubtitle(entry, dashboard),
                        color = InkMuted,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Text(
                    text = "$statusGlyph $statusText",
                    color = Ink,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .border(statusBorderWeight, Line, RoundedCornerShape(8.dp))
                        .background(SurfaceSubtle, RoundedCornerShape(8.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (isCurrent) item { GatewaySessionBadge("current", Success) }
                if (isReady) item { GatewaySessionBadge("ready", Warn) }
                item { GatewaySessionBadge(if (isCurrent) "current session" else "background lane", InkMuted) }
                gatewaySessionSourceLabel(entry)?.let { source ->
                    item { GatewaySessionBadge(source, InkMuted) }
                }
                entry.provider?.takeIf { it.isNotBlank() }?.let { provider ->
                    item { GatewaySessionBadge(provider, InkMuted) }
                }
                entry.model?.takeIf { it.isNotBlank() }?.let { model ->
                    item { GatewaySessionBadge(model, InkMuted) }
                }
                entry.role?.takeIf { it.isNotBlank() }?.let { role ->
                    item { GatewaySessionBadge(role, InkMuted) }
                }
                if (entry.aliases.isNotEmpty()) {
                    item { GatewaySessionBadge("aliases: ${entry.aliases.joinToString(", ")}", InkMuted) }
                }
                if (entry.subagents.isNotEmpty()) {
                    item { GatewaySessionBadge("${entry.subagents.size} subagents", Warn) }
                }
                if (!isRouteCapable) item { GatewaySessionBadge("workspace only", InkMuted) }
                if (entry.resumable) item { GatewaySessionBadge("resumable", Success) }
                if (entry.stale) item { GatewaySessionBadge("stale", InkMuted) }
            }

            if (!ompRoutePath.isNullOrBlank() && onRouteOmpSession != null) {
                Spacer(modifier = Modifier.height(6.dp))
                OutlinedButton(
                    onClick = { onRouteOmpSession(ompRoutePath) },
                    border = BorderStroke(if (isOmpRouteSelected) 2.dp else 1.dp, if (isOmpRouteSelected) Accent else Line),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.outlinedButtonColors(
                        containerColor = if (isOmpRouteSelected) SelectedFill else Color.Transparent
                    ),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)
                ) {
                    Text(
                        text = if (isOmpRouteSelected) "Routing turns here" else "Route turns here",
                        color = if (isOmpRouteSelected) Accent else Ink,
                        fontSize = 12.sp,
                        fontWeight = if (isOmpRouteSelected) FontWeight.Bold else FontWeight.Medium
                    )
                }
            }

            AnimatedVisibility(visible = expanded) {
                Column {
                    Spacer(modifier = Modifier.height(10.dp))
                    GatewaySessionDetailLine("Workspace", entry.displayCwd)
                    entry.sessionId?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Resume id", it)
                    }
                    entry.canonicalSessionPath?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Session file", it)
                    }
                    if (entry.aliases.isNotEmpty()) {
                        GatewaySessionDetailLine("Voice aliases", entry.aliases.joinToString(", "))
                    }
                    entry.source?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Source", it)
                    }
                    entry.model?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Model", it)
                    }
                    entry.role?.takeIf { it.isNotBlank() }?.let {
                        GatewaySessionDetailLine("Role", it)
                    }
                    if (entry.subagents.isNotEmpty()) {
                        GatewaySessionDetailLine(
                            "Subagents",
                            entry.subagents.joinToString(", ") { subagent -> subagent.name.ifBlank { subagent.id } }
                        )
                    }
                    if (entry.resumeCommand.isNotEmpty()) {
                        GatewaySessionDetailLine("Resume command", entry.resumeCommand.joinToString(" "))
                    }

                    Spacer(modifier = Modifier.height(12.dp))
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Button(
                            onClick = onResume ?: onUse,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Accent,
                                contentColor = Color.White
                            ),
                            shape = RoundedCornerShape(12.dp),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 5.dp),
                            modifier = Modifier.heightIn(min = 44.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Filled.PlayArrow,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(if (onResume != null) "Resume" else if (isRouteCapable) "Focus" else "Workspace", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                        OutlinedButton(
                            onClick = onUse,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 5.dp),
                            modifier = Modifier.heightIn(min = 44.dp),
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, Line)
                        ) {
                            Text(
                                if (isRouteCapable) "Target" else "Mount",
                                color = Ink,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        if (onArchive != null) {
                            OutlinedButton(
                                onClick = onArchive,
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                modifier = Modifier.heightIn(min = 44.dp),
                                shape = RoundedCornerShape(12.dp),
                                border = BorderStroke(1.dp, Line)
                            ) {
                                Text("Archive", color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                        if (onRemove != null) {
                            OutlinedButton(
                                onClick = onRemove,
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                modifier = Modifier.heightIn(min = 44.dp),
                                shape = RoundedCornerShape(12.dp),
                                colors = ButtonDefaults.outlinedButtonColors(
                                    contentColor = if (pendingRemove) Error else Ink
                                ),
                                border = BorderStroke(if (pendingRemove) 2.dp else 1.dp, if (pendingRemove) Error else Line)
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Delete,
                                    contentDescription = null,
                                    modifier = Modifier.size(15.dp)
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Text(if (pendingRemove) "Confirm" else "Remove", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }

                    if (onRename != null || onAlias != null) {
                        Spacer(modifier = Modifier.height(10.dp))
                        var manageText by remember(gatewaySessionKey(entry)) { mutableStateOf("") }
                        OutlinedTextField(
                            value = manageText,
                            onValueChange = { manageText = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = { Text("New name or wake alias", fontSize = 11.sp, color = InkMuted) },
                            singleLine = true,
                            textStyle = LocalTextStyle.current.copy(fontSize = 12.sp, color = Ink, fontFamily = FontFamily.Monospace),
                            shape = RoundedCornerShape(12.dp),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Accent,
                                unfocusedBorderColor = Line,
                                cursorColor = Accent,
                                focusedTextColor = Ink,
                                unfocusedTextColor = Ink
                            )
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (onRename != null) {
                                OutlinedButton(
                                    onClick = {
                                        val value = manageText.trim()
                                        if (value.isNotEmpty()) {
                                            onRename(value)
                                            manageText = ""
                                        }
                                    },
                                    enabled = manageText.isNotBlank(),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                    modifier = Modifier.heightIn(min = 44.dp),
                                    shape = RoundedCornerShape(12.dp),
                                    border = BorderStroke(1.dp, Line)
                                ) {
                                    Text("Rename", color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                            if (onAlias != null) {
                                OutlinedButton(
                                    onClick = {
                                        val value = manageText.trim()
                                        if (value.isNotEmpty()) {
                                            onAlias(value)
                                            manageText = ""
                                        }
                                    },
                                    enabled = manageText.isNotBlank(),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 5.dp),
                                    modifier = Modifier.heightIn(min = 44.dp),
                                    shape = RoundedCornerShape(12.dp),
                                    border = BorderStroke(1.dp, Line)
                                ) {
                                    Text("Add alias", color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun GatewayAgentHubFolderHeader(group: GatewayAgentHubGroup) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp, bottom = 2.dp, start = 2.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = group.label,
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (group.isCurrentWorkspace) {
                    Spacer(modifier = Modifier.width(6.dp))
                    GatewaySessionBadge("current folder", Success)
                }
            }
            Text(
                text = group.cwd.ifBlank { "unknown workspace" },
                color = InkMuted,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Text(
            text = "${group.sessions.size} ${if (group.sessions.size == 1) "lane" else "lanes"}",
            color = Ink,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace
        )
    }
}

@Composable
fun GatewaySessionDetailLine(label: String, value: String) {
    if (value.isBlank()) return
    Column(modifier = Modifier.padding(bottom = 6.dp)) {
        Text(
            text = label,
            color = InkMuted,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold
        )
        Text(
            text = value,
            color = InkMuted,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

data class GatewayAgentHubGroup(
    val key: String,
    val label: String,
    val cwd: String,
    val isCurrentWorkspace: Boolean,
    val sessions: List<GatewaySessionEntry>
)

fun buildGatewayAgentHubGroups(
    dashboard: GatewaySessionDashboard,
    currentWorkspace: String,
    query: String,
    ompOnly: Boolean = true
): List<GatewayAgentHubGroup> {
    val normalizedQuery = query.trim().lowercase()
    val visibleSessions = dashboard.sessions
        .filter { entry -> !ompOnly || gatewaySessionIsOmpLane(entry) }
        .filter { entry -> normalizedQuery.isBlank() || gatewaySessionMatches(entry, dashboard, normalizedQuery) }
    val currentKey = gatewayFolderKey(currentWorkspace)
    return visibleSessions
        .groupBy { gatewayFolderKey(it.displayCwd) }
        .map { (key, entries) ->
            val cwd = entries.firstOrNull()?.displayCwd.orEmpty()
            GatewayAgentHubGroup(
                key = key,
                label = gatewayFolderLabel(cwd),
                cwd = cwd,
                isCurrentWorkspace = key == currentKey,
                sessions = entries.sortedWith(
                    compareByDescending<GatewaySessionEntry> { it.isCurrentIn(dashboard) }
                        .thenByDescending { it.isReadyIn(dashboard) }
                        .thenByDescending { it.resumable }
                        .thenBy { it.name.lowercase() }
                )
            )
        }
        .sortedWith(
            compareByDescending<GatewayAgentHubGroup> { it.isCurrentWorkspace }
                .thenByDescending { group -> group.sessions.any { it.isCurrentIn(dashboard) || it.isReadyIn(dashboard) } }
                .thenBy { it.label.lowercase() }
        )
}

fun gatewaySessionKey(entry: GatewaySessionEntry): String =
    entry.canonicalSessionPath?.takeIf { it.isNotBlank() }
        ?: entry.sessionId?.takeIf { it.isNotBlank() }
        ?: entry.name.ifBlank { "session-${entry.hashCode()}" }

fun gatewaySessionIsOmpLane(entry: GatewaySessionEntry): Boolean =
    entry.source.equals("oh-my-pk", ignoreCase = true) ||
        entry.source.equals("oh-my-pi", ignoreCase = true) ||
        entry.kind.equals("background", ignoreCase = true) ||
        entry.provider.equals("oh-my-pk", ignoreCase = true) ||
        entry.provider.equals("oh-my-pi", ignoreCase = true)

fun gatewaySessionOmpRoutePath(entry: GatewaySessionEntry): String? {
    if (!gatewaySessionIsOmpLane(entry)) return null
    return entry.canonicalSessionPath?.takeIf { it.isNotBlank() }
}

fun gatewaySessionMatches(entry: GatewaySessionEntry, dashboard: GatewaySessionDashboard, query: String): Boolean {
    val fields = listOfNotNull(
        entry.name,
        entry.displayCwd,
        entry.activity,
        entry.provider,
        entry.source,
        entry.model,
        entry.role,
        entry.sessionId,
        entry.canonicalSessionPath,
        gatewaySessionStatusText(entry, dashboard),
        entry.aliases.joinToString(" "),
        entry.subagents.joinToString(" ") { subagent ->
            listOfNotNull(subagent.name, subagent.status, subagent.activity, subagent.sessionPath).joinToString(" ")
        }
    )
    return fields.any { it.lowercase().contains(query) }
}

fun gatewayFolderKey(cwd: String): String =
    cwd.trim().replace('\\', '/').trimEnd('/').lowercase().ifBlank { "unknown" }

fun gatewayFolderLabel(cwd: String): String {
    val normalized = cwd.trim().replace('\\', '/').trimEnd('/')
    return normalized.substringAfterLast('/').ifBlank { normalized.ifBlank { "Unknown workspace" } }
}

fun gatewaySessionStatusText(entry: GatewaySessionEntry, dashboard: GatewaySessionDashboard): String = when {
    entry.isCurrentIn(dashboard) -> "current"
    entry.isReadyIn(dashboard) -> "ready"
    entry.activity.equals("busy", ignoreCase = true) -> "running"
    gatewaySessionIsOmpLane(entry) -> "parked"
    entry.resumable -> "parked"
    else -> entry.activity ?: "saved"
}

fun gatewaySessionSubtitle(entry: GatewaySessionEntry, dashboard: GatewaySessionDashboard): String {
    val kind = when {
        entry.isCurrentIn(dashboard) -> "current session"
        gatewaySessionIsOmpLane(entry) -> "background agent"
        else -> "background session"
    }
    val cwd = gatewayFolderLabel(entry.displayCwd)
    val provider = entry.provider?.takeIf { it.isNotBlank() }
    val source = gatewaySessionSourceLabel(entry)
    val model = entry.model?.takeIf { it.isNotBlank() }
    val role = entry.role?.takeIf { it.isNotBlank() }
    return listOfNotNull(kind, source, provider, model, role, cwd).distinct().joinToString(" | ")
}

fun gatewaySessionSourceLabel(entry: GatewaySessionEntry): String? = when (entry.source) {
    "oh-my-pk" -> "Oh-my-pk"
    "oh-my-pi" -> "Oh-my-pk"
    else -> entry.source?.takeIf { it.isNotBlank() }
}

@Composable
fun GatewaySessionBadge(text: String, color: Color) {
    val borderWidth = when (color) {
        Success, Warn -> 2.dp
        else -> 1.dp
    }
    Text(
        text = text,
        color = Ink,
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .border(borderWidth, color, RoundedCornerShape(8.dp))
            .background(SurfaceSubtle, RoundedCornerShape(8.dp))
            .padding(horizontal = 6.dp, vertical = 3.dp)
    )
}

sealed interface GatewaySessionsUiState {
    data object Idle : GatewaySessionsUiState
    data object Loading : GatewaySessionsUiState
    data class Loaded(val dashboard: GatewaySessionDashboard) : GatewaySessionsUiState
    data object Empty : GatewaySessionsUiState
    data object Unauthorized : GatewaySessionsUiState
    data object Unsupported : GatewaySessionsUiState
    data class Error(val message: String) : GatewaySessionsUiState
}

fun applyGatewaySessionSelection(
    entry: GatewaySessionEntry,
    dashboard: GatewaySessionDashboard,
    prefs: AppPreferences
) {
    val cwd = entry.workingDirectory?.takeIf { it.isNotBlank() }
        ?: entry.cwd?.takeIf { it.isNotBlank() }
    prefs.selectedGatewaySessionPath = entry.canonicalSessionPath.orEmpty()
    if (!cwd.isNullOrBlank()) {
        prefs.workspacePath = cwd
    }
    if (entry.isRouteCapableIn(dashboard) && entry.name.isNotBlank()) {
        prefs.codexSessionName = entry.name
    }
}

fun applyGatewayRouteUpdateToPrefs(
    update: GatewayRouteUpdate,
    requestedTarget: String,
    prefs: AppPreferences
) {
    if (!update.ok) return
    val nextTarget = update.route?.defaultTarget?.takeIf { it.isNotBlank() }
        ?: update.route?.currentSession?.takeIf { it.isNotBlank() }
        ?: requestedTarget.takeIf { it.isNotBlank() }
        ?: return
    prefs.codexSessionName = nextTarget
}

@Composable
fun LocalTurnHistoryPane(
    audioHelper: AudioHelper,
    ttsHelper: TtsHelper,
    prefs: AppPreferences,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    var sessionsList by remember { mutableStateOf(prefs.getRecordedSessions()) }
    var activePlaybackId by remember { mutableStateOf<String?>(null) }

    fun refreshList() {
        sessionsList = prefs.getRecordedSessions()
    }

    if (sessionsList.isEmpty()) {
        Box(
            modifier = modifier.fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = "No local turn history yet.",
                    color = InkMuted,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Transmit a voice or text turn to start logging sessions.",
                    color = InkMuted,
                    fontSize = 12.sp
                )
            }
        }
    } else {
        LazyColumn(
            modifier = modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp)
        ) {
            items(sessionsList, key = { it.id }) { item ->
                val isPlaying = activePlaybackId == item.id
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    color = SurfacePaper,
                    shape = RoundedCornerShape(16.dp),
                    border = BorderStroke(1.dp, if (isPlaying) Success else Line)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "Turn #${item.id.take(4).uppercase()}",
                                color = Accent,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = 0.5.sp
                            )
                            Text(
                                text = item.voiceAgent,
                                color = InkMuted,
                                fontSize = 10.sp
                            )
                        }

                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Prompt: \"${item.transcriptionText}\"",
                            color = Ink,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium
                        )

                        Spacer(modifier = Modifier.height(4.dp))
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(SurfaceSubtle, RoundedCornerShape(8.dp))
                                .padding(8.dp)
                        ) {
                            Text(
                                text = item.replyText,
                                color = Ink,
                                fontSize = 13.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 4,
                                overflow = TextOverflow.Ellipsis
                            )
                        }

                        Spacer(modifier = Modifier.height(12.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                // Real-time Tape Playback action
                                Button(
                                    onClick = {
                                        if (isPlaying) {
                                            audioHelper.stopPlayback()
                                            activePlaybackId = null
                                        } else {
                                            activePlaybackId = item.id
                                            audioHelper.startPlayback(item.recordingPath) {
                                                activePlaybackId = null
                                            }
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = if (isPlaying) Error else Accent,
                                        contentColor = if (isPlaying) Color.White else SurfacePaper
                                    ),
                                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                                    shape = RoundedCornerShape(12.dp),
                                    modifier = Modifier.heightIn(min = 44.dp)
                                ) {
                                    Text(
                                        text = if (isPlaying) "Stop tape" else "Play tape",
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }

                                if (item.replyAudioPath != null) {
                                    Button(
                                        onClick = {
                                            if (isPlaying) {
                                                audioHelper.stopPlayback()
                                                activePlaybackId = null
                                            } else {
                                                activePlaybackId = item.id
                                                audioHelper.startPlayback(item.replyAudioPath) {
                                                    activePlaybackId = null
                                                }
                                            }
                                        },
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = Success,
                                            contentColor = Color.White
                                        ),
                                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.heightIn(min = 44.dp)
                                    ) {
                                        Text(
                                            text = "Play reply audio",
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                } else {
                                    Button(
                                        onClick = {
                                            ttsHelper.speak(item.replyText)
                                        },
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = Accent,
                                            contentColor = Color.White
                                        ),
                                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.heightIn(min = 44.dp)
                                    ) {
                                        Text(
                                            text = "Speak reply",
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                    }
                                }
                            }

                            // Copy Action
                            val clipboardManager = LocalClipboardManager.current
                            TextButton(
                                onClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    val textToCopy = "Prompt: ${item.transcriptionText}\nReply: ${item.replyText}"
                                    clipboardManager.setText(AnnotatedString(textToCopy))
                                    Toast.makeText(context, "Turn copied to clipboard", Toast.LENGTH_SHORT).show()
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                                modifier = Modifier.heightIn(min = 44.dp)
                            ) {
                                Text("Copy", color = InkMuted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            }
                            Spacer(modifier = Modifier.width(4.dp))

                            // Delete Action
                            TextButton(
                                onClick = {
                                    prefs.deleteRecordedSession(item.id)
                                    refreshList()
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                                modifier = Modifier.heightIn(min = 44.dp)
                            ) {
                                Text("Delete", color = Error, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
        }
    }
}
