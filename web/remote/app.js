export const STORAGE_TOKEN = "piSpeakRemoteToken";
export const STORAGE_AUDIO = "piSpeakRemoteAudio";
export const STORAGE_AUTOPLAY = "piSpeakRemoteAutoplay";
export const STORAGE_REMEMBER = "piSpeakRemoteRememberToken";
export const STORAGE_LAUNCH_PATH = "piSpeakRemoteLaunchPath";

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
	autoplay: true,
	rememberToken: false,
	mediaRecorder: null,
	stream: null,
	chunks: [],
	recording: false,
	recordStartedAt: 0,
	timerId: null,
	deferredPrompt: null,
	lastStatus: null,
};

const els = {
	origin: document.getElementById("origin-pill"),
	secure: document.getElementById("secure-pill"),
	auth: document.getElementById("auth-pill"),
	refresh: document.getElementById("refresh-button"),
	install: document.getElementById("install-button"),
	record: document.getElementById("record-button"),
	recordLabel: document.getElementById("record-label"),
	recordSubtitle: document.getElementById("record-subtitle"),
	timer: document.getElementById("timer"),
	statusDot: document.getElementById("status-dot"),
	statusNote: document.getElementById("status-note"),
	chatMessages: document.getElementById("chat-messages"),
	transcript: document.getElementById("transcript-output"),
	reply: document.getElementById("reply-output"),
	audio: document.getElementById("reply-audio"),
	audioNote: document.getElementById("audio-note"),
	textInput: document.getElementById("text-input"),
	sendText: document.getElementById("send-text-button"),
	clearText: document.getElementById("clear-text-button"),
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
	settings: document.getElementById("settings-panel"),
};

function setStatus(text, tone) {
	els.statusNote.textContent = text;
	els.statusNote.style.borderColor = tone === "error" ? "rgba(214, 90, 49, 0.4)" : "var(--line)";
	els.statusNote.style.color = tone === "error" ? "#9b3517" : "var(--ink)";
	if (els.statusDot) {
		els.statusDot.className = `status-dot${tone === "error" ? " error" : state.lastStatus ? " ready" : ""}`;
	}
}

function appendMessage(role, text) {
	if (!els.chatMessages || !text || !text.trim()) return;
	const node = document.createElement("div");
	node.className = `message ${role}`;
	node.textContent = text.trim();
	els.chatMessages.appendChild(node);
	els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function setReplyText(text) {
	els.reply.textContent = text && text.trim() ? text.trim() : "No reply yet.";
	if (text && text.trim()) appendMessage("agent", text);
}

function setTranscript(text) {
	els.transcript.textContent = text && text.trim() ? text.trim() : "No transcript yet.";
	if (text && text.trim()) appendMessage("user", text);
}

function turnStatusMessage(payload, fallback = "Turn complete.") {
	const warnings = Array.isArray(payload && payload.warnings) ? payload.warnings.filter(Boolean) : [];
	const provider = payload && payload.providers && payload.providers.agent ? ` Agent: ${payload.providers.agent}.` : "";
	return warnings.length ? `${fallback}${provider} ${warnings.join(" ")}` : `${fallback}${provider}`;
}

function getSessionStorage() {
	return window.sessionStorage;
}

function getLocalStorage() {
	return window.localStorage;
}

function setAudio(url) {
	if (!url) {
		els.audio.pause();
		els.audio.removeAttribute("src");
		if (els.audio.dataset.objectUrl) {
			URL.revokeObjectURL(els.audio.dataset.objectUrl);
			delete els.audio.dataset.objectUrl;
		}
		els.audio.classList.add("hidden");
		els.audioNote.textContent = "Requested audio replies will appear here.";
		return;
	}

	const audioUrl = new URL(url, window.location.origin);
	const headers = new Headers();
	if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
	els.audioNote.textContent = "Loading reply audio...";
	fetch(audioUrl, { headers })
		.then(async (response) => {
			if (!response.ok) {
				throw new Error(`Audio request failed (${response.status})`);
			}
			const blob = await response.blob();
			if (els.audio.dataset.objectUrl) {
				URL.revokeObjectURL(els.audio.dataset.objectUrl);
			}
			const objectUrl = URL.createObjectURL(blob);
			els.audio.dataset.objectUrl = objectUrl;
			els.audio.src = objectUrl;
			els.audio.classList.remove("hidden");
			els.audioNote.textContent = "Reply audio ready.";
			if (state.autoplay) {
				els.audio.play().catch(() => {
					els.audioNote.textContent = "Reply audio ready. Tap play if autoplay is blocked.";
				});
			}
		})
		.catch((error) => {
			els.audio.classList.add("hidden");
			els.audio.removeAttribute("src");
			els.audioNote.textContent = String(error.message || error);
		});
}

function syncSettingsUi() {
	els.origin.textContent = window.location.origin;
	els.secure.textContent = window.isSecureContext ? "Yes" : "No";
	els.audio.textContent = "";
	els.audioToggle.checked = state.wantAudio;
	els.autoplayToggle.checked = state.autoplay;
	els.rememberToken.checked = state.rememberToken;
	els.launchPathInput.value = state.launchPath;
	els.tokenInput.value = state.token;
	els.auth.textContent = state.token ? "Token loaded" : "No token";
}

function activeTarget() {
	const selected = els.targetSelect ? els.targetSelect.value.trim() : "";
	const manual = els.targetInput ? els.targetInput.value.trim() : "";
	return selected || manual || "";
}

function syncTargetUi(status) {
	if (!els.targetSelect) return;
	const remote = status && status.remote ? status.remote : {};
	const targets = Array.isArray(remote.availableTargets) ? remote.availableTargets : [];
	const selected = remote.defaultTarget || activeTarget();
	els.targetSelect.innerHTML = "";
	const current = document.createElement("option");
	current.value = "";
	current.textContent = remote.currentSession ? `Current: ${remote.currentSession}` : "Current session";
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
		els.auth.textContent = "Token required";
		els.settings.open = true;
		throw new Error("Unauthorized. Save the remote token in Settings.");
	}
	if (!response.ok) {
		throw new Error(payload && (payload.error || payload.message) ? payload.error || payload.message : `Request failed (${response.status})`);
	}
	els.auth.textContent = state.token ? "Token loaded" : "Local access";
	return payload;
}

function summarizeStatus(status) {
	if (!status) return "Connected.";
	const speak = status.speak || {};
	const mono = status.mono || {};
	const phone = status.phone || {};
	const remote = status.remote || {};
	const speakLabel = speak.enabled ? (speak.provider || speak.configuredProvider || "on") : "off";
	const monoLabel = mono.running ? (mono.voiceInputActive ? "active" : "standby") : "off";
	const phoneLabel = phone.enabled ? (phone.linkedChatId ? "linked" : "waiting for pair code") : "off";
	return `Remote ${remote.enabled ? "on" : "off"} at port ${remote.port || 8767}. Speak ${speakLabel}, mono ${monoLabel}, phone ${phoneLabel}.`;
}

async function refreshStatus() {
	try {
		const payload = await apiFetch("/v1/status");
		state.lastStatus = payload ? payload.status : null;
		syncTargetUi(state.lastStatus);
		setStatus(summarizeStatus(state.lastStatus));
	} catch (error) {
		setStatus(String(error.message || error), "error");
	}
}

async function triggerAction(path) {
	try {
		const payload = await apiFetch(`/v1/${path}`);
		setStatus(payload && payload.message ? payload.message : "Action complete.");
		await refreshStatus();
	} catch (error) {
		setStatus(String(error.message || error), "error");
	}
}

async function submitText() {
	const text = els.textInput.value.trim();
	if (!text) {
		setStatus("Enter text before sending.", "error");
		return;
	}
	setStatus("Sending text turn...");
	els.sendText.disabled = true;
	appendMessage("user", text);
	try {
		const body = { text, audio: state.wantAudio };
		const target = activeTarget();
		if (target) body.target = target;
		const trimmedLaunchPath = state.launchPath.trim();
		if (trimmedLaunchPath) {
			body.cwd = trimmedLaunchPath;
		}
		const payload = await apiFetch("/v1/turn/text", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		setTranscript("");
		setReplyText(payload && payload.replyText ? payload.replyText : "");
		setAudio(payload ? payload.audioUrl : "");
		els.textInput.value = "";
		setStatus(turnStatusMessage(payload));
		await refreshStatus();
	} catch (error) {
		setStatus(String(error.message || error), "error");
	} finally {
		els.sendText.disabled = false;
	}
}

function pickMimeType() {
	if (!window.MediaRecorder) return "";
	const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
	for (const candidate of candidates) {
		if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(candidate)) {
			return candidate;
		}
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
	if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
		return state.mediaRecorder;
	}
	const mimeType = pickMimeType();
	state.chunks = [];
	state.mediaRecorder = mimeType ? new MediaRecorder(state.stream, { mimeType }) : new MediaRecorder(state.stream);
	state.mediaRecorder.addEventListener("dataavailable", (event) => {
		if (event.data && event.data.size > 0) state.chunks.push(event.data);
	});
	return state.mediaRecorder;
}

function formatElapsed(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return `${minutes}:${seconds}`;
}

function updateRecordingUi() {
	if (!state.recording) {
		els.record.classList.remove("recording");
		els.recordLabel.textContent = "Tap to talk";
		els.recordSubtitle.textContent = state.wantAudio ? "Voice conversation on" : "Text replies";
		els.timer.textContent = "Ready";
		return;
	}
	els.record.classList.add("recording");
	els.recordLabel.textContent = "Tap to send";
	els.recordSubtitle.textContent = "Recording live";
	els.timer.textContent = formatElapsed(Date.now() - state.recordStartedAt);
}

async function startRecording() {
	try {
		const recorder = await ensureRecorder();
		state.chunks = [];
		recorder.start();
		state.recording = true;
		state.recordStartedAt = Date.now();
		updateRecordingUi();
		state.timerId = window.setInterval(updateRecordingUi, 250);
		setStatus("Recording. Tap again to send the voice turn.");
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
	updateRecordingUi();
	setStatus("Uploading voice turn...");

	const blob = await new Promise((resolve) => {
		recorder.addEventListener(
			"stop",
			() => {
				resolve(new Blob(state.chunks, { type: recorder.mimeType || "application/octet-stream" }));
			},
			{ once: true },
		);
		recorder.stop();
	});

	try {
		const params = new URLSearchParams({ audio: state.wantAudio ? "1" : "0" });
		const target = activeTarget();
		if (target) params.set("target", target);
		const trimmedLaunchPath = state.launchPath.trim();
		if (trimmedLaunchPath) {
			params.set("cwd", trimmedLaunchPath);
		}
		const payload = await apiFetch(`/v1/turn/voice?${params.toString()}`, {
			method: "POST",
			headers: { "Content-Type": blob.type || "application/octet-stream" },
			body: blob,
		});
		setTranscript(payload && payload.transcript ? payload.transcript : "");
		setReplyText(payload && payload.replyText ? payload.replyText : "");
		setAudio(payload ? payload.audioUrl : "");
		setStatus(turnStatusMessage(payload, "Voice turn complete."));
		await refreshStatus();
	} catch (error) {
		setStatus(String(error.message || error), "error");
	}
}

async function toggleRecording() {
	if (state.recording) {
		await stopRecordingAndSend();
		return;
	}
	await startRecording();
}

function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("/app/sw.js").catch(() => {});
}

function bindInstallPrompt() {
	window.addEventListener("beforeinstallprompt", (event) => {
		event.preventDefault();
		state.deferredPrompt = event;
		els.install.classList.remove("hidden");
		els.install.classList.add("install-ready");
	});
	els.install.addEventListener("click", async () => {
		if (!state.deferredPrompt) return;
		state.deferredPrompt.prompt();
		await state.deferredPrompt.userChoice.catch(() => {});
		state.deferredPrompt = null;
		els.install.classList.add("hidden");
	});
}

document.querySelectorAll("[data-action]").forEach((button) => {
	button.addEventListener("click", () => {
		triggerAction(button.getAttribute("data-action"));
	});
});

els.refresh.addEventListener("click", refreshStatus);
els.record.addEventListener("click", toggleRecording);
els.sendText.addEventListener("click", submitText);
els.clearText.addEventListener("click", () => {
	els.textInput.value = "";
});
els.textInput.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		submitText();
	}
});

async function saveTarget(value) {
	try {
		const payload = await apiFetch("/v1/route", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ target: value || "" }),
		});
		setStatus(payload && payload.message ? payload.message : "Target updated.");
		await refreshStatus();
	} catch (error) {
		setStatus(String(error.message || error), "error");
	}
}

els.targetSelect.addEventListener("change", () => {
	const value = els.targetSelect.value.trim();
	if (els.targetInput) els.targetInput.value = value;
	void saveTarget(value);
});
els.saveTarget.addEventListener("click", () => {
	void saveTarget(els.targetInput.value.trim());
});
els.clearTarget.addEventListener("click", () => {
	els.targetInput.value = "";
	els.targetSelect.value = "";
	void saveTarget("");
});
els.saveToken.addEventListener("click", () => {
	state.token = els.tokenInput.value.trim();
	state.launchPath = els.launchPathInput.value.trim();
	state.rememberToken = els.rememberToken.checked;
	saveSettings();
	setStatus(state.token ? "Settings saved." : "Token cleared.");
	void refreshStatus();
});
els.launchPathInput.addEventListener("change", () => {
	state.launchPath = els.launchPathInput.value.trim();
});
els.clearToken.addEventListener("click", () => {
	state.token = "";
	saveSettings();
	setStatus("Token forgotten.");
});
els.rememberToken.addEventListener("change", () => {
	state.rememberToken = els.rememberToken.checked;
	saveSettings();
});
els.audioToggle.addEventListener("change", () => {
	state.wantAudio = els.audioToggle.checked;
	saveSettings();
	updateRecordingUi();
});
els.autoplayToggle.addEventListener("change", () => {
	state.autoplay = els.autoplayToggle.checked;
	saveSettings();
});

loadSettings();
registerServiceWorker();
bindInstallPrompt();
void refreshStatus();
}
