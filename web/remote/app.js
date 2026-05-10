export const STORAGE_TOKEN = "piSpeakRemoteToken";
export const STORAGE_AUDIO = "piSpeakRemoteAudio";
export const STORAGE_AUTOPLAY = "piSpeakRemoteAutoplay";
export const STORAGE_REMEMBER = "piSpeakRemoteRememberToken";
export const STORAGE_LAUNCH_PATH = "piSpeakRemoteLaunchPath";
export const STORAGE_LIVE_MODE = "piSpeakRemoteLiveMode";

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
		audioNote: document.getElementById("audio-note"),
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
		rememberToken: document.getElementById("remember-token-toggle"),
		audioToggle: document.getElementById("audio-toggle"),
		autoplayToggle: document.getElementById("autoplay-toggle"),
		liveModeToggle: document.getElementById("live-mode-toggle"),

		setupStatus: document.getElementById("setup-status"),
		setupLink: document.getElementById("setup-link"),
		copySetup: document.getElementById("copy-setup-button"),
		onboardingToken: document.getElementById("onboarding-token-input"),
		onboardingRememberToken: document.getElementById("onboarding-remember-token-toggle"),
		onboardingSave: document.getElementById("onboarding-save-button"),
	};

	function hasToken() {
		return !!(state.token && String(state.token).trim());
	}

	function syncLockedUi() {
		const locked = !hasToken();
		if (els.appRoot) els.appRoot.classList.toggle("locked", locked);
		// Onboarding banner is only useful until the token exists.
		if (els.setupBanner) els.setupBanner.classList.toggle("hidden", !locked);
		if (els.auth) els.auth.textContent = locked ? "Token needed" : "Token loaded";
	}

	function syncDockInset() {
		if (!els.dock) return;
		const height = Math.max(120, Math.round(els.dock.getBoundingClientRect().height || 0));
		document.documentElement.style.setProperty("--dock-inset", `${height}px`);
	}

	function setStatus(text, tone) {
		if (els.statusNote) {
			els.statusNote.textContent = text;
			els.statusNote.style.color = tone === "error" ? "#9b3517" : "var(--ink)";
		}
		if (els.statusDot) {
			els.statusDot.className = `status-dot${tone === "error" ? " error" : state.lastStatus ? " ready" : ""}`;
		}
		if (els.auth) {
			els.auth.textContent = tone === "error" ? "Token issue" : "Token loaded";
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

	function setRecordingStateBusy(isBusy) {
		state.turnInProgress = isBusy;
		if (els.sendText) els.sendText.disabled = !!isBusy;
		if (els.record) els.record.disabled = !!isBusy;
		updateRecordingUi();
	}

	function setPlayReplyButton(isVisible, disabled = false) {
		if (!els.playReply) return;
		els.playReply.classList.toggle("hidden", !isVisible);
		els.playReply.disabled = !!disabled;
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
			setStatus(summarizeStatus(state.lastStatus));
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
			if (els.audioNote) els.audioNote.textContent = "Reply audio not provided.";
			onReady?.(undefined);
			return;
		}

		const audioUrl = new URL(url, window.location.origin);
		const headers = new Headers();
		if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
		if (els.audioNote) els.audioNote.textContent = "Loading reply audio...";
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
					if (els.audioNote) els.audioNote.textContent = `Reply audio ready${source}. Tap play to hear it.`;
					onReady?.(undefined);
					return;
				}
				let resolved = false;
				let playbackWatchdog;
				const finalize = (playbackMs) => {
					if (resolved) return;
					resolved = true;
					if (playbackWatchdog) window.clearTimeout(playbackWatchdog);
					if (playbackMs !== undefined && els.audioNote) {
						els.audioNote.textContent = `Playback started${source} (${Math.max(0, playbackMs).toFixed(0)}ms).`;
					} else if (els.audioNote) {
						els.audioNote.textContent = `Reply ready${source}.`;
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
					if (els.audioNote) els.audioNote.textContent = "Reply ready. Tap play if autoplay is blocked.";
					onPlaybackFailed?.(String(error.message || error));
					finalize();
				});
			})
			.catch((error) => {
				if (els.audio) {
					els.audio.classList.add("hidden");
					els.audio.removeAttribute("src");
				}
				if (els.audioNote) els.audioNote.textContent = String(error.message || error);
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
			if (els.audioNote) els.audioNote.textContent = "Unable to play reply audio.";
			setStatus(String(error.message || error), "error");
		});
	}

	function ensureTimerState() {
		const active = state.recording;
		if (state.turnInProgress) {
			if (els.record) els.record.classList.remove("recording");
			if (els.recordLabel) els.recordLabel.textContent = "Working";
			if (els.recordLabelMain) els.recordLabelMain.textContent = "Processing your turn";
			if (els.recordSubtitle) els.recordSubtitle.textContent = "Waiting for reply...";
			if (els.timer) els.timer.textContent = "Please wait";
			return;
		}
		if (!state.recording) {
			if (els.record) els.record.classList.remove("recording");
			if (els.recordLabel) els.recordLabel.textContent = "Tap to talk";
			if (els.recordLabelMain) els.recordLabelMain.textContent = "Speak to local agent";
			if (els.recordSubtitle) {
				els.recordSubtitle.textContent = state.liveMode
					? "Live mode active"
					: state.wantAudio ? "Text replies are enabled" : "Text replies are enabled";
			}
			if (els.timer) els.timer.textContent = "Ready";
			return;
		}
		if (els.record) els.record.classList.add("recording");
		if (els.recordLabel) els.recordLabel.textContent = "Tap to send";
		if (els.recordLabelMain) els.recordLabelMain.textContent = "Release after speaking";
		if (els.recordSubtitle) els.recordSubtitle.textContent = "Recording";
		if (els.timer) els.timer.textContent = formatElapsed(Date.now() - state.recordStartedAt);
	}

	async function submitText() {
		const text = els.textInput.value.trim();
		if (!text) {
			setStatus("Enter text before sending.", "error");
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
		if (state.liveMode) state.wantAudio = true;
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
		captureSettings();
		saveSettings();
		updateRecordingUi();
	});

	loadSettings();
	updateRecordingUi();
	syncDockInset();
	if (typeof ResizeObserver !== "undefined" && els.dock) {
		const ro = new ResizeObserver(() => syncDockInset());
		ro.observe(els.dock);
	}
	registerServiceWorker();
	bindInstallPrompt();
	void refreshStatus();
}
