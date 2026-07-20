export const STORAGE_TOKEN = "piSpeakRemoteToken";
export const STORAGE_AUDIO = "piSpeakRemoteAudio";
export const STORAGE_AUTOPLAY = "piSpeakRemoteAutoplay";
export const STORAGE_REMEMBER = "piSpeakRemoteRememberToken";
export const STORAGE_LAUNCH_PATH = "piSpeakRemoteLaunchPath";
export const STORAGE_LIVE_MODE = "piSpeakRemoteLiveMode";
export const STORAGE_LIVE_GATE = "piSpeakRemoteLiveNoiseGate";
export const STORAGE_LIVE_GATE_DB = "piSpeakRemoteLiveNoiseGateDb";

export function buildRealtimeWebSocketUrl(origin, token = "") {
	const url = new URL("/v1/live", origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	if (token) url.searchParams.set("token", token);
	return url.toString();
}

export function isLoopbackHostname(hostname) {
	const normalized = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function encodeLivePcmFrame(sequenceId, samples, inputSampleRate, outputSampleRate = 16_000) {
	if (!Number.isInteger(sequenceId) || sequenceId < 1) throw new Error("Live audio sequence ID must be a positive integer.");
	if (!samples || typeof samples.length !== "number") throw new Error("Live audio samples are required.");
	if (!Number.isFinite(inputSampleRate) || inputSampleRate < 1 || outputSampleRate < 1) {
		throw new Error("Live audio sample rates are invalid.");
	}
	const ratio = inputSampleRate / outputSampleRate;
	const outputLength = Math.max(1, Math.floor(samples.length / ratio));
	const frame = new ArrayBuffer(4 + outputLength * 2);
	const view = new DataView(frame);
	view.setInt32(0, sequenceId, false);
	for (let index = 0; index < outputLength; index += 1) {
		const start = Math.floor(index * ratio);
		const end = Math.max(start + 1, Math.min(samples.length, Math.floor((index + 1) * ratio)));
		let sum = 0;
		for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) sum += samples[sourceIndex];
		const sample = Math.max(-1, Math.min(1, sum / (end - start)));
		view.setInt16(4 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
	}
	return frame;
}

export function decodeLivePcmFrame(frame) {
	const bytes = frame instanceof ArrayBuffer
		? frame
		: ArrayBuffer.isView(frame)
			? frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength)
			: null;
	if (!bytes || bytes.byteLength < 6 || (bytes.byteLength - 4) % 2 !== 0) return null;
	const view = new DataView(bytes);
	const samples = new Float32Array((bytes.byteLength - 4) / 2);
	for (let index = 0; index < samples.length; index += 1) {
		const sample = view.getInt16(4 + index * 2, true);
		samples[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
	}
	return { sequenceId: view.getInt32(0, false), samples };
}

/** Stamp a 4-byte BE sequence header onto Int16 LE PCM already at 16 kHz (HF worklet output). */
export function encodeLiveInt16PcmFrame(sequenceId, int16Samples) {
	if (!Number.isInteger(sequenceId) || sequenceId < 1) throw new Error("Live audio sequence ID must be a positive integer.");
	const samples = int16Samples instanceof Int16Array
		? int16Samples
		: int16Samples instanceof ArrayBuffer
			? new Int16Array(int16Samples)
			: null;
	if (!samples || samples.length === 0) throw new Error("Live Int16 PCM samples are required.");
	const frame = new ArrayBuffer(4 + samples.byteLength);
	const view = new DataView(frame);
	view.setInt32(0, sequenceId, false);
	new Uint8Array(frame, 4).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
	return frame;
}

export function loadPersistedSettings({
	queryToken = "",
	queryLaunchPath = "",
	sessionToken = "",
	localToken = "",
	rememberToken = false,
	audio = "true",
	autoplay = "true",
} = {}) {
	return {
		token: queryToken || sessionToken || localToken || "",
		launchPath: queryLaunchPath || "",
		wantAudio: audio !== "false",
		autoplay: autoplay !== "false",
		rememberToken,
		shouldPersistQueryToken: !!queryToken,
	};
}

export function persistSettingsSnapshot({
	token = "",
	launchPath = "",
	wantAudio = true,
	liveMode = false,
	autoplay = true,
	rememberToken = false,
} = {}) {
	return {
		session: token ? { [STORAGE_TOKEN]: token } : {},
		local: {
			...(rememberToken && token ? { [STORAGE_TOKEN]: token } : {}),
			...(launchPath ? { [STORAGE_LAUNCH_PATH]: launchPath } : {}),
			[STORAGE_REMEMBER]: String(rememberToken),
			[STORAGE_AUDIO]: String(wantAudio),
			[STORAGE_LIVE_MODE]: String(liveMode),
			[STORAGE_AUTOPLAY]: String(autoplay),
		},
		clearLocalToken: !rememberToken || !token,
	};
}

if (typeof document !== "undefined") {
	const state = {
		token: "",
		launchPath: "",
		wantAudio: true,
		liveMode: false,
		autoplay: true,
		rememberToken: false,
		mediaRecorder: null,
		stream: null,
		chunks: [],
		recording: false,
		turnInProgress: false,
		nextTurnId: 0,
		turnStartedAt: 0,
		recordStartedAt: 0,
		timerId: null,
		deferredPrompt: null,
		lastStatus: null,
		activeTab: "chat",
		selectedSessionPath: "",
		eventSource: null,
		eventLog: [],
		discoveredAgents: [],
		runningAgents: [],
		recentAgentSessions: [],
		agentSnapshotAt: "",
		workspacePath: "",
		workspaceCurrent: "",
		workspaceParent: "",
		workspaceInitialized: false,
		fileViewerReturnFocus: null,
		liveSocket: null,
		liveConnected: false,
		liveSessionId: "",
		liveLastServerSequenceId: 0,
		liveReconnectAttempts: 0,
		liveReconnectTimer: null,
		liveStableTimer: null,
		liveClientSequenceId: 0,
		liveReplyBuffer: "",
		liveAgentMessage: null,
		liveSettleTimer: null,
		liveTurnInProgress: false,
		liveAudioContext: null,
		liveCaptureSource: null,
		liveCaptureNode: null,
		liveCaptureStarting: false,
		liveCaptureEpoch: 0,
		liveAudioWorkletReady: false,
		liveCaptureSink: null,
		livePlaybackNode: null,
		livePlaybackReady: false,
		livePlaybackSampleRate: 24_000,
		livePlaybackCursor: 0,
		livePlaybackSources: new Set(),
		livePlaybackGeneration: 0,
		liveLastInterruptAt: 0,
		liveMicLevel: 0,
		liveNoiseGateDb: -50,
		liveNoiseGateEnabled: true,
		liveCameraStream: null,
		liveCameraEnabled: false,
		liveWebSearchAvailable: false,
		liveState: "idle",
		pendingTerminalApprovals: {},
	};

	const els = {
		appRoot: document.getElementById("app-root"),
		dock: document.getElementById("dock"),
		setupBanner: document.getElementById("setup-banner"),

		routePill: document.getElementById("route-pill"),
		agentPill: document.getElementById("agent-pill"),
		auth: document.getElementById("auth-pill"),
		statusDot: document.getElementById("status-dot"),
		statusNote: document.getElementById("status-note"),
		terminalApprovals: document.getElementById("terminal-approvals"),
		audioControlsWrapper: document.getElementById("audio-controls-wrapper"),
		chatMessages: document.getElementById("chat-messages"),
		transcript: document.getElementById("transcript-output"),
		reply: document.getElementById("reply-output"),
		audio: document.getElementById("reply-audio"),
		playReply: document.getElementById("play-reply-button"),

		textInput: document.getElementById("text-input"),
		sendText: document.getElementById("send-text-button"),
		clearText: document.getElementById("clear-text-button"),

		record: document.getElementById("record-button"),
		recordLabel: document.getElementById("record-label"),
		recordSubtitle: document.getElementById("record-subtitle"),
		recordLabelMain: document.getElementById("record-label-main"),
		timer: document.getElementById("timer"),

		refresh: document.getElementById("refresh-button"),
		install: document.getElementById("install-button"),

		settingsShell: document.getElementById("settings-shell"),
		settingsButton: document.getElementById("settings-button"),
		settingsClose: document.getElementById("settings-close-button"),

		targetSelect: document.getElementById("target-select"),
		targetInput: document.getElementById("target-input"),
		saveTarget: document.getElementById("save-target-button"),
		clearTarget: document.getElementById("clear-target-button"),

		launchPathInput: document.getElementById("launch-path-input"),
		tokenInput: document.getElementById("token-input"),
		saveToken: document.getElementById("save-token-button"),
		clearToken: document.getElementById("clear-token-button"),
		launchOmpHub: document.getElementById("launch-omp-hub-button"),
		launchColab: document.getElementById("launch-colab-button"),
		rememberToken: document.getElementById("remember-token-toggle"),
		audioToggle: document.getElementById("audio-toggle"),
		autoplayToggle: document.getElementById("autoplay-toggle"),
		liveModeToggle: document.getElementById("live-mode-toggle"),
		liveNoiseGateToggle: document.getElementById("live-noise-gate-toggle"),
		liveNoiseGateDb: document.getElementById("live-noise-gate-db"),

		setupStatus: document.getElementById("setup-status"),
		setupLink: document.getElementById("setup-link"),
		copySetup: document.getElementById("copy-setup-button"),
		onboardingToken: document.getElementById("onboarding-token-input"),
		onboardingRememberToken: document.getElementById("onboarding-remember-token-toggle"),
		onboardingSave: document.getElementById("onboarding-save-button"),

		tabBar: document.getElementById("tab-bar"),
		chat: document.querySelector(".chat"),
		sessionsPanel: document.getElementById("sessions-panel"),
		cancelTurn: document.getElementById("cancel-turn-button"),
		sessionCurrent: document.getElementById("session-current"),
		sessionReady: document.getElementById("session-ready"),
		sessionSlots: document.getElementById("session-slots"),
		sessionList: document.getElementById("session-list"),
		sessionActions: document.getElementById("session-actions"),
		selectedSessionName: document.getElementById("selected-session-name"),
		renameInput: document.getElementById("rename-input"),
		renameButton: document.getElementById("rename-button"),
		aliasButton: document.getElementById("alias-button"),
		removeButton: document.getElementById("remove-button"),
		eventLog: document.getElementById("event-log"),
		eventStatus: document.getElementById("event-status"),
		agentList: document.getElementById("agent-list"),
		refreshAgents: document.getElementById("refresh-agents-button"),
		workspaceEntries: document.getElementById("workspace-entries"),
		workspaceRoot: document.getElementById("workspace-root"),
		workspaceUp: document.getElementById("workspace-up"),
		workspaceUse: document.getElementById("workspace-use"),
		workspaceCurrentLabel: document.getElementById("workspace-current"),
		fileViewer: document.getElementById("file-viewer"),
		fileViewerTitle: document.getElementById("file-viewer-title"),
		fileViewerMeta: document.getElementById("file-viewer-meta"),
		fileViewerBody: document.getElementById("file-viewer-body"),
		fileViewerClose: document.getElementById("file-viewer-close"),
	};

	function hasToken() {
		return !!(state.token && String(state.token).trim());
	}

	function syncLockedUi() {
		const localAccess = isLoopbackHostname(window.location.hostname);
		const locked = !hasToken() && !localAccess;
		if (els.appRoot) els.appRoot.classList.toggle("locked", locked);
		if (els.setupBanner) els.setupBanner.classList.toggle("hidden", !locked);
		if (els.auth) els.auth.textContent = hasToken() ? "Token loaded" : localAccess ? "Local access" : "Token needed";
	}

	function syncDockInset() {
		if (!els.dock) return;
		const height = Math.max(120, Math.round(els.dock.getBoundingClientRect().height || 0));
		document.documentElement.style.setProperty("--dock-inset", `${height}px`);
	}

	function setStatus(text, tone) {
		if (els.statusNote) {
			els.statusNote.textContent = text;
			els.statusNote.style.color = tone === "error" ? "var(--danger)" : "var(--ink)";
		}
		if (els.statusDot) {
			els.statusDot.className = `status-dot${tone === "error" ? " error" : state.lastStatus ? " ready" : ""}`;
		}
		if (els.auth) {
			const localAccess = isLoopbackHostname(window.location.hostname);
			els.auth.textContent = tone === "error" ? "Connection issue" : hasToken() ? "Token loaded" : localAccess ? "Local access" : "Token needed";
		}
	}

	function formatElapsed(ms) {
		const totalSeconds = Math.floor(ms / 1000);
		const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
		const seconds = String(totalSeconds % 60).padStart(2, "0");
		return `${minutes}:${seconds}`;
	}

	function appendMessage(role, text) {
		if (!els.chatMessages || !text || !text.trim()) return;
		const isPinnedToBottom =
			els.chatMessages.scrollHeight - (els.chatMessages.scrollTop + els.chatMessages.clientHeight) < 64;
		const node = document.createElement("div");
		node.className = `message ${role}`;
		node.textContent = text.trim();
		els.chatMessages.appendChild(node);
		if (isPinnedToBottom) {
			els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
		}
	}

	function setTranscript(text) {
		appendMessage("user", text);
	}

	function setReplyText(text) {
		if (!text) return;
		if (els.reply) els.reply.textContent = text.trim() ? text.trim() : "No reply yet.";
		if (text && text.trim()) appendMessage("agent", text);
	}

	function renderTerminalApprovals() {
		if (!els.terminalApprovals) return;
		const approvals = Object.values(state.pendingTerminalApprovals);
		els.terminalApprovals.innerHTML = "";
		els.terminalApprovals.classList.toggle("hidden", approvals.length === 0);
		for (const approval of approvals) {
			const card = document.createElement("div");
			card.className = "approval-card";
			const body = document.createElement("div");
			body.className = "approval-body";
			const title = document.createElement("strong");
			title.textContent = "Terminal approval";
			const command = document.createElement("code");
			command.textContent = approval.command || "(unknown command)";
			const reason = document.createElement("span");
			reason.className = "muted";
			reason.textContent = approval.reason ? `Reason: ${approval.reason}` : "This command needs confirmation.";
			const context = document.createElement("span");
			context.className = "muted";
			context.textContent = [
				approval.cwd ? `CWD: ${approval.cwd}` : "",
				approval.timeoutMs ? `Timeout: ${approval.timeoutMs}ms` : "",
			].filter(Boolean).join(" - ");
			body.appendChild(title);
			body.appendChild(command);
			body.appendChild(reason);
			if (context.textContent) body.appendChild(context);
			const actions = document.createElement("div");
			actions.className = "approval-actions";
			const approve = document.createElement("button");
			approve.type = "button";
			approve.textContent = "Approve";
			approve.addEventListener("click", () => sendTerminalApproval(approval.approvalId, true));
			const reject = document.createElement("button");
			reject.type = "button";
			reject.className = "secondary";
			reject.textContent = "Reject";
			reject.addEventListener("click", () => sendTerminalApproval(approval.approvalId, false));
			actions.appendChild(approve);
			actions.appendChild(reject);
			card.appendChild(body);
			card.appendChild(actions);
			els.terminalApprovals.appendChild(card);
		}
	}

	function rememberTerminalApproval(message) {
		if (!message || !message.approvalId) return;
		let parsed = {};
		if (message.output) {
			try { parsed = JSON.parse(message.output); } catch {}
		}
		state.pendingTerminalApprovals[message.approvalId] = {
			approvalId: message.approvalId,
			command: message.command || parsed.command || "",
			reason: message.reason || parsed.reason || "",
			cwd: message.cwd || parsed.cwd || "",
			timeoutMs: message.timeoutMs || parsed.timeoutMs || 0,
		};
		renderTerminalApprovals();
		appendMessage("system", `Approval needed: ${message.command || parsed.command || "terminal command"}`);
		setStatus("Terminal approval needed.");
	}

	function clearTerminalApproval(approvalId) {
		if (!approvalId) return;
		delete state.pendingTerminalApprovals[approvalId];
		renderTerminalApprovals();
	}

	function setRecordingStateBusy(isBusy) {
		state.turnInProgress = isBusy;
		if (els.sendText) els.sendText.disabled = !!isBusy;
		if (els.record) els.record.disabled = !!isBusy;
		if (els.cancelTurn) els.cancelTurn.classList.toggle("hidden", !isBusy);
		updateRecordingUi();
	}

	function setPlayReplyButton(isVisible, disabled = false) {
		if (!els.playReply) return;
		els.playReply.classList.toggle("hidden", !isVisible);
		els.playReply.disabled = !!disabled;
	}

	/* -------- Tabs -------- */
	function switchTab(tab) {
		state.activeTab = tab;
		if (els.chat) els.chat.classList.toggle("hidden", tab !== "chat");
		if (els.sessionsPanel) els.sessionsPanel.classList.toggle("open", tab === "sessions");
		if (els.tabBar) {
			for (const btn of els.tabBar.querySelectorAll(".tab")) {
				btn.classList.toggle("active", btn.dataset.tab === tab);
			}
		}
		if (tab === "sessions") {
			loadSessions();
			loadAgents();
			renderWorkspace(state.workspacePath);
			startEventStream();
		}
	}

	/* -------- Sessions -------- */
	async function loadSessions() {
		try {
			const [dash, slots] = await Promise.all([
				apiFetch("/v1/sessions"),
				apiFetch("/v1/sessions/slots"),
			]);
			renderDashboard(dash && dash.dashboard ? dash.dashboard : {});
			renderSlots(slots && slots.slots ? slots.slots : []);
		} catch (error) {
			if (els.sessionCurrent) els.sessionCurrent.textContent = String(error.message || error);
		}
	}

	function renderDashboard(dashboard) {
		if (els.sessionCurrent) els.sessionCurrent.textContent = dashboard.current || "none";
		if (els.sessionReady) els.sessionReady.textContent = `Ready: ${dashboard.ready && dashboard.ready.length ? dashboard.ready.join(", ") : "none"}`;
		const list = els.sessionList;
		if (!list) return;
		list.innerHTML = "";
		const sessions = Array.isArray(dashboard.sessions) ? dashboard.sessions : [];
		if (sessions.length === 0) {
			list.textContent = "No sessions.";
			return;
		}
		for (const entry of sessions) {
			const row = document.createElement("div");
			row.className = "session-row";
			if (entry.sessionPath && entry.sessionPath === state.selectedSessionPath) {
				row.classList.add("selected");
			}
			const name = document.createElement("span");
			name.className = "session-main";
			const nameText = document.createElement("span");
			nameText.className = "session-name";
			nameText.textContent = entry.name || "(unnamed)";
			const cwd = document.createElement("span");
			cwd.className = "session-cwd";
			cwd.textContent = `Working directory: ${entry.workingDirectory || entry.cwd || "unknown"}`;
			name.appendChild(nameText);
			name.appendChild(cwd);
			const badges = document.createElement("div");
			badges.style.display = "flex";
			badges.style.gap = "4px";
			if (entry.current) {
				const b = document.createElement("span");
				b.className = "status-badge current";
				b.textContent = "current";
				badges.appendChild(b);
			}
			if (entry.ready) {
				const b = document.createElement("span");
				b.className = "status-badge ready";
				b.textContent = "ready";
				badges.appendChild(b);
			}
			const activity = document.createElement("span");
			activity.className = "status-badge";
			activity.textContent = entry.activity || "saved";
			if (entry.activity === "busy") activity.classList.add("busy");
			badges.appendChild(activity);
			const aliases = document.createElement("span");
			aliases.className = "muted";
			aliases.style.fontSize = "11px";
			aliases.textContent = entry.aliases && entry.aliases.length ? entry.aliases.join(", ") : "";
			row.appendChild(name);
			row.appendChild(badges);
			row.appendChild(aliases);
			row.addEventListener("click", () => {
				state.selectedSessionPath = entry.sessionPath || "";
				renderDashboard(dashboard);
				if (els.sessionActions) {
					els.sessionActions.classList.remove("hidden");
					if (els.selectedSessionName) els.selectedSessionName.textContent = entry.name || "(unnamed)";
					if (els.renameInput) els.renameInput.value = "";
				}
			});
			list.appendChild(row);
		}
	}

	function renderSlots(slots) {
		if (!els.sessionSlots) return;
		if (!slots.length) {
			els.sessionSlots.textContent = "No route slots.";
			return;
		}
		els.sessionSlots.innerHTML = "";
		for (const slot of slots) {
			const line = document.createElement("div");
			line.style.fontSize = "13px";
			line.textContent = `PK${slot.family}: ${slot.status}${slot.sessionName ? ` → ${slot.sessionName}` : ""}${slot.labels && slot.labels.length ? ` (${slot.labels.join(", ")})` : ""}`;
			els.sessionSlots.appendChild(line);
		}
	}

	/* -------- Agents -------- */
	async function loadAgents() {
		try {
			const payload = await apiFetch("/v1/agents");
			state.discoveredAgents = payload && Array.isArray(payload.agents) ? payload.agents : [];
			state.runningAgents = payload && Array.isArray(payload.running) ? payload.running : [];
			state.recentAgentSessions = payload && Array.isArray(payload.recent) ? payload.recent : [];
			state.agentSnapshotAt = payload && typeof payload.generatedAt === "string" ? payload.generatedAt : "";
			renderAgents();
		} catch (error) {
			if (els.agentList) els.agentList.textContent = String(error.message || error);
		}
	}

	function appendOrUpdateLiveReply(text) {
		if (!els.chatMessages || !text) return;
		state.liveReplyBuffer += text;
		if (!state.liveAgentMessage || !els.chatMessages.contains(state.liveAgentMessage)) {
			state.liveAgentMessage = document.createElement("div");
			state.liveAgentMessage.className = "message agent";
			els.chatMessages.appendChild(state.liveAgentMessage);
		}
		state.liveAgentMessage.textContent = state.liveReplyBuffer.trim();
		els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
		if (els.reply) els.reply.textContent = state.liveReplyBuffer.trim() || "No reply yet.";
	}

	function scheduleLiveTurnSettled() {
		if (state.liveSettleTimer) window.clearTimeout(state.liveSettleTimer);
		state.liveSettleTimer = window.setTimeout(() => {
			state.liveSettleTimer = null;
			state.liveTurnInProgress = false;
			setRecordingStateBusy(false);
			setStatus("Live turn complete.");
		}, 1500);
	}

	function renderAgents() {
		if (!els.agentList) return;
		if (!state.discoveredAgents.length && !state.runningAgents.length && !state.recentAgentSessions.length) {
			els.agentList.textContent = "No agents discovered.";
			return;
		}
		els.agentList.innerHTML = "";
		if (state.agentSnapshotAt) {
			const stamp = document.createElement("div");
			stamp.className = "muted";
			stamp.style.fontSize = "11px";
			stamp.textContent = `Updated ${new Date(state.agentSnapshotAt).toLocaleTimeString()}`;
			els.agentList.appendChild(stamp);
		}
		const running = state.runningAgents.length
			? state.runningAgents
			: state.discoveredAgents.map((target) => ({ target, provider: target.split(":")[0] || "agent" }));
		if (running.length) {
			const title = document.createElement("div");
			title.className = "agent-section-title";
			title.textContent = "Running";
			els.agentList.appendChild(title);
			for (const agent of running) {
				els.agentList.appendChild(renderAgentRow(agent));
			}
		}
		if (state.recentAgentSessions.length) {
			const title = document.createElement("div");
			title.className = "agent-section-title";
			title.textContent = "Recent session files";
			els.agentList.appendChild(title);
			for (const session of state.recentAgentSessions.slice(0, 12)) {
				els.agentList.appendChild(renderRecentAgentRow(session));
			}
		}
	}

	function renderAgentRow(agent) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "agent-row";
		const title = document.createElement("span");
		title.className = "agent-row-title";
		title.textContent = agent.target || `${agent.provider || "agent"}:${agent.pid || "?"}`;
		const meta = document.createElement("span");
		meta.className = "agent-row-meta";
		const details = [];
		if (agent.cwd) details.push(agent.cwd);
		else if (agent.cwdBasename) details.push(agent.cwdBasename);
		if (agent.startedAt) details.push(`started ${new Date(agent.startedAt).toLocaleTimeString()}`);
		meta.textContent = details.join(" | ") || "No working path reported.";
		row.appendChild(title);
		row.appendChild(meta);
		row.addEventListener("click", () => {
			if (agent.target) {
				if (els.targetSelect) els.targetSelect.value = agent.target;
				if (els.targetInput) els.targetInput.value = agent.target;
				setStatus(`Route target selected: ${agent.target}`);
			}
			if (agent.cwd && els.launchPathInput) {
				els.launchPathInput.value = agent.cwd;
				state.launchPath = agent.cwd;
				saveSettings();
			}
		});
		return row;
	}

	function renderRecentAgentRow(session) {
		const row = document.createElement(session.cwd ? "button" : "div");
		if (session.cwd) row.type = "button";
		row.className = `agent-row${session.cwd ? "" : " readonly"}`;
		const title = document.createElement("span");
		title.className = "agent-row-title";
		title.textContent = session.cwdBasename
			? `${session.provider || "agent"}: ${session.cwdBasename}`
			: `${session.provider || "agent"}: ${session.title || session.sessionId || "(untitled)"}`;
		const meta = document.createElement("span");
		meta.className = "agent-row-meta";
		const bits = [];
		if (session.cwd) bits.push(session.cwd);
		if (session.updatedAt) bits.push(new Date(session.updatedAt).toLocaleString());
		if (session.path) bits.push(session.path);
		meta.textContent = bits.join(" | ");
		row.appendChild(title);
		row.appendChild(meta);
		if (session.cwd) {
			row.addEventListener("click", () => {
				if (els.launchPathInput) els.launchPathInput.value = session.cwd;
				state.launchPath = session.cwd;
				saveSettings();
				setStatus(`Launch path selected: ${session.cwd}`);
			});
		}
		return row;
	}

	/* -------- Event Stream (SSE) -------- */
	function startEventStream() {
		if (state.eventSource) return;
		if (!els.eventLog || !els.eventStatus) return;
		const url = new URL("/v1/events", window.location.origin);
		url.searchParams.set("since", String(state.eventLog.length));
		if (state.token) url.searchParams.set("token", state.token);
		const es = new EventSource(url.toString());
		state.eventSource = es;
		es.onopen = () => {
			if (els.eventStatus) els.eventStatus.className = "status-dot ready";
		};
		es.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				state.eventLog.push(data);
				if (state.eventLog.length > 50) state.eventLog.shift();
				renderEvent(data);
			} catch {}
		};
		es.onerror = () => {
			if (els.eventStatus) els.eventStatus.className = "status-dot error";
			stopEventStream();
			setTimeout(startEventStream, 3000);
		};
	}

	function stopEventStream() {
		if (state.eventSource) {
			state.eventSource.close();
			state.eventSource = null;
		}
	}

	function renderEvent(event) {
		if (!els.eventLog) return;
		const node = document.createElement("div");
		node.className = "event-item";
		const meta = document.createElement("div");
		meta.className = "event-meta";
		const ts = typeof event.ts === "number" ? new Date(event.ts).toLocaleTimeString() : "";
		meta.textContent = `${ts} · ${event.source || "?"} · ${event.kind || "?"}`;
		const body = document.createElement("div");
		body.textContent = JSON.stringify(event.payload || {});
		node.appendChild(meta);
		node.appendChild(body);
		els.eventLog.appendChild(node);
		els.eventLog.scrollTop = els.eventLog.scrollHeight;
	}

	/* -------- Workspace Browser -------- */
	function formatBytes(n) {
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	async function renderWorkspace(path) {
		if (!els.workspaceEntries) return;
		state.workspacePath = path || "";
		els.workspaceEntries.textContent = "Loading…";
		try {
			const payload = await apiFetch(`/v1/workspace?path=${encodeURIComponent(path || "")}`);
			const ws = payload && payload.workspace ? payload.workspace : {};
			// Seed the browser to the agent working directory once on first open so a
			// broadened PI_SPEAK_WORKSPACE_ROOT still lands in the project. Later "Root"
			// navigations (path "") must still reach the real root, so this runs once.
			if (!state.workspaceInitialized) {
				state.workspaceInitialized = true;
				if (!path && ws.defaultPath && ws.defaultPath !== ws.current) {
					return renderWorkspace(ws.defaultPath);
				}
			}
			state.workspaceCurrent = ws.current || "";
			state.workspaceParent = ws.parent || "";
			state.workspacePath = ws.current || path || "";
			if (els.workspaceCurrentLabel) els.workspaceCurrentLabel.textContent = ws.current || "—";
			if (els.workspaceUp) els.workspaceUp.disabled = !ws.parent;
			if (els.workspaceUse) els.workspaceUse.disabled = !state.workspaceCurrent;
			const entries = Array.isArray(ws.entries) ? ws.entries : [];
			els.workspaceEntries.innerHTML = "";
			if (entries.length === 0) {
				els.workspaceEntries.textContent = "Empty folder.";
			}
			for (const entry of entries) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "workspace-entry";
				if (entry.type === "directory") {
					button.classList.add("is-directory");
					button.textContent = `📁 ${entry.name}`;
					button.addEventListener("click", () => renderWorkspace(entry.path));
				} else {
					button.classList.add("is-file");
					const name = document.createElement("span");
					name.className = "workspace-entry-name";
					name.textContent = `📄 ${entry.name}`;
					const size = document.createElement("span");
					size.className = "workspace-entry-size";
					size.textContent = formatBytes(entry.size);
					button.appendChild(name);
					button.appendChild(size);
					button.addEventListener("click", () => openFileViewer(entry.path, entry.name));
				}
				els.workspaceEntries.appendChild(button);
			}
			if (ws.truncated) {
				const note = document.createElement("div");
				// .muted (not .workspace-current) so the full message wraps instead of
				// being clipped by ellipsis truncation.
				note.className = "muted";
				note.textContent = "Showing first 2000 entries — open a narrower folder to see the rest.";
				els.workspaceEntries.appendChild(note);
			}
		} catch (error) {
			els.workspaceEntries.textContent = String(error.message || error);
			// Reset chrome so actionable controls don't contradict the error state.
			state.workspaceCurrent = "";
			state.workspaceParent = "";
			if (els.workspaceCurrentLabel) els.workspaceCurrentLabel.textContent = "—";
			if (els.workspaceUp) els.workspaceUp.disabled = true;
			if (els.workspaceUse) els.workspaceUse.disabled = true;
		}
	}

	async function openFileViewer(path, name) {
		if (!els.fileViewer) return;
		setStatus("Opening file…");
		try {
			const payload = await apiFetch(`/v1/workspace/file?path=${encodeURIComponent(path)}`);
			const file = payload && payload.file ? payload.file : {};
			if (els.fileViewerTitle) els.fileViewerTitle.textContent = file.name || name || "File";
			if (els.fileViewerMeta) {
				let meta = `${formatBytes(file.size)} · ${file.path || path}`;
				if (file.binary) meta += " · binary";
				if (file.truncated) meta += " · truncated (showing first 512 KB)";
				els.fileViewerMeta.textContent = meta;
			}
			if (els.fileViewerBody) {
				els.fileViewerBody.textContent = file.binary
					? "Binary file — preview not available."
					: file.content || "";
				els.fileViewerBody.scrollTop = 0;
			}
			// Save the trigger so focus can return when the dialog closes.
			state.fileViewerReturnFocus = document.activeElement;
			els.fileViewer.classList.remove("hidden");
			// #file-viewer is a sibling of #app-root, so making the app inert/aria-hidden
			// hides everything behind the dialog without hiding the dialog itself.
			if (els.appRoot) {
				els.appRoot.inert = true;
				els.appRoot.setAttribute("aria-hidden", "true");
			}
			document.body.style.overflow = "hidden";
			els.fileViewerClose?.focus();
		} catch (error) {
			setStatus(String(error.message || error), "error");
		}
	}

	function closeFileViewer() {
		if (!els.fileViewer) return;
		els.fileViewer.classList.add("hidden");
		if (els.appRoot) {
			els.appRoot.inert = false;
			els.appRoot.removeAttribute("aria-hidden");
		}
		document.body.style.overflow = "";
		const returnFocus = state.fileViewerReturnFocus;
		state.fileViewerReturnFocus = null;
		if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) {
			returnFocus.focus();
		}
	}

	/* -------- Session Mutations -------- */
	async function doSessionRename() {
		if (!els.renameInput || !state.selectedSessionPath) return;
		const newName = els.renameInput.value.trim();
		if (!newName) return;
		try {
			const result = await apiFetch("/v1/sessions/rename", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionPath: state.selectedSessionPath, newName }),
			});
			setStatus(result.message || "Renamed.");
			loadSessions();
		} catch (error) {
			setStatus(String(error.message || error), "error");
		}
	}

	async function doSessionAlias() {
		if (!els.renameInput || !state.selectedSessionPath) return;
		const alias = els.renameInput.value.trim();
		if (!alias) return;
		try {
			const result = await apiFetch("/v1/sessions/alias", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionPath: state.selectedSessionPath, alias }),
			});
			setStatus(result.message || "Aliased.");
			loadSessions();
		} catch (error) {
			setStatus(String(error.message || error), "error");
		}
	}

	async function doSessionRemove() {
		if (!state.selectedSessionPath) return;
		if (!confirm("Remove routing for this session?")) return;
		try {
			const result = await apiFetch("/v1/sessions/remove", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionPath: state.selectedSessionPath }),
			});
			setStatus(result.message || "Removed.");
			state.selectedSessionPath = "";
			if (els.sessionActions) els.sessionActions.classList.add("hidden");
			loadSessions();
		} catch (error) {
			setStatus(String(error.message || error), "error");
		}
	}

	function getSessionStorage() {
		return window.sessionStorage;
	}

	function getLocalStorage() {
		return window.localStorage;
	}

	function syncRouteUi(status) {
		if (!els.targetSelect) return;
		const remote = status && status.remote ? status.remote : {};
		const targets = Array.isArray(remote.availableTargets) ? remote.availableTargets : [];
		const selected = remote.defaultTarget || "";
		const currentSession = remote.currentSession || "Current session";
		const routeLabel = selected || `Current session`;

		els.targetSelect.innerHTML = "";
		const current = document.createElement("option");
		current.value = "";
		current.textContent = currentSession;
		els.targetSelect.appendChild(current);
		for (const target of targets) {
			const option = document.createElement("option");
			option.value = target;
			option.textContent = target;
			els.targetSelect.appendChild(option);
		}
		if (selected && !targets.includes(selected)) {
			const option = document.createElement("option");
			option.value = selected;
			option.textContent = selected;
			els.targetSelect.appendChild(option);
		}
		els.targetSelect.value = selected || "";
		if (els.targetInput) els.targetInput.value = selected || "";
		if (els.routePill) els.routePill.textContent = `Route: ${routeLabel}`;
	}

	function getSetupHint(status) {
		if (!els.setupStatus) return;
		const remote = status && status.remote ? status.remote : {};
		const running = remote.enabled ? "running" : "not running";
		if (!remote.enabled) {
			els.setupStatus.textContent = "Start the remote gateway first: run /remote on, then /remote setup.";
			return;
		}
		const tokenHint = state.token ? "set" : "not set";
		const authHint = remote.authRequired ? "required" : "optional";
		els.setupStatus.textContent = `Gateway is ${running}. Auth is ${authHint}, token is ${tokenHint}.`;
	}

	function syncSettingsUi() {
		if (els.audioToggle) els.audioToggle.checked = state.wantAudio;
		if (els.autoplayToggle) els.autoplayToggle.checked = state.autoplay;
		if (els.liveModeToggle) els.liveModeToggle.checked = state.liveMode;
		if (els.liveNoiseGateToggle) els.liveNoiseGateToggle.checked = state.liveNoiseGateEnabled;
		if (els.liveNoiseGateDb) els.liveNoiseGateDb.value = String(state.liveNoiseGateDb);
		if (els.rememberToken) els.rememberToken.checked = state.rememberToken;
		if (els.launchPathInput) els.launchPathInput.value = state.launchPath;
		if (els.targetInput) els.targetInput.value = activeTarget() || "";
		if (els.tokenInput) els.tokenInput.value = state.token;
		if (els.onboardingToken) els.onboardingToken.value = state.token;
		if (els.onboardingRememberToken) els.onboardingRememberToken.checked = state.rememberToken;
		if (els.setupLink) els.setupLink.textContent = `${window.location.origin}${window.location.pathname}`;
		if (els.agentPill) {
			const status = state.lastStatus;
			const provider = status?.agent?.provider || status?.agent?.configuredProvider || "unknown";
			els.agentPill.textContent = `Agent: ${provider}`;
		}
	}

	function activeTarget() {
		const selected = els.targetSelect ? els.targetSelect.value.trim() : "";
		const manual = els.targetInput ? els.targetInput.value.trim() : "";
		return selected || manual || "";
	}

	function loadSettings() {
		const query = new URL(window.location.href).searchParams;
		const queryToken = query.get("token");
		const queryLaunchPath = query.get("cwd") || query.get("launchPath");
		state.rememberToken = getLocalStorage().getItem(STORAGE_REMEMBER) === "true";
		state.token =
			queryToken ||
			getSessionStorage().getItem(STORAGE_TOKEN) ||
			getLocalStorage().getItem(STORAGE_TOKEN) ||
			"";
		state.launchPath =
			queryLaunchPath ||
			getSessionStorage().getItem(STORAGE_LAUNCH_PATH) ||
			getLocalStorage().getItem(STORAGE_LAUNCH_PATH) ||
			"";
		state.wantAudio = (getLocalStorage().getItem(STORAGE_AUDIO) || "true") !== "false";
		state.autoplay = (getLocalStorage().getItem(STORAGE_AUTOPLAY) || "true") !== "false";
		const queryMode = query.get("mode");
		state.liveMode = queryMode ? queryMode.toLowerCase() === "live" : getLocalStorage().getItem(STORAGE_LIVE_MODE) === "true";
		state.liveNoiseGateEnabled = (getLocalStorage().getItem(STORAGE_LIVE_GATE) || "true") !== "false";
		const gateDb = Number.parseFloat(getLocalStorage().getItem(STORAGE_LIVE_GATE_DB) || "-50");
		state.liveNoiseGateDb = Number.isFinite(gateDb) ? Math.min(-3, Math.max(-66, gateDb)) : -50;
		if (state.liveMode) state.wantAudio = true;
		if (queryToken) {
			getSessionStorage().setItem(STORAGE_TOKEN, queryToken);
			if (state.rememberToken) {
				getLocalStorage().setItem(STORAGE_TOKEN, queryToken);
			}
			const cleaned = new URL(window.location.href);
			cleaned.searchParams.delete("token");
			window.history.replaceState({}, "", cleaned.pathname + cleaned.search + cleaned.hash);
		}
		if (queryLaunchPath) {
			const cleaned = new URL(window.location.href);
			cleaned.searchParams.delete("cwd");
			cleaned.searchParams.delete("launchPath");
			cleaned.searchParams.delete("launch");
			window.history.replaceState({}, "", cleaned.pathname + cleaned.search + cleaned.hash);
		}
		syncSettingsUi();
	}

	function saveSettings() {
		if (state.token) {
			getSessionStorage().setItem(STORAGE_TOKEN, state.token);
			if (state.rememberToken) {
				getLocalStorage().setItem(STORAGE_TOKEN, state.token);
			} else {
				getLocalStorage().removeItem(STORAGE_TOKEN);
			}
		} else {
			getSessionStorage().removeItem(STORAGE_TOKEN);
			getLocalStorage().removeItem(STORAGE_TOKEN);
		}
		if (state.launchPath) {
			getLocalStorage().setItem(STORAGE_LAUNCH_PATH, state.launchPath);
		} else {
			getLocalStorage().removeItem(STORAGE_LAUNCH_PATH);
		}
		getLocalStorage().setItem(STORAGE_REMEMBER, String(state.rememberToken));
		getLocalStorage().setItem(STORAGE_AUDIO, String(state.wantAudio));
		getLocalStorage().setItem(STORAGE_LIVE_MODE, String(state.liveMode));
		getLocalStorage().setItem(STORAGE_AUTOPLAY, String(state.autoplay));
		getLocalStorage().setItem(STORAGE_LIVE_GATE, String(state.liveNoiseGateEnabled));
		getLocalStorage().setItem(STORAGE_LIVE_GATE_DB, String(state.liveNoiseGateDb));
		syncSettingsUi();
	}

	async function apiFetch(path, options = {}) {
		const headers = new Headers(options.headers || {});
		if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
		const response = await fetch(path, { ...options, headers });
		let payload = null;
		const contentType = response.headers.get("content-type") || "";
		if (contentType.includes("application/json")) {
			payload = await response.json().catch(() => null);
		}
		if (response.status === 401) {
			if (els.auth) els.auth.textContent = "Token required";
			throw new Error("Unauthorized. Save the remote token in Settings.");
		}
		if (!response.ok) {
			throw new Error(payload && (payload.error || payload.message) ? payload.error || payload.message : `Request failed (${response.status})`);
		}
		if (els.auth) els.auth.textContent = state.token ? "Token loaded" : "Local access";
		return payload;
	}

	function summarizeStatus(status) {
		if (!status) return "Connected.";
		const remote = status.remote || {};
		const agent = status.agent || {};
		const speak = status.speak || {};
		const mono = status.mono || {};
		const phone = status.phone || {};
		const speakLabel = speak.enabled ? (speak.provider || speak.configuredProvider || "on") : "off";
		const monoLabel = mono.running ? (mono.voiceInputActive ? "active" : "standby") : "off";
		const phoneLabel = phone.enabled ? (phone.linkedChatId ? "linked" : "waiting for pair code") : "off";
		return `Remote ${remote.enabled ? "running" : "stopped"} on port ${remote.port || 8767}. Agent: ${agent.provider || "unknown"} - speak ${speakLabel} - mono ${monoLabel} - phone ${phoneLabel}.`;
	}

	async function refreshStatus() {
		try {
			const payload = await apiFetch("/v1/status");
			state.lastStatus = payload ? payload.status : null;
			syncRouteUi(state.lastStatus);
			syncSettingsUi();
			getSetupHint(state.lastStatus);
			setStatus(state.liveMode && state.liveConnected
				? state.recording ? "Live conversation connected — mic is on." : "Live session connected. Tap to turn the mic on."
				: summarizeStatus(state.lastStatus));
			syncLockedUi();
		} catch (error) {
			setStatus(String(error.message || error), "error");
			syncLockedUi();
		}
	}

	function turnStatusMessage(payload, fallback = "Turn complete.") {
		const warnings = Array.isArray(payload && payload.warnings) ? payload.warnings.filter(Boolean) : [];
		const providers = payload && payload.providers ? payload.providers : {};
		const providerBits = [];
		if (providers.agent) providerBits.push(`agent ${providers.agent}`);
		if (providers.tts) providerBits.push(`tts ${providers.tts}`);
		if (providers.stt) providerBits.push(`stt ${providers.stt}`);
		const provider = providerBits.length ? ` [${providerBits.join(", ")}]` : "";
		return warnings.length ? `${fallback}${provider} ${warnings.join(" ")}` : `${fallback}${provider}`;
	}

	function setAudio(url, options = {}) {
		const {
			turnStartedAt = 0,
			payload = {},
			onPlaybackStarted,
			onReady,
			onPlaybackFailed,
		} = options;
		if (!url) {
			if (els.audio) {
				els.audio.pause();
				els.audio.removeAttribute("src");
				if (els.audio.dataset.objectUrl) {
					URL.revokeObjectURL(els.audio.dataset.objectUrl);
					delete els.audio.dataset.objectUrl;
				}
				els.audio.classList.add("hidden");
			}
			setPlayReplyButton(false);
			if (els.audioControlsWrapper) els.audioControlsWrapper.classList.add("hidden");
			onReady?.(undefined);
			return;
		}

		const audioUrl = new URL(url, window.location.origin);
		const headers = new Headers();
		if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
		if (els.audioControlsWrapper) els.audioControlsWrapper.classList.remove("hidden");
		if (els.audio) els.audio.classList.add("hidden");
		setPlayReplyButton(false);
		fetch(audioUrl, { headers })
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`Audio request failed (${response.status})`);
				}
				const blob = await response.blob();
				if (els.audio?.dataset.objectUrl) {
					URL.revokeObjectURL(els.audio.dataset.objectUrl);
				}
				const objectUrl = URL.createObjectURL(blob);
				if (els.audio) {
					els.audio.dataset.objectUrl = objectUrl;
					els.audio.src = objectUrl;
					els.audio.classList.remove("hidden");
				}
				setPlayReplyButton(true, false);
				const tts = payload && payload.providers && payload.providers.tts;
				const source = tts ? ` (${tts})` : "";
				if (!state.autoplay) {
					if (els.statusNote) els.statusNote.textContent = `Reply audio ready${source}. Tap play to hear it.`;
					onReady?.(undefined);
					return;
				}
				let resolved = false;
				let playbackWatchdog;
				const finalize = (playbackMs) => {
					if (resolved) return;
					resolved = true;
					if (playbackWatchdog) window.clearTimeout(playbackWatchdog);
					if (playbackMs !== undefined && els.statusNote) {
						els.statusNote.textContent = `Playback started${source} (${Math.max(0, playbackMs).toFixed(0)}ms).`;
					} else if (els.statusNote) {
						els.statusNote.textContent = `Reply ready${source}.`;
					}
					onPlaybackStarted?.(playbackMs);
					onReady?.(playbackMs);
				};
				els.audio.addEventListener("playing", () => {
					const playbackMs = turnStartedAt ? Date.now() - turnStartedAt : undefined;
					finalize(playbackMs);
				}, { once: true });
				els.audio.addEventListener("play", () => {
					const playbackMs = turnStartedAt ? Date.now() - turnStartedAt : undefined;
					finalize(playbackMs);
				}, { once: true });
				playbackWatchdog = window.setTimeout(() => {
					if (!resolved) {
						finalize();
					}
				}, 2000);
				els.audio.play().catch((error) => {
					if (els.statusNote) els.statusNote.textContent = "Reply ready. Tap play if autoplay is blocked.";
					onPlaybackFailed?.(String(error.message || error));
					finalize();
				});
			})
			.catch((error) => {
				if (els.audio) {
					els.audio.classList.add("hidden");
					els.audio.removeAttribute("src");
				}
				if (els.statusNote) els.statusNote.textContent = String(error.message || error);
				setPlayReplyButton(false);
				onReady?.(undefined);
			});
	}

	function playReplyAudio() {
		if (!els.audio || !els.audio.src) {
			setStatus("No reply audio available.", "error");
			return;
		}
		els.audio.play().catch((error) => {
			if (els.statusNote) els.statusNote.textContent = "Unable to play reply audio.";
			setStatus(String(error.message || error), "error");
		});
	}

	function ensureLiveAudioContext() {
		if (state.liveAudioContext && state.liveAudioContext.state !== "closed") return state.liveAudioContext;
		const AudioContextClass = window.AudioContext || window.webkitAudioContext;
		if (!AudioContextClass) throw new Error("This browser does not support realtime audio playback.");
		state.liveAudioContext = new AudioContextClass({ latencyHint: "interactive" });
		state.liveAudioWorkletReady = false;
		state.livePlaybackReady = false;
		state.livePlaybackCursor = 0;
		return state.liveAudioContext;
	}

	async function ensureLiveWorklets(context) {
		if (!state.liveAudioWorkletReady) {
			await Promise.all([
				context.audioWorklet.addModule("/app/live-capture-worklet.js"),
				context.audioWorklet.addModule("/app/live-playback-worklet.js"),
			]);
			state.liveAudioWorkletReady = true;
		}
		if (!state.livePlaybackNode) {
			const playback = new AudioWorkletNode(context, "pi-speak-live-playback", {
				numberOfInputs: 0,
				numberOfOutputs: 1,
				outputChannelCount: [1],
			});
			playback.port.postMessage({ kind: "config", inputRate: state.livePlaybackSampleRate || 24_000 });
			playback.connect(context.destination);
			state.livePlaybackNode = playback;
			state.livePlaybackReady = true;
		}
	}

	function applyLiveNoiseGate() {
		if (!state.liveCaptureNode) return;
		state.liveCaptureNode.port.postMessage({
			kind: "gate",
			enabled: !!state.liveNoiseGateEnabled,
			thresholdDb: Number.isFinite(state.liveNoiseGateDb) ? state.liveNoiseGateDb : -50,
		});
	}

	function setLiveMicEnabled(enabled) {
		if (!state.liveCaptureNode) return;
		state.liveCaptureNode.port.postMessage({ kind: "enable", value: !!enabled });
	}

	function stopLivePlayback() {
		state.livePlaybackGeneration += 1;
		// HF methodology: wipe the playback worklet queue immediately on barge-in.
		if (state.livePlaybackNode) {
			try { state.livePlaybackNode.port.postMessage({ kind: "clear" }); } catch {}
		}
		for (const source of state.livePlaybackSources) {
			try { source.stop(); } catch {}
		}
		state.livePlaybackSources.clear();
		state.livePlaybackCursor = state.liveAudioContext?.currentTime || 0;
		if (state.liveState === "ai-speaking") state.liveState = "listening";
	}

	async function playLiveAudioFrame(data) {
		const generation = state.livePlaybackGeneration;
		const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
		const decoded = decodeLivePcmFrame(bytes);
		if (!decoded || decoded.samples.length === 0) return;
		state.liveLastServerSequenceId = Math.max(state.liveLastServerSequenceId, decoded.sequenceId);
		if (generation !== state.livePlaybackGeneration) return;
		const context = ensureLiveAudioContext();
		if (context.state === "suspended") await context.resume().catch(() => {});
		await ensureLiveWorklets(context);
		if (generation !== state.livePlaybackGeneration) return;

		if (state.livePlaybackNode) {
			// Prefer the HF ring-buffer worklet (click-free clear + upsample).
			const copy = new Float32Array(decoded.samples.length);
			copy.set(decoded.samples);
			state.livePlaybackNode.port.postMessage({ kind: "audio", samples: copy }, [copy.buffer]);
			state.liveState = "ai-speaking";
			return;
		}

		// Fallback: scheduled BufferSource (pre-worklet browsers).
		const buffer = context.createBuffer(1, decoded.samples.length, state.livePlaybackSampleRate || 24_000);
		buffer.copyToChannel(decoded.samples, 0);
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(context.destination);
		const startAt = Math.max(context.currentTime + 0.025, state.livePlaybackCursor);
		state.livePlaybackCursor = startAt + buffer.duration;
		state.livePlaybackSources.add(source);
		source.addEventListener("ended", () => state.livePlaybackSources.delete(source), { once: true });
		source.start(startAt);
		state.liveState = "ai-speaking";
	}

	function stopLiveCapture({ releaseStream = true } = {}) {
		state.liveCaptureEpoch += 1;
		state.liveCaptureStarting = false;
		if (state.liveCaptureNode) {
			state.liveCaptureNode.port.onmessage = null;
			try { state.liveCaptureNode.disconnect(); } catch {}
		}
		try { state.liveCaptureSource?.disconnect(); } catch {}
		try { state.liveCaptureSink?.disconnect(); } catch {}
		state.liveCaptureNode = null;
		state.liveCaptureSource = null;
		state.liveCaptureSink = null;
		state.recording = false;
		state.liveMicLevel = 0;
		window.clearInterval(state.timerId);
		state.timerId = null;
		if (releaseStream && state.stream) {
			for (const track of state.stream.getTracks()) track.stop();
			state.stream = null;
			state.mediaRecorder = null;
		}
		if (els.record) els.record.disabled = !!state.turnInProgress;
		ensureTimerState();
	}

	function closeLiveSocket() {
		stopLiveCapture({ releaseStream: true });
		stopLivePlayback();
		if (state.livePlaybackNode) {
			try { state.livePlaybackNode.disconnect(); } catch {}
			state.livePlaybackNode = null;
			state.livePlaybackReady = false;
		}
		if (state.liveCameraStream) {
			for (const track of state.liveCameraStream.getTracks()) track.stop();
			state.liveCameraStream = null;
			state.liveCameraEnabled = false;
		}
		state.liveConnected = false;
		state.liveSessionId = "";
		state.liveLastServerSequenceId = 0;
		state.liveReconnectAttempts = 0;
		state.liveState = "idle";
		window.clearTimeout(state.liveReconnectTimer);
		state.liveReconnectTimer = null;
		window.clearTimeout(state.liveStableTimer);
		state.liveStableTimer = null;
		if (state.liveTurnInProgress) {
			window.clearTimeout(state.liveSettleTimer);
			state.liveSettleTimer = null;
			state.liveTurnInProgress = false;
			setRecordingStateBusy(false);
		}
		const socket = state.liveSocket;
		state.liveSocket = null;
		if (socket) {
			try { socket.close(); } catch {}
		}
		if (state.liveAudioContext) {
			void state.liveAudioContext.close().catch(() => {});
			state.liveAudioContext = null;
			state.liveAudioWorkletReady = false;
		}
	}

	async function captureAndSendCameraFrame(callId, reason) {
		try {
			if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera is not available in this browser.");
			if (!state.liveCameraStream) {
				state.liveCameraStream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
					audio: false,
				});
				state.liveCameraEnabled = true;
			}
			const track = state.liveCameraStream.getVideoTracks()[0];
			if (!track) throw new Error("No camera track.");
			const video = document.createElement("video");
			video.muted = true;
			video.playsInline = true;
			video.srcObject = state.liveCameraStream;
			await video.play().catch(() => {});
			await new Promise((resolve) => {
				if (video.readyState >= 2) resolve();
				else video.onloadeddata = () => resolve();
				window.setTimeout(resolve, 800);
			});
			const maxEdge = 768;
			const vw = video.videoWidth || 640;
			const vh = video.videoHeight || 480;
			const scale = Math.min(1, maxEdge / Math.max(vw, vh));
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(vw * scale));
			canvas.height = Math.max(1, Math.round(vh * scale));
			const ctx = canvas.getContext("2d");
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
			const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
			await sendLiveControl({
				type: "camera_frame",
				callId,
				mimeType: "image/jpeg",
				data: base64,
				reason,
			});
			setStatus(reason || "Camera frame sent.");
		} catch (error) {
			await sendLiveControl({
				type: "camera_frame",
				callId,
				data: "",
				reason: String(error.message || error),
			}).catch(() => {});
			setStatus(String(error.message || error), "error");
		}
	}

	async function handleLiveSocketMessage(event) {
		if (typeof event.data !== "string") {
			await playLiveAudioFrame(event.data).catch((error) => setStatus(String(error.message || error), "error"));
			return;
		}
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		if (Number.isInteger(message.serverSequenceId)) {
			state.liveLastServerSequenceId = Math.max(state.liveLastServerSequenceId, message.serverSequenceId);
		}
		if (message.type === "audio_format" && Number.isFinite(message.rate) && message.rate > 0) {
			state.livePlaybackSampleRate = message.rate;
			if (state.livePlaybackNode) {
				state.livePlaybackNode.port.postMessage({ kind: "config", inputRate: message.rate });
			}
			return;
		}
		if (message.type === "start") {
			state.liveConnected = true;
			state.liveSessionId = message.session || state.liveSessionId;
			state.liveState = "listening";
			window.clearTimeout(state.liveStableTimer);
			state.liveStableTimer = window.setTimeout(() => { state.liveReconnectAttempts = 0; }, 30_000);
			setStatus(state.recording ? "Live conversation connected — mic is on." : "Live session connected. Tap to turn the mic on.");
			return;
		}
		if (message.type === "transcript" && message.text) {
			appendOrUpdateLiveReply(message.text);
			scheduleLiveTurnSettled();
			return;
		}
		if (message.type === "interrupt") {
			stopLivePlayback();
			state.liveState = "listening";
			return;
		}
		if (message.type === "camera_capture") {
			setStatus(message.reason || "Capturing camera frame…");
			void captureAndSendCameraFrame(message.callId, message.reason);
			return;
		}
		if (message.type === "tool_start") {
			state.liveState = "processing";
			const label = message.name || message.command || "tool";
			setStatus(message.command ? `Tool requested: ${message.command}` : `Tool: ${label}`);
			return;
		}
		if (message.type === "tool_approval_required") {
			rememberTerminalApproval(message);
			return;
		}
		if (message.type === "tool_approval_resolved") {
			clearTerminalApproval(message.approvalId);
			appendMessage("system", message.message || "Terminal approval resolved.");
			setStatus(message.message || "Terminal approval resolved.");
			return;
		}
		if (message.type === "tool_complete") {
			state.liveState = "listening";
			setStatus(message.name ? `Tool completed: ${message.name}` : "Tool completed.");
			scheduleLiveTurnSettled();
			return;
		}
		if (message.type === "error") {
			state.liveState = "error";
			setStatus(message.message || "Live session error.", "error");
			setRecordingStateBusy(false);
		}
	}

	function scheduleLiveReconnect(reason = "") {
		if (!state.liveMode || state.liveReconnectTimer) return;
		if (state.liveReconnectAttempts >= 5) {
			setStatus("Live session unavailable after 5 reconnect attempts. Tap Start live to try again.", "error");
			return;
		}
		const delay = Math.min(10_000, 1000 * (2 ** state.liveReconnectAttempts));
		state.liveReconnectAttempts += 1;
		const detail = String(reason || "").trim().slice(0, 160);
		setStatus(`${detail ? `${detail} ` : "Live session disconnected. "}Reconnecting in ${Math.round(delay / 1000)}s…`, "error");
		state.liveReconnectTimer = window.setTimeout(() => {
			state.liveReconnectTimer = null;
			ensureLiveSocket();
		}, delay);
	}

	function ensureLiveSocket() {
		if (state.liveSocket && (state.liveSocket.readyState === WebSocket.OPEN || state.liveSocket.readyState === WebSocket.CONNECTING)) {
			return state.liveSocket;
		}
		state.liveConnected = false;
		const socket = new WebSocket(buildRealtimeWebSocketUrl(window.location.origin, state.token));
		socket.binaryType = "arraybuffer";
		state.liveSocket = socket;
		socket.addEventListener("open", () => {
			if (state.liveSocket !== socket) return;
			state.liveClientSequenceId += 1;
			if (state.liveSessionId) {
				socket.send(JSON.stringify({
					type: "reconnect",
					session: state.liveSessionId,
					serverSequenceId: state.liveLastServerSequenceId,
					clientSequenceId: state.liveClientSequenceId,
				}));
				return;
			}
			const cwd = state.launchPath.trim();
			if (cwd) socket.send(JSON.stringify({ type: "configure", cwd, clientSequenceId: state.liveClientSequenceId }));
		});
		socket.addEventListener("message", handleLiveSocketMessage);
		socket.addEventListener("close", (event) => {
			if (state.liveSocket !== socket) return;
			state.liveSocket = null;
			state.liveConnected = false;
			window.clearTimeout(state.liveStableTimer);
			state.liveStableTimer = null;
			stopLiveCapture({ releaseStream: true });
			stopLivePlayback();
			if (event.code === 1000 && event.reason === "Realtime voice stopped by the CLI.") {
				state.liveMode = false;
				if (els.liveModeToggle) els.liveModeToggle.checked = false;
				saveSettings();
				updateRecordingUi();
				setStatus(event.reason);
				return;
			}
			scheduleLiveReconnect(event.reason);
		});
		socket.addEventListener("error", () => {
			if (state.liveSocket !== socket) return;
			state.liveConnected = false;
			setStatus("Live socket connection failed.", "error");
		});
		return socket;
	}

	function waitForLiveSocket(socket) {
		if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
		if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
			return Promise.reject(new Error("Live socket is closed."));
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeout);
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onError);
				socket.removeEventListener("close", onClose);
				if (error) reject(error); else resolve();
			};
			const onOpen = () => finish();
			const onError = () => finish(new Error("Live socket connection failed."));
			const onClose = () => finish(new Error("Live socket closed before connecting."));
			const timeout = window.setTimeout(() => finish(new Error("Live socket connection timed out.")), 15_000);
			socket.addEventListener("open", onOpen);
			socket.addEventListener("error", onError);
			socket.addEventListener("close", onClose);
		});
	}

	function waitForLiveReady(socket) {
		if (state.liveConnected) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeout);
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("error", onError);
				socket.removeEventListener("close", onClose);
				if (error) reject(error); else resolve();
			};
			const onMessage = (event) => {
				if (typeof event.data !== "string") return;
				try {
					const message = JSON.parse(event.data);
					if (message.type === "start") finish();
					else if (message.type === "error") finish(new Error(message.message || "Live session failed to start."));
				} catch {}
			};
			const onError = () => finish(new Error("Live session failed to start."));
			const onClose = () => finish(new Error("Live socket closed before the session was ready."));
			const timeout = window.setTimeout(() => finish(new Error("Live session startup timed out.")), 30_000);
			socket.addEventListener("message", onMessage);
			socket.addEventListener("error", onError);
			socket.addEventListener("close", onClose);
		});
	}

	async function startLiveCapture() {
		if (state.recording || state.liveCaptureStarting) return;
		if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone streaming.");
		if (!window.isSecureContext) throw new Error("Microphone access requires localhost or HTTPS.");
		const epoch = ++state.liveCaptureEpoch;
		state.liveCaptureStarting = true;
		if (els.record) els.record.disabled = true;
		state.liveReconnectAttempts = 0;
		window.clearTimeout(state.liveReconnectTimer);
		state.liveReconnectTimer = null;
		try {
			const socket = ensureLiveSocket();
			await waitForLiveSocket(socket);
			await waitForLiveReady(socket);
			const currentStream = state.stream?.getAudioTracks?.().some((track) => track.readyState === "live") ? state.stream : null;
			const stream = currentStream || await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (epoch !== state.liveCaptureEpoch || !state.liveMode || state.liveSocket !== socket) {
				if (!currentStream) for (const track of stream.getTracks()) track.stop();
				return;
			}
			state.stream = stream;
			const context = ensureLiveAudioContext();
			await context.resume();
			await ensureLiveWorklets(context);
			if (epoch !== state.liveCaptureEpoch || !state.liveMode || state.liveSocket !== socket) return;
			const source = context.createMediaStreamSource(stream);
			const capture = new AudioWorkletNode(context, "pi-speak-live-capture", {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [1],
				processorOptions: { chunkMs: 40 },
			});
			const sink = context.createGain();
			sink.gain.value = 0;
			capture.port.onmessage = (event) => {
				const payload = event.data;
				// HF worklet posts {kind:"level", rms} meter events and Int16 ArrayBuffers.
				if (payload && typeof payload === "object" && !(payload instanceof ArrayBuffer) && payload.kind === "level") {
					state.liveMicLevel = Number(payload.rms) || 0;
					return;
				}
				if (!state.recording || socket.readyState !== WebSocket.OPEN) return;
				let int16;
				if (payload instanceof ArrayBuffer) int16 = new Int16Array(payload);
				else if (payload instanceof Int16Array) int16 = payload;
				else if (payload instanceof Float32Array) {
					// Legacy float path (old worklet) — keep wire compatible.
					state.liveClientSequenceId += 1;
					socket.send(encodeLivePcmFrame(state.liveClientSequenceId, payload, 16_000));
					return;
				} else {
					return;
				}
				state.liveClientSequenceId += 1;
				socket.send(encodeLiveInt16PcmFrame(state.liveClientSequenceId, int16));
				// Client-side barge-in: if we hear speech while AI audio is queued, clear + interrupt.
				let energy = 0;
				for (let index = 0; index < int16.length; index += 1) {
					const s = int16[index] / 0x8000;
					energy += s * s;
				}
				const rms = Math.sqrt(energy / int16.length);
				state.liveMicLevel = rms;
				const now = Date.now();
				const aiPlaying = state.liveState === "ai-speaking" || state.livePlaybackSources.size > 0;
				if (rms > 0.035 && aiPlaying && now - state.liveLastInterruptAt > 750) {
					state.liveLastInterruptAt = now;
					stopLivePlayback();
					state.liveClientSequenceId += 1;
					socket.send(JSON.stringify({ type: "interrupt", clientSequenceId: state.liveClientSequenceId }));
				} else if (rms > 0.02) {
					state.liveState = "user-speaking";
				} else if (state.liveState === "user-speaking") {
					state.liveState = "listening";
				}
			};
			source.connect(capture);
			capture.connect(sink);
			sink.connect(context.destination);
			state.liveCaptureSource = source;
			state.liveCaptureNode = capture;
			state.liveCaptureSink = sink;
			applyLiveNoiseGate();
			setLiveMicEnabled(true);
			state.recording = true;
			state.liveState = "listening";
			state.recordStartedAt = Date.now();
			state.timerId = window.setInterval(ensureTimerState, 250);
			ensureTimerState();
			setStatus("Live conversation connected — mic is on.");
		} catch (error) {
			if (epoch === state.liveCaptureEpoch) stopLiveCapture({ releaseStream: true });
			throw error;
		} finally {
			if (epoch === state.liveCaptureEpoch) {
				state.liveCaptureStarting = false;
				if (els.record) els.record.disabled = !!state.turnInProgress;
			}
		}
	}

	async function sendLiveControl(payload) {
		const socket = ensureLiveSocket();
		await waitForLiveSocket(socket);
		await waitForLiveReady(socket);
		state.liveClientSequenceId += 1;
		socket.send(JSON.stringify({ ...payload, clientSequenceId: state.liveClientSequenceId }));
	}

	function sendTerminalApproval(approvalId, approved) {
		if (!approvalId) return;
		void sendLiveControl({
			type: approved ? "terminal_approve" : "terminal_reject",
			approvalId,
		}).catch((error) => {
			setStatus(String(error.message || error), "error");
		});
	}

	async function submitLiveText(text) {
		setStatus("Sending live text turn...");
		state.liveTurnInProgress = true;
		setRecordingStateBusy(true);
		appendMessage("user", text);
		state.liveReplyBuffer = "";
		state.liveAgentMessage = null;
		try {
			await sendLiveControl({ type: "text", text });
			if (els.textInput) els.textInput.value = "";
			setStatus("Live turn sent.");
		} catch (error) {
			setStatus(String(error.message || error), "error");
			state.liveTurnInProgress = false;
			setRecordingStateBusy(false);
		}
	}

	function ensureTimerState() {
		const active = state.recording;
		if (els.audioToggle) els.audioToggle.classList.toggle("hidden", state.liveMode);
		if (state.turnInProgress && !state.liveMode) {
			if (els.record) els.record.classList.remove("recording");
			if (els.recordLabel) els.recordLabel.textContent = "Working";
			if (els.recordLabelMain) els.recordLabelMain.textContent = "Processing your turn";
			if (els.recordSubtitle) els.recordSubtitle.textContent = "Waiting for reply...";
			if (els.timer) els.timer.textContent = "Please wait";
			return;
		}
		if (!active) {
			if (els.record) els.record.classList.remove("recording");
			if (els.recordLabel) els.recordLabel.textContent = state.liveMode ? "Start live" : "Tap to talk";
			if (els.recordLabelMain) els.recordLabelMain.textContent = state.liveMode ? "Gemini Live" : "Speak to local agent";
			if (els.recordSubtitle) els.recordSubtitle.textContent = state.liveMode ? "Mic is off" : "Text replies are enabled";
			if (els.timer) els.timer.textContent = "Ready";
			return;
		}
		if (els.record) els.record.classList.add("recording");
		if (els.recordLabel) els.recordLabel.textContent = state.liveMode ? "Mute" : "Tap to send";
		if (els.recordLabelMain) els.recordLabelMain.textContent = state.liveMode ? "Gemini Live" : "Release after speaking";
		if (els.recordSubtitle) els.recordSubtitle.textContent = state.liveMode ? "Mic is on" : "Recording";
		if (els.timer) els.timer.textContent = formatElapsed(Date.now() - state.recordStartedAt);
	}

	async function submitText() {
		const text = els.textInput.value.trim();
		if (!text) {
			setStatus("Enter text before sending.", "error");
			return;
		}
		if (state.liveMode) {
			await submitLiveText(text);
			return;
		}
		setStatus("Sending text turn...");
		setRecordingStateBusy(true);
		appendMessage("user", text);
		try {
			const body = { text, audio: state.wantAudio };
			if (state.liveMode) body.mode = "live";
			const target = activeTarget();
			if (target) body.target = target;
			if (state.launchPath.trim()) body.cwd = state.launchPath.trim();
			const payload = await apiFetch("/v1/turn/text", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			setTranscript("");
			setReplyText(payload && payload.replyText ? payload.replyText : "");
			await new Promise((resolve) => {
				setAudio(payload ? payload.audioUrl : "", {
					turnStartedAt: Date.now(),
					payload,
					onReady: () => resolve(),
				});
			});
			els.textInput.value = "";
			setStatus(turnStatusMessage(payload));
			await refreshStatus();
		} catch (error) {
			setStatus(String(error.message || error), "error");
		} finally {
			setRecordingStateBusy(false);
		}
	}

	async function launchSession(body, pendingMessage) {
		captureSettings();
		if (state.launchPath.trim()) body.cwd = state.launchPath.trim();
		setStatus(pendingMessage);
		try {
			const payload = await apiFetch("/v1/sessions/launch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			setStatus(payload && payload.message ? payload.message : "Launch started.");
		} catch (error) {
			setStatus(String(error.message || error), "error");
		}
	}

	function pickMimeType() {
		if (!window.MediaRecorder) return "";
		const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
		for (const candidate of candidates) {
			if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(candidate)) return candidate;
		}
		return "";
	}

	async function ensureRecorder() {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
			throw new Error("This browser does not support microphone recording.");
		}
		if (!window.isSecureContext) {
			throw new Error("Microphone access requires localhost or HTTPS.");
		}
		if (!state.stream) {
			state.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
		}
		if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") return state.mediaRecorder;
		const mimeType = pickMimeType();
		state.chunks = [];
		state.mediaRecorder = mimeType ? new MediaRecorder(state.stream, { mimeType }) : new MediaRecorder(state.stream);
		state.mediaRecorder.addEventListener("dataavailable", (event) => {
			if (event.data && event.data.size > 0) state.chunks.push(event.data);
		});
		return state.mediaRecorder;
	}

	async function startRecording() {
		try {
			const recorder = await ensureRecorder();
			state.chunks = [];
			recorder.start();
			state.recording = true;
			state.recordStartedAt = Date.now();
			ensureTimerState();
			state.timerId = window.setInterval(ensureTimerState, 250);
			setStatus("Recording. Tap again to send.");
		} catch (error) {
			setStatus(String(error.message || error), "error");
		}
	}

	async function stopRecordingAndSend() {
		if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") return;
		const recorder = state.mediaRecorder;
		state.recording = false;
		window.clearInterval(state.timerId);
		state.timerId = null;
		ensureTimerState();
		setRecordingStateBusy(true);
		state.turnStartedAt = Date.now();
		const currentTurn = ++state.nextTurnId;
		const blob = await new Promise((resolve) => {
			recorder.addEventListener("stop", () => {
				resolve(new Blob(state.chunks, { type: recorder.mimeType || "application/octet-stream" }));
			}, { once: true });
			recorder.stop();
		});

		try {
			const params = new URLSearchParams({ audio: state.wantAudio ? "1" : "0" });
			if (state.liveMode) params.set("mode", "live");
			const target = activeTarget();
			if (target) params.set("target", target);
			if (state.launchPath.trim()) params.set("cwd", state.launchPath.trim());
			const payload = await apiFetch(`/v1/turn/voice?${params.toString()}`, {
				method: "POST",
				headers: { "Content-Type": blob.type || "application/octet-stream" },
				body: blob,
			});
			setTranscript(payload && payload.transcript ? payload.transcript : "");
			setReplyText(payload && payload.replyText ? payload.replyText : "");
			await new Promise((resolve) => {
				setAudio(payload ? payload.audioUrl : "", {
					turnStartedAt: state.turnStartedAt,
					payload,
					onPlaybackStarted: () => {
						if (currentTurn !== state.nextTurnId) return;
					},
					onReady: () => {
						if (currentTurn !== state.nextTurnId) return;
						setRecordingStateBusy(false);
					},
				});
			});
			setStatus(turnStatusMessage(payload, "Voice turn complete."));
			await refreshStatus();
		} catch (error) {
			setStatus(String(error.message || error), "error");
			if (currentTurn === state.nextTurnId) {
				setRecordingStateBusy(false);
			}
		}
	}

	async function toggleRecording() {
		if (state.liveMode) {
			if (state.recording) {
				stopLiveCapture();
				setStatus("Live mic muted. Tap Start live to resume.");
				return;
			}
			try {
				await startLiveCapture();
			} catch (error) {
				setStatus(String(error.message || error), "error");
			}
			return;
		}
		if (state.turnInProgress) return;
		if (state.recording) {
			await stopRecordingAndSend();
			return;
		}
		await startRecording();
	}

	function updateRecordingUi() {
		ensureTimerState();
	}

	function registerServiceWorker() {
		if (!("serviceWorker" in navigator)) return;
		navigator.serviceWorker.register("/app/sw.js").catch(() => {});
	}

	function bindInstallPrompt() {
		window.addEventListener("beforeinstallprompt", (event) => {
			event.preventDefault();
			state.deferredPrompt = event;
			if (els.install) {
				els.install.classList.remove("hidden");
			}
		});
		if (els.install) {
			els.install.addEventListener("click", async () => {
				if (!state.deferredPrompt) return;
				state.deferredPrompt.prompt();
				await state.deferredPrompt.userChoice.catch(() => {});
				state.deferredPrompt = null;
				els.install.classList.add("hidden");
			});
		}
	}

	els.refresh?.addEventListener("click", refreshStatus);
	els.playReply?.addEventListener("click", playReplyAudio);
	els.record?.addEventListener("click", toggleRecording);
	els.sendText?.addEventListener("click", submitText);
	els.clearText?.addEventListener("click", () => {
		if (els.textInput) els.textInput.value = "";
	});
	els.textInput?.addEventListener("keydown", (event) => {
		// Chat-first: Enter sends; Shift+Enter inserts a newline.
		if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
			event.preventDefault();
			void submitText();
		}
	});

	let routeSaveTimer = null;
	function queueRouteSave(nextTarget) {
		if (routeSaveTimer) window.clearTimeout(routeSaveTimer);
		routeSaveTimer = window.setTimeout(async () => {
			routeSaveTimer = null;
			const target = (nextTarget ?? activeTarget()).trim();
			try {
				await apiFetch("/v1/route", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ target }),
				});
				setStatus(target ? "Route updated." : "Route reset.");
				await refreshStatus();
			} catch (error) {
				setStatus(String(error.message || error), "error");
			}
		}, 250);
	}

	function captureSettings() {
		state.token = (els.tokenInput?.value || "").trim();
		state.launchPath = (els.launchPathInput?.value || "").trim();
		state.rememberToken = !!els.rememberToken?.checked;
		state.wantAudio = !!els.audioToggle?.checked;
		state.autoplay = !!els.autoplayToggle?.checked;
		state.liveMode = !!els.liveModeToggle?.checked;
		state.liveNoiseGateEnabled = !!els.liveNoiseGateToggle?.checked;
		const gateDb = Number.parseFloat(els.liveNoiseGateDb?.value || String(state.liveNoiseGateDb));
		if (Number.isFinite(gateDb)) state.liveNoiseGateDb = Math.min(-3, Math.max(-66, gateDb));
		if (state.liveMode) state.wantAudio = true;
		applyLiveNoiseGate();
	}

	function setSettingsOpen(isOpen) {
		if (!els.settingsShell) return;
		els.settingsShell.classList.toggle("open", !!isOpen);
	}

	els.settingsButton?.addEventListener("click", () => setSettingsOpen(true));
	els.settingsClose?.addEventListener("click", () => setSettingsOpen(false));
	els.settingsShell?.addEventListener("click", (event) => {
		if (event.target === els.settingsShell) setSettingsOpen(false);
	});

	els.targetSelect?.addEventListener("change", () => {
		const value = els.targetSelect.value.trim();
		if (els.targetInput) els.targetInput.value = value;
		queueRouteSave(value);
	});
	els.targetInput?.addEventListener("change", () => {
		const manual = (els.targetInput?.value || "").trim();
		if (els.targetSelect) els.targetSelect.value = manual;
		queueRouteSave(manual);
	});
	els.saveTarget?.addEventListener("click", () => {
		queueRouteSave(activeTarget());
	});
	els.clearTarget?.addEventListener("click", () => {
		if (els.targetSelect) els.targetSelect.value = "";
		if (els.targetInput) els.targetInput.value = "";
		queueRouteSave("");
	});

	els.tokenInput?.addEventListener("change", () => {
		captureSettings();
		saveSettings();
		syncLockedUi();
		void refreshStatus();
	});
	els.saveToken?.addEventListener("click", () => {
		captureSettings();
		saveSettings();
		syncLockedUi();
		void refreshStatus();
	});
	els.clearToken?.addEventListener("click", () => {
		state.token = "";
		closeLiveSocket();
		if (els.tokenInput) els.tokenInput.value = "";
		if (els.onboardingToken) els.onboardingToken.value = "";
		saveSettings();
		syncLockedUi();
		void refreshStatus();
	});
	els.onboardingSave?.addEventListener("click", () => {
		state.token = (els.onboardingToken?.value || "").trim();
		state.rememberToken = !!els.onboardingRememberToken?.checked;
		if (els.tokenInput) els.tokenInput.value = state.token;
		if (els.rememberToken) els.rememberToken.checked = state.rememberToken;
		saveSettings();
		syncLockedUi();
		void refreshStatus();
	});
	els.onboardingToken?.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			els.onboardingSave?.click();
		}
	});
	els.copySetup?.addEventListener("click", async () => {
		const payload = "/remote on\n/remote setup";
		if (navigator.clipboard && navigator.clipboard.writeText) {
			await navigator.clipboard.writeText(payload).catch(() => {});
			setStatus("Setup commands copied.");
			return;
		}
		setStatus("Clipboard unavailable. Run commands from your terminal.");
	});
	els.launchPathInput?.addEventListener("change", () => {
		captureSettings();
		saveSettings();
	});
	els.launchOmpHub?.addEventListener("click", () => {
		void launchSession({ hubOnly: true }, "Launching OMPK hub...");
	});
	els.launchColab?.addEventListener("click", () => {
		void launchSession({ targetNode: "colab" }, "Launching Colab...");
	});
	els.rememberToken?.addEventListener("change", () => {
		captureSettings();
		saveSettings();
	});
	els.onboardingRememberToken?.addEventListener("change", () => {
		state.rememberToken = !!els.onboardingRememberToken?.checked;
		if (els.rememberToken) els.rememberToken.checked = state.rememberToken;
		saveSettings();
	});
	els.audioToggle?.addEventListener("change", () => {
		captureSettings();
		saveSettings();
		updateRecordingUi();
	});
	els.autoplayToggle?.addEventListener("change", () => {
		captureSettings();
		saveSettings();
	});
	els.liveModeToggle?.addEventListener("change", () => {
		const recorderActive = state.mediaRecorder && state.mediaRecorder.state !== "inactive";
		if (els.liveModeToggle.checked && recorderActive) {
			els.liveModeToggle.checked = false;
			setStatus("Finish or cancel the current recording before entering live mode.", "error");
			return;
		}
		captureSettings();
		if (state.liveMode) ensureLiveSocket();
		else closeLiveSocket();
		saveSettings();
		updateRecordingUi();
	});
	els.liveNoiseGateToggle?.addEventListener("change", () => {
		captureSettings();
		saveSettings();
	});
	els.liveNoiseGateDb?.addEventListener("change", () => {
		captureSettings();
		saveSettings();
	});

	/* Tabs */
	if (els.tabBar) {
		for (const btn of els.tabBar.querySelectorAll(".tab")) {
			btn.addEventListener("click", () => switchTab(btn.dataset.tab));
		}
	}

	/* Cancel turn */
	els.cancelTurn?.addEventListener("click", async () => {
		try {
			setStatus("Cancelling turn…");
			await apiFetch("/v1/turn/cancel", { method: "POST" });
			setStatus("Turn cancelled.");
			setRecordingStateBusy(false);
		} catch (error) {
			setStatus(String(error.message || error), "error");
		}
	});

	/* Sessions */
	els.refreshAgents?.addEventListener("click", loadAgents);
	els.renameButton?.addEventListener("click", doSessionRename);
	els.aliasButton?.addEventListener("click", doSessionAlias);
	els.removeButton?.addEventListener("click", doSessionRemove);
	els.workspaceRoot?.addEventListener("click", () => renderWorkspace(""));
	els.workspaceUp?.addEventListener("click", () => {
		if (state.workspaceParent) renderWorkspace(state.workspaceParent);
	});
	els.workspaceUse?.addEventListener("click", () => {
		if (!state.workspaceCurrent) return;
		// Persist only the launch path; avoid captureSettings() which re-reads the
		// whole settings form (including the auth token) from the DOM.
		state.launchPath = state.workspaceCurrent;
		if (els.launchPathInput) els.launchPathInput.value = state.workspaceCurrent;
		saveSettings();
		setStatus(`Working directory set: ${state.workspaceCurrent}`);
	});
	els.fileViewerClose?.addEventListener("click", closeFileViewer);
	els.fileViewer?.addEventListener("click", (event) => {
		if (event.target === els.fileViewer) closeFileViewer();
	});
	document.addEventListener("keydown", (event) => {
		// Only intercept keys while the file viewer modal is open.
		if (!els.fileViewer || els.fileViewer.classList.contains("hidden")) return;
		if (event.key === "Escape") {
			closeFileViewer();
			return;
		}
		if (event.key === "Tab") {
			// Trap focus inside the dialog by wrapping between its focusable elements.
			const focusable = Array.from(
				els.fileViewer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
			).filter((node) => !node.disabled);
			if (focusable.length === 0) {
				event.preventDefault();
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			if (event.shiftKey) {
				if (active === first || !els.fileViewer.contains(active)) {
					event.preventDefault();
					last.focus();
				}
			} else if (active === last || !els.fileViewer.contains(active)) {
				event.preventDefault();
				first.focus();
			}
		}
	});

	loadSettings();
	syncLockedUi();
	updateRecordingUi();
	syncDockInset();
	if (typeof ResizeObserver !== "undefined" && els.dock) {
		const ro = new ResizeObserver(() => syncDockInset());
		ro.observe(els.dock);
	}
	registerServiceWorker();
	bindInstallPrompt();
	void refreshStatus();
	if (state.liveMode && new URL(window.location.href).searchParams.get("autoconnect") === "1") ensureLiveSocket();
	window.addEventListener("beforeunload", closeLiveSocket, { once: true });
}
