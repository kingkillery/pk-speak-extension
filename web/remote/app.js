export const STORAGE_TOKEN = "piSpeakRemoteToken";
export const STORAGE_AUDIO = "piSpeakRemoteAudio";
export const STORAGE_AUTOPLAY = "piSpeakRemoteAutoplay";
export const STORAGE_REMEMBER = "piSpeakRemoteRememberToken";

export function loadPersistedSettings({
	queryToken = "",
	sessionToken = "",
	localToken = "",
	rememberToken = false,
	audio = "true",
	autoplay = "true",
} = {}) {
	return {
		token: queryToken || sessionToken || localToken || "",
		wantAudio: audio !== "false",
		autoplay: autoplay !== "false",
		rememberToken,
		shouldPersistQueryToken: !!queryToken,
	};
}

export function persistSettingsSnapshot({ token = "", wantAudio = true, autoplay = true, rememberToken = false } = {}) {
	return {
		session: token ? { [STORAGE_TOKEN]: token } : {},
		local: {
			...(rememberToken && token ? { [STORAGE_TOKEN]: token } : {}),
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
	statusNote: document.getElementById("status-note"),
	transcript: document.getElementById("transcript-output"),
	reply: document.getElementById("reply-output"),
	audio: document.getElementById("reply-audio"),
	audioNote: document.getElementById("audio-note"),
	textInput: document.getElementById("text-input"),
	sendText: document.getElementById("send-text-button"),
	clearText: document.getElementById("clear-text-button"),
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
}

function setReplyText(text) {
	els.reply.textContent = text && text.trim() ? text.trim() : "No reply yet.";
}

function setTranscript(text) {
	els.transcript.textContent = text && text.trim() ? text.trim() : "No transcript yet.";
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
		els.audio.classList.add("hidden");
		els.audioNote.textContent = "Requested audio replies will appear here.";
		return;
	}

	const audioUrl = new URL(url, window.location.origin);
	if (state.token) audioUrl.searchParams.set("token", state.token);
	els.audio.src = audioUrl.toString();
	els.audio.classList.remove("hidden");
	els.audioNote.textContent = "Reply audio ready.";
	if (state.autoplay) {
		els.audio.play().catch(() => {
			els.audioNote.textContent = "Reply audio ready. Tap play if autoplay is blocked.";
		});
	}
}

function syncSettingsUi() {
	els.origin.textContent = window.location.origin;
	els.secure.textContent = window.isSecureContext ? "Yes" : "No";
	els.audio.textContent = "";
	els.audioToggle.checked = state.wantAudio;
	els.autoplayToggle.checked = state.autoplay;
	els.rememberToken.checked = state.rememberToken;
	els.tokenInput.value = state.token;
	els.auth.textContent = state.token ? "Token loaded" : "No token";
}

function loadSettings() {
	const queryToken = new URL(window.location.href).searchParams.get("token");
	state.rememberToken = getLocalStorage().getItem(STORAGE_REMEMBER) === "true";
	state.token =
		queryToken ||
		getSessionStorage().getItem(STORAGE_TOKEN) ||
		getLocalStorage().getItem(STORAGE_TOKEN) ||
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
	try {
		const payload = await apiFetch("/v1/turn/text", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, audio: state.wantAudio }),
		});
		setTranscript("");
		setReplyText(payload && payload.replyText ? payload.replyText : "");
		setAudio(payload ? payload.audioUrl : "");
		setStatus("Turn complete.");
		await refreshStatus();
	} catch (error) {
		setStatus(String(error.message || error), "error");
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
		els.recordSubtitle.textContent = "Mic opens on demand";
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
		const payload = await apiFetch(`/v1/turn/voice?audio=${state.wantAudio ? "1" : "0"}`, {
			method: "POST",
			headers: { "Content-Type": blob.type || "application/octet-stream" },
			body: blob,
		});
		setTranscript(payload && payload.transcript ? payload.transcript : "");
		setReplyText(payload && payload.replyText ? payload.replyText : "");
		setAudio(payload ? payload.audioUrl : "");
		setStatus("Voice turn complete.");
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
els.saveToken.addEventListener("click", () => {
	state.token = els.tokenInput.value.trim();
	state.rememberToken = els.rememberToken.checked;
	saveSettings();
	setStatus(state.token ? "Token saved." : "Token cleared.");
	void refreshStatus();
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
