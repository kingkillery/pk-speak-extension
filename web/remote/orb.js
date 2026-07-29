// @ts-check
import { approvalControlType, normalizeApproval } from "/orb/orb-approvals.js";
import { createBargeInDetector } from "/app/barge-in-detector.js";
/**
 * Desktop/terminal Live orb — HF methodology audio path against pi-speak /v1/live.
 * Meant to run outside the full remote chrome (Edge --app=/orb/).
 */

const STORAGE = {
	gateDb: "piSpeakOrbGateDb",
	gateOn: "piSpeakOrbGateOn",
	token: "piSpeakRemoteToken",
};



/** @typedef {"idle"|"connecting"|"ready"|"listening"|"user-speaking"|"processing"|"ai-speaking"|"error"} OrbState */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const orb = /** @type {HTMLButtonElement} */ ($("#orb"));
const caption = $("#caption");
const subcaption = $("#subcaption");
const backendLabel = $("#backend-label");
const chat = $("#chat");
const approvalsEl = $("#approvals");
const muteBtn = /** @type {HTMLButtonElement} */ ($("#mute-btn"));
const camBtn = /** @type {HTMLButtonElement} */ ($("#cam-btn"));
const closeBtn = /** @type {HTMLButtonElement} */ ($("#close-btn"));
const stopBtn = /** @type {HTMLButtonElement} */ ($("#stop-btn"));
const gateInput = /** @type {HTMLInputElement} */ ($("#gate-db"));
const gateValue = $("#gate-value");
const meterFill = $("#meter-fill");
const camPip = /** @type {HTMLVideoElement} */ ($("#cam-pip"));
const speechPanel = $("#speech-panel");
const speechText = $("#speech-text");
const speechAudio = /** @type {HTMLAudioElement} */ ($("#speech-audio"));
const speechStopBtn = /** @type {HTMLButtonElement} */ ($("#speech-stop-btn"));
const speechDisableBtn = /** @type {HTMLButtonElement} */ ($("#speech-disable-btn"));
const speechEnableBtn = /** @type {HTMLButtonElement} */ ($("#speech-enable-btn"));
const speechStatus = $("#speech-status");

/** @type {OrbState} */
let state = "idle";
let ws = /** @type {WebSocket | null} */ (null);
let sessionId = "";
let clientSeq = 0;
let lastServerSeq = 0;
const transcriptBuffers = { user: "", assistant: "" };
const transcriptBubbles = { user: null, assistant: null };
let audioCtx = /** @type {AudioContext | null} */ (null);
let captureNode = /** @type {AudioWorkletNode | null} */ (null);
let playbackNode = /** @type {AudioWorkletNode | null} */ (null);
let captureSource = /** @type {MediaStreamAudioSourceNode | null} */ (null);
let micStream = /** @type {MediaStream | null} */ (null);
let cameraStream = /** @type {MediaStream | null} */ (null);
let muted = false;
let cameraOn = false;
let playbackRate = 24000;
let workletsReady = false;
let liveConnected = false;
let voiceMetricsEnabled = false;
let voiceMetricsProvider = "";
let voiceMetricsModel = "";
let voiceMetricsTurnDetection = "server_vad";
let voiceMetricsEagerness = "default";
let voiceMetricTurnId = 0;
let voiceMetric = null;
const voiceMetricSamples = [];
let bargeInSpeechOnsetMs = 0;
const bargeInDetector = createBargeInDetector();
/** @type {Record<string, ReturnType<typeof normalizeApproval>>} */
const pendingApprovals = {};

function token() {
	const q = new URL(location.href).searchParams.get("token");
	if (q) {
		try { sessionStorage.setItem(STORAGE.token, q); } catch {}
		return q;
	}
	try {
		return sessionStorage.getItem(STORAGE.token) || localStorage.getItem(STORAGE.token) || "";
	} catch {
		return "";
	}
}

function wsUrl() {
	const u = new URL("/v1/live", location.origin);
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
	const t = token();
	if (t) u.searchParams.set("token", t);
	return u.toString();
}

/** @param {OrbState} next */
function setState(next) {
	state = next;
	orb.className = `orb state-${next}`;
	const labels = {
		idle: "Tap the orb to talk",
		connecting: "Connecting…",
		ready: "Ready — listening",
		listening: "Listening",
		"user-speaking": "Hearing you",
		processing: "Working…",
		"ai-speaking": "Speaking",
		error: "Something went wrong",
	};
	caption.textContent = labels[next] || next;
	stopBtn.disabled = next === "idle" || next === "error";
}

/** @param {"user"|"assistant"|"tool"|"system"} role @param {string} text */

function renderApprovals() {
	if (!approvalsEl) return;
	approvalsEl.innerHTML = "";
	const list = Object.values(pendingApprovals).filter(Boolean);
	for (const approval of list) {
		const card = document.createElement("div");
		card.className = "approval-card";
		const title = document.createElement("strong");
		title.textContent = approval.name === "execute_terminal_command" ? "Terminal approval" : "Action approval";
		const command = document.createElement("code");
		command.textContent = approval.command || approval.message || "(unknown)";
		const reason = document.createElement("span");
		reason.className = "muted";
		reason.textContent = approval.reason ? `Reason: ${approval.reason}` : (approval.message || "Needs confirmation.");
		const actions = document.createElement("div");
		actions.className = "approval-actions";
		const approve = document.createElement("button");
		approve.type = "button";
		approve.className = "btn primary";
		approve.textContent = "Approve";
		approve.addEventListener("click", () => sendApproval(approval, true));
		const reject = document.createElement("button");
		reject.type = "button";
		reject.className = "btn";
		reject.textContent = "Reject";
		reject.addEventListener("click", () => sendApproval(approval, false));
		actions.appendChild(approve);
		actions.appendChild(reject);
		card.appendChild(title);
		card.appendChild(command);
		card.appendChild(reason);
		card.appendChild(actions);
		approvalsEl.appendChild(card);
	}
}

function rememberApproval(message) {
	const normalized = normalizeApproval(message);
	if (!normalized) return;
	pendingApprovals[normalized.approvalId] = normalized;
	renderApprovals();
	pushBubble("system", `Approval needed: ${normalized.command || normalized.name || "action"}`);
	setState("processing");
}

function clearApproval(approvalId) {
	if (!approvalId) return;
	delete pendingApprovals[approvalId];
	renderApprovals();
}

function sendApproval(approval, approved) {
	if (!approval?.approvalId) return;
	const type = approvalControlType(approval, approved);
	sendJson({ type, approvalId: approval.approvalId });
	clearApproval(approval.approvalId);
	pushBubble("system", approved ? `Approved ${approval.approvalId}` : `Rejected ${approval.approvalId}`);
}

function pushBubble(role, text) {
	if (!text?.trim()) return;
	const el = document.createElement("div");
	el.className = `bubble ${role}`;
	el.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
	el.querySelector(".body").textContent = text.trim();
	chat.appendChild(el);
	while (chat.children.length > 40) chat.firstChild?.remove();
	chat.scrollTop = chat.scrollHeight;
}

function appendTranscript(role, text) {
	const normalizedRole = role === "user" ? "user" : "assistant";
	if (!text) return;
	transcriptBuffers[normalizedRole] += text;
	let el = transcriptBubbles[normalizedRole];
	if (!el || !chat.contains(el)) {
		el = document.createElement("div");
		el.className = `bubble ${normalizedRole}`;
		el.innerHTML = `<div class="role">${normalizedRole}</div><div class="body"></div>`;
		chat.appendChild(el);
		transcriptBubbles[normalizedRole] = el;
	}
	el.querySelector(".body").textContent = transcriptBuffers[normalizedRole].trim();
	chat.scrollTop = chat.scrollHeight;
}

function finishTranscript(role) {
	const normalizedRole = role === "user" ? "user" : "assistant";
	transcriptBuffers[normalizedRole] = "";
	transcriptBubbles[normalizedRole] = null;
}

function loadGate() {
	const on = (localStorage.getItem(STORAGE.gateOn) || "true") !== "false";
	const db = Number.parseFloat(localStorage.getItem(STORAGE.gateDb) || "-50");
	gateInput.value = String(Number.isFinite(db) ? db : -50);
	gateValue.textContent = `${gateInput.value} dB`;
	return { enabled: on, thresholdDb: Number(gateInput.value) };
}

function applyGate() {
	const enabled = (localStorage.getItem(STORAGE.gateOn) || "true") !== "false";
	const thresholdDb = Number(gateInput.value);
	localStorage.setItem(STORAGE.gateDb, String(thresholdDb));
	gateValue.textContent = `${thresholdDb} dB`;
	captureNode?.port.postMessage({ kind: "gate", enabled, thresholdDb });
	bargeInDetector.setGateThresholdDb(thresholdDb, enabled);
}

function metricPercentile(values, percentile) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)];
}

function emitTurnMetric() {
	const sample = {
		kind: "turn",
		turnId: voiceMetric.turnId,
		provider: voiceMetric.provider || voiceMetricsProvider,
		model: voiceMetric.model || voiceMetricsModel,
		turnDetection: voiceMetricsTurnDetection,
		eagerness: voiceMetricsEagerness,
		vadSpeechEndClientMs: voiceMetric.speechEndClientMs,
		lastPcmSentUpstreamMs: voiceMetric.lastPcmSentUpstreamMs,
		firstUpstreamEventMs: voiceMetric.firstUpstreamEventMs,
		firstPcmEnqueuedClientMs: voiceMetric.firstPcmEnqueuedClientMs,
		firstSampleRenderedClientMs: voiceMetric.firstSampleRenderedClientMs,
		renderTimestampSource: voiceMetric.renderTimestampSource,
		timeToFirstAudioMs: voiceMetric.firstSampleRenderedClientMs - voiceMetric.speechEndClientMs,
		upstreamInferenceMs: voiceMetric.firstUpstreamEventMs - voiceMetric.lastPcmSentUpstreamMs,
		localBufferMs: voiceMetric.firstSampleRenderedClientMs - voiceMetric.firstPcmEnqueuedClientMs,
	};
	voiceMetricSamples.push(sample);
	const totals = voiceMetricSamples.map((entry) => entry.timeToFirstAudioMs);
	sample.summary = {
		turns: totals.length,
		p50TimeToFirstAudioMs: metricPercentile(totals, 0.5),
		p95TimeToFirstAudioMs: metricPercentile(totals, 0.95),
	};
	console.info(`[pi-speak-voice-metric] ${JSON.stringify(sample)}`);
	voiceMetric = null;
}

function audioClockToEpochMs(contextTimeSeconds) {
	if (
		audioCtx
		&& Number.isFinite(contextTimeSeconds)
		&& typeof audioCtx.getOutputTimestamp === "function"
		&& Number.isFinite(performance.timeOrigin)
	) {
		const output = audioCtx.getOutputTimestamp();
		if (Number.isFinite(output?.contextTime) && Number.isFinite(output?.performanceTime)) {
			return {
				timeMs: performance.timeOrigin + output.performanceTime
					+ (contextTimeSeconds - output.contextTime) * 1000,
				source: "audio-clock",
			};
		}
	}
	return { timeMs: Date.now(), source: "main-thread-fallback" };
}

function handlePlaybackMetric(event) {
	if (!voiceMetricsEnabled) return;
	if (event.data?.kind === "playback_started" && voiceMetric) {
		const rendered = audioClockToEpochMs(Number(event.data.contextTimeSeconds));
		voiceMetric.firstSampleRenderedClientMs = rendered.timeMs;
		voiceMetric.renderTimestampSource = rendered.source;
		emitTurnMetric();
	} else if (event.data?.kind === "cleared" && bargeInSpeechOnsetMs) {
		const silenced = audioClockToEpochMs(Number(event.data.contextTimeSeconds));
		const playbackSilencedClientMs = silenced.timeMs;
		const speechOnsetToSilenceMs = playbackSilencedClientMs - bargeInSpeechOnsetMs;
		console.info(`[pi-speak-voice-metric] ${JSON.stringify({
			kind: "barge_in",
			provider: voiceMetricsProvider,
			model: voiceMetricsModel,
			speechOnsetClientMs: bargeInSpeechOnsetMs,
			playbackSilencedClientMs,
			renderTimestampSource: silenced.source,
			speechOnsetToSilenceMs,
			pass: speechOnsetToSilenceMs < 200,
		})}`);
		bargeInSpeechOnsetMs = 0;
	}
}

async function ensureAudio() {
	if (audioCtx && audioCtx.state !== "closed") {
		if (audioCtx.state === "suspended") await audioCtx.resume();
		return audioCtx;
	}
	const AC = window.AudioContext || window.webkitAudioContext;
	audioCtx = new AC({ latencyHint: "interactive" });
	window.audioCtx = audioCtx;
	await Promise.all([
		audioCtx.audioWorklet.addModule("/app/live-capture-worklet.js"),
		audioCtx.audioWorklet.addModule("/app/live-playback-worklet.js"),
	]);
	playbackNode = new AudioWorkletNode(audioCtx, "pi-speak-live-playback", {
		numberOfInputs: 0,
		numberOfOutputs: 1,
		outputChannelCount: [1],
	});
	playbackNode.port.postMessage({ kind: "config", inputRate: playbackRate });
	playbackNode.port.onmessage = handlePlaybackMetric;
	playbackNode.connect(audioCtx.destination);
	workletsReady = true;
	return audioCtx;
}

function encodeFrame(seq, int16) {
	const samples = int16 instanceof Int16Array ? int16 : new Int16Array(int16);
	const frame = new ArrayBuffer(4 + samples.byteLength);
	const view = new DataView(frame);
	view.setInt32(0, seq, false);
	new Uint8Array(frame, 4).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
	return frame;
}

function decodeFrame(buf) {
	const bytes = buf instanceof ArrayBuffer ? buf : buf.buffer;
	if (!bytes || bytes.byteLength < 6) return null;
	const view = new DataView(bytes);
	const samples = new Float32Array((bytes.byteLength - 4) / 2);
	for (let i = 0; i < samples.length; i++) {
		const s = view.getInt16(4 + i * 2, true);
		samples[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
	}
	return { seq: view.getInt32(0, false), samples };
}

function clearPlayback() {
	playbackNode?.port.postMessage({ kind: "clear" });
	document.documentElement.style.setProperty("--ai-audio-level", "0");
}

function sendJson(payload) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	clientSeq += 1;
	ws.send(JSON.stringify({ ...payload, clientSequenceId: clientSeq }));
}

async function startCapture() {
	const ctx = await ensureAudio();
	micStream = await navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
	});
	captureSource = ctx.createMediaStreamSource(micStream);
	captureNode = new AudioWorkletNode(ctx, "pi-speak-live-capture", {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [1],
		processorOptions: { chunkMs: 40 },
	});
	const sink = ctx.createGain();
	sink.gain.value = 0;
	captureNode.port.onmessage = (ev) => {
		const data = ev.data;
		if (data && typeof data === "object" && !(data instanceof ArrayBuffer) && data.kind === "level") {
			const rms = Number(data.rms) || 0;
			const level = Math.min(1, rms * 8);
			document.documentElement.style.setProperty("--audio-level", String(level));
			meterFill.style.width = `${Math.round(level * 100)}%`;
			if (!muted && liveConnected) {
				const decision = bargeInDetector.observe({
					rms,
					nowMs: Date.now(),
					aiPlaying: state === "ai-speaking",
					muted: false,
				});
				if (decision.interrupt) {
					if (voiceMetricsEnabled) bargeInSpeechOnsetMs = Date.now();
					clearPlayback();
					sendJson({ type: "interrupt" });
					setState("user-speaking");
				} else if (decision.userSpeaking && state !== "processing") {
					setState("user-speaking");
				} else if (decision.speechEnded) {
					if (voiceMetricsEnabled) {
						voiceMetricTurnId += 1;
						voiceMetric = { turnId: voiceMetricTurnId, speechEndClientMs: Date.now() };
						sendJson({
							type: "voice_metric",
							event: "speech_end",
							turnId: voiceMetricTurnId,
							clientTimeMs: voiceMetric.speechEndClientMs,
						});
					}
					setState("listening");
				}
			}
			return;
		}
		if (!ws || ws.readyState !== WebSocket.OPEN || muted) return;
		let int16;
		if (data instanceof ArrayBuffer) int16 = new Int16Array(data);
		else if (data instanceof Int16Array) int16 = data;
		else return;
		clientSeq += 1;
		ws.send(encodeFrame(clientSeq, int16));
	};
	captureSource.connect(captureNode);
	captureNode.connect(sink);
	sink.connect(ctx.destination);
	applyGate();
	captureNode.port.postMessage({ kind: "enable", value: !muted });
}

function stopCapture() {
	try { captureNode?.disconnect(); } catch {}
	try { captureSource?.disconnect(); } catch {}
	captureNode = null;
	captureSource = null;
	if (micStream) {
		for (const t of micStream.getTracks()) t.stop();
		micStream = null;
	}
	document.documentElement.style.setProperty("--audio-level", "0");
	meterFill.style.width = "0%";
}

async function connect() {
	if (ws) return;
	setState("connecting");
	await ensureAudio();
	await startCapture();
	ws = new WebSocket(wsUrl());
	ws.binaryType = "arraybuffer";
	ws.addEventListener("open", () => {
		const cwd = new URL(location.href).searchParams.get("cwd");
		if (cwd) sendJson({ type: "configure", cwd });
	});
	ws.addEventListener("message", async (event) => {
		if (typeof event.data !== "string") {
			const decoded = decodeFrame(event.data);
			if (!decoded) return;
			lastServerSeq = Math.max(lastServerSeq, decoded.seq);
			const copy = new Float32Array(decoded.samples.length);
			copy.set(decoded.samples);
			if (voiceMetricsEnabled && voiceMetric && !voiceMetric.firstPcmEnqueuedClientMs) {
				voiceMetric.firstPcmEnqueuedClientMs = Date.now();
			}
			playbackNode?.port.postMessage({ kind: "audio", samples: copy }, [copy.buffer]);
			setState("ai-speaking");
			document.documentElement.style.setProperty("--ai-audio-level", "0.7");
			return;
		}
		let msg;
		try { msg = JSON.parse(event.data); } catch { return; }
		if (Number.isInteger(msg.serverSequenceId)) lastServerSeq = Math.max(lastServerSeq, msg.serverSequenceId);
		if (msg.type === "audio_format" && msg.rate > 0) {
			playbackRate = msg.rate;
			playbackNode?.port.postMessage({ kind: "config", inputRate: playbackRate });
			return;
		}
		if (msg.type === "start") {
			liveConnected = true;
			sessionId = msg.session || sessionId;
			if (msg.message) backendLabel.textContent = String(msg.message);
			voiceMetricsProvider = String(msg.provider || msg.message || "");
			voiceMetricsModel = String(msg.model || "");
			voiceMetricsEnabled = msg.voiceMetricsEnabled === true;
			window.voiceMetricsEnabled = voiceMetricsEnabled;
			if (voiceMetricsEnabled) {
				console.info(`[pi-speak-voice-metric] ${JSON.stringify({ kind: "handshake", voiceMetricsEnabled, provider: voiceMetricsProvider, model: voiceMetricsModel })}`);
			}
			setState("listening");
			subcaption.textContent = sessionId ? `Session ${sessionId}` : "Live";
			return;
		}
		if (msg.type === "voice_metric" && msg.event === "upstream_timing") {
			if (voiceMetricsEnabled && voiceMetric?.turnId === msg.turnId) {
				voiceMetricsProvider = String(msg.provider || voiceMetricsProvider);
				voiceMetricsModel = String(msg.model || voiceMetricsModel);
				Object.assign(voiceMetric, {
					lastPcmSentUpstreamMs: msg.lastPcmSentUpstreamMs,
					firstUpstreamEventMs: msg.firstUpstreamEventMs,
					provider: msg.provider,
					model: msg.model,
				});
				emitTurnMetric();
			}
			return;
		}
		if (msg.type === "transcript" && msg.text) {
			appendTranscript(msg.role, msg.text);
			return;
		}
		if (msg.type === "transcript_complete") {
			finishTranscript(msg.role);
			return;
		}
		if (msg.type === "interrupt") {
			finishTranscript("assistant");
			clearPlayback();
			// User may still be mid-interjection; detector drives listening/speaking.
			if (state === "ai-speaking" || state === "processing") setState("user-speaking");
			return;
		}
		if (msg.type === "tool_start") {
			setState("processing");
			pushBubble("tool", msg.name || msg.command || "tool");
			return;
		}
		if (msg.type === "tool_complete") {
			setState("listening");
			pushBubble("tool", `${msg.name || "tool"} done`);
			return;
		}
		if (msg.type === "tool_approval_required") {
			rememberApproval(msg);
			return;
		}
		if (msg.type === "tool_approval_resolved") {
			clearApproval(msg.approvalId);
			pushBubble("system", msg.message || "Approval resolved.");
			setState("listening");
			return;
		}
		if (msg.type === "camera_capture") {
			setState("processing");
			await sendCameraFrame(msg.callId, msg.reason);
			return;
		}
		if (msg.type === "error") {
			setState("error");
			pushBubble("system", msg.message || "error");
			subcaption.textContent = msg.message || "error";
		}
	});
	ws.addEventListener("close", () => {
		liveConnected = false;
		ws = null;
		stopCapture();
		clearPlayback();
		setState("idle");
		subcaption.textContent = "Disconnected";
	});
	ws.addEventListener("error", () => {
		setState("error");
		subcaption.textContent = "Socket error";
	});
}

function teardown() {
	try { ws?.close(); } catch {}
	ws = null;
	liveConnected = false;
	stopCapture();
	clearPlayback();
	if (cameraStream) {
		for (const t of cameraStream.getTracks()) t.stop();
		cameraStream = null;
		camPip.srcObject = null;
		camPip.classList.add("hidden");
		cameraOn = false;
	}
	if (audioCtx) {
		void audioCtx.close().catch(() => {});
		audioCtx = null;
		playbackNode = null;
		workletsReady = false;
	}
	setState("idle");
}

async function sendCameraFrame(callId, reason) {
	try {
		if (!cameraStream) {
			cameraStream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
				audio: false,
			});
			camPip.srcObject = cameraStream;
			camPip.classList.remove("hidden");
			cameraOn = true;
		}
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = cameraStream;
		await video.play().catch(() => {});
		await new Promise((r) => {
			if (video.readyState >= 2) r(undefined);
			else video.onloadeddata = () => r(undefined);
			setTimeout(r, 700);
		});
		const maxEdge = 768;
		const vw = video.videoWidth || 640;
		const vh = video.videoHeight || 480;
		const scale = Math.min(1, maxEdge / Math.max(vw, vh));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(vw * scale));
		canvas.height = Math.max(1, Math.round(vh * scale));
		canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
		const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
		const data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
		sendJson({ type: "camera_frame", callId, mimeType: "image/jpeg", data, reason });
		pushBubble("system", reason || "Camera frame sent");
	} catch (err) {
		sendJson({ type: "camera_frame", callId, data: "", reason: String(err?.message || err) });
		pushBubble("system", `Camera failed: ${err?.message || err}`);
	}
}

orb.addEventListener("click", async () => {
	try {
		if (state === "idle" || state === "error") await connect();
		else teardown();
	} catch (err) {
		setState("error");
		subcaption.textContent = String(err?.message || err);
	}
});

stopBtn.addEventListener("click", () => teardown());
closeBtn.addEventListener("click", () => {
	teardown();
	window.close();
});
muteBtn.addEventListener("click", () => {
	muted = !muted;
	muteBtn.textContent = muted ? "Unmute" : "Mic";
	captureNode?.port.postMessage({ kind: "enable", value: !muted });
});
camBtn.addEventListener("click", async () => {
	if (cameraOn) {
		if (cameraStream) for (const t of cameraStream.getTracks()) t.stop();
		cameraStream = null;
		camPip.srcObject = null;
		camPip.classList.add("hidden");
		cameraOn = false;
		camBtn.textContent = "Cam";
		return;
	}
	try {
		cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
		camPip.srcObject = cameraStream;
		camPip.classList.remove("hidden");
		cameraOn = true;
		camBtn.textContent = "Cam on";
	} catch (err) {
		pushBubble("system", `Camera: ${err?.message || err}`);
	}
});
gateInput.addEventListener("input", () => {
	localStorage.setItem(STORAGE.gateOn, "true");
	applyGate();
});

loadGate();
setState("idle");
requestAnimationFrame(() => document.body.classList.remove("booting"));

const launchParams = new URL(location.href).searchParams;
const launchMode = launchParams.get("mode");
const speechId = launchParams.get("speech");

if (launchMode === "speech" && speechId) {
	// One-shot TTS playback mode: never connect /v1/live, never request mic.
	bootSpeechMode(speechId).catch((err) => {
		speechStatus.textContent = `Failed to load speech: ${err?.message || err}`;
	});
} else {
	const auto = launchParams.get("autoconnect");
	if (auto === "1") {
		orb.click();
	}
}

/**
 * @param {string} speechId
 */
async function bootSpeechMode(speechId) {
	// Mark the body so CSS suppresses realtime Live chrome (hero/dock/mic/cam/
	// chat/approvals) and renders the speech panel. Avoids piecemeal .hidden
	// juggling and keeps the layout in CSS where it belongs.
	document.body.classList.add("speech-mode");
	closeBtn.classList.remove("hidden");
	speechPanel.classList.remove("hidden");
	setCaption("Pi Speak reply ready");

	const authHeaders = { "Accept": "application/json" };
	const t = token();
	if (t) authHeaders["x-pi-speak-token"] = t;

	let staged;
	try {
		const res = await fetch(`/v1/speech/staged/${encodeURIComponent(speechId)}`, { headers: authHeaders });
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.error || `HTTP ${res.status}`);
		}
		staged = await res.json();
	} catch (err) {
		speechText.textContent = "(Could not load reply text.)";
		speechStatus.textContent = String(err?.message || err);
		return;
	}
	speechText.textContent = staged.text || "(no text)";
	// The <audio> element is the operator's control surface: pause/resume
	// via the native controls, Stop and Disable speech via the buttons below.
	const audioUrl = new URL(staged.audioUrl, location.origin).toString();
	const audioParams = new URLSearchParams();
	if (t) audioParams.set("token", t);
	speechAudio.src = `${audioUrl}?${audioParams.toString()}`;
	// Deliberately do NOT call speechAudio.play() — the user explicitly
	// asked for "no autoplay, controls in the UI".

	updateDisableButtonState(!!staged.speechDisabled);

	speechAudio.addEventListener("ended", () => {
		speechStatus.textContent = "Playback finished.";
	});
	speechAudio.addEventListener("error", () => {
		speechStatus.textContent = "Audio playback error.";
	});
	speechStopBtn.addEventListener("click", () => {
		speechAudio.pause();
		speechAudio.currentTime = 0;
		speechStatus.textContent = "Stopped.";
	});
	speechDisableBtn.addEventListener("click", async () => {
		speechDisableBtn.disabled = true;
		try {
			const res = await fetch("/v1/speech/disable", {
				method: "POST",
				headers: { ...authHeaders, "Content-Type": "application/json" },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			updateDisableButtonState(true);
			speechStatus.textContent = "Speech disabled. Future terminal replies will be silent.";
		} catch (err) {
			speechDisableBtn.disabled = false;
			speechStatus.textContent = `Failed to disable: ${err?.message || err}`;
		}
	});
	speechEnableBtn.addEventListener("click", async () => {
		speechEnableBtn.disabled = true;
		try {
			const res = await fetch("/v1/speech/enable", {
				method: "POST",
				headers: { ...authHeaders, "Content-Type": "application/json" },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			updateDisableButtonState(false);
			speechStatus.textContent = "Speech re-enabled.";
		} catch (err) {
			speechEnableBtn.disabled = false;
			speechStatus.textContent = `Failed to re-enable: ${err?.message || err}`;
		}
	});
}

/** @param {boolean} disabled */
function updateDisableButtonState(disabled) {
	speechDisableBtn.hidden = disabled;
	speechDisableBtn.disabled = false;
	speechEnableBtn.hidden = !disabled;
	speechEnableBtn.disabled = false;
}

/** @param {string} text */
function setCaption(text) {
	caption.textContent = text;
	subcaption.textContent = "";
}
