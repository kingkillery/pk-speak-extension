import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { ControlServer, type ControlServerState } from "./control-server.js";
import { TelegramPhoneBridge, type PhoneBridgeState, type PhoneTurnResult } from "./phone-bridge.js";
import { transcribeAudioBuffer } from "./stt.js";
import {
	describeTtsProvider,
	getAudioMimeType,
	isRewriteEnabled,
	resolveTtsProvider,
	synthesizeToFile,
	type SpeakRuntimeState,
	type TtsProvider,
} from "./tts.js";

type SpeakState = SpeakRuntimeState & {
	enabled: boolean;
};

type MonoState = {
	listening: boolean;
};

type SessionRegistryState = {
	sessions: Record<string, string>; // name -> sessionPath
};

type RemoteState = ControlServerState;

type PendingPhoneTurn = {
	resolve: (result: PhoneTurnResult) => void;
	reject: (error: Error) => void;
	transcript?: string;
	wantAudio?: boolean;
};

type ListenerEvent =
	| { type: "wake"; state: "on" | "off" | "ping"; reason?: string; target?: string }
	| { type: "speech"; text: string }
	| { type: "transcribing" }
	| { type: "status"; message: string }
	| { type: "error"; message: string };

type ContentBlock = {
	type?: string;
	text?: string;
};

const STATE_TYPE = "elevenlabs-speak-state";
const MONO_STATE_TYPE = "mono-listener-state";
const PHONE_STATE_TYPE = "phone-bridge-state";
const REMOTE_STATE_TYPE = "remote-control-state";
const SESSION_REGISTRY_TYPE = "session-registry";
const AVAILABLE_TTS_PROVIDERS: TtsProvider[] = ["auto", "legacy", "edge", "openai", "elevenlabs"];
const MONO_KEEP_ALIVE_SECONDS = Number.parseFloat(
	process.env.PI_SPEAK_MONO_ACTIVITY_TIMEOUT || process.env.MONO_ACTIVITY_TIMEOUT || "15",
);
const PHONE_TURN_WAIT_TIMEOUT_MS = Number.parseInt(process.env.PI_SPEAK_PHONE_WAIT_TIMEOUT_MS || "180000", 10);
const DEFAULT_REMOTE_HOST = process.env.PI_SPEAK_HTTP_HOST || "0.0.0.0";
const DEFAULT_REMOTE_PORT = Number.parseInt(process.env.PI_SPEAK_HTTP_PORT || "8767", 10);
const DEFAULT_VOICE = "adam";
const SPEECH_MODE_PROMPT = `Activate CodeChat mode for this conversation.

Speech pipeline for this session:
1. The user submits text.
2. Pi generates the full assistant response for the UI.
3. The spoken version may be lightly rewritten for audio clarity.
4. The spoken version is synthesized by the configured TTS provider.

Core behavior:
- Be highly conversational, concise, and easy to follow when heard out loud.
- Prefer short paragraphs over lists unless lists are clearly better.
- Avoid markdown tables unless I explicitly ask for one.
- Do not read or emphasize full file paths unless absolutely necessary. Prefer filenames, folder names, or short relative locations.
- Translate raw command output, stack traces, JSON, diffs, and logs into plain English first.
- When discussing code, start with the high-level purpose, then the important details, then next actions.
- Build context progressively: first explain what the repo or feature seems to do, then zoom into the relevant files and functions.
- Prefer README, docs, AGENTS.md, CLAUDE.md, specs, plans, and nearby source before going broad.
- If you need to inspect code, use tools and summarize what you found in a speech-friendly way.
- If you want to make changes, first explain the intent in one or two plain-English sentences.
- For dangerous or irreversible actions, explicitly ask for approval before proceeding.
- When the user asks follow-up questions, keep continuity and act like you are talking about the same codebase live.

Response style:
- Sound like a smart teammate talking, not a report generator.
- Keep answers tight by default and expand only when useful.
- Mention filenames and functions naturally, like â€œin speak11.pyâ€ or â€œthe listen function,â€ instead of long path strings.
- End with the clearest next useful point or question.`;

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is ContentBlock => !!part && typeof part === "object")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!.trim())
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

function getSpeakInvocation(outputPath: string) {
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const pyScript = join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.py");
	const cmdScript = join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.cmd");
	const python = existsSync("C:/Python314/python.exe") ? "C:/Python314/python.exe" : "python";

	if (existsSync(pyScript)) {
		return { command: python, args: [pyScript, "--stdin", "-s", "-v", DEFAULT_VOICE, "-o", outputPath] };
	}
	if (existsSync(cmdScript)) {
		return { command: "cmd.exe", args: ["/c", cmdScript, "--stdin", "-s", "-v", DEFAULT_VOICE, "-o", outputPath] };
	}
	return { command: "cmd.exe", args: ["/c", "speak11", "--stdin", "-s", "-v", DEFAULT_VOICE, "-o", outputPath] };
}

function getPlayerInvocation(filePath: string) {
	const escaped = filePath.replace(/\\/g, "\\\\");
	const ps = `
Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]::new("${escaped}"))
Start-Sleep -Milliseconds 250
$player.Play()
while ($player.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }
$duration = [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds)
Start-Sleep -Milliseconds ($duration + 1200)
$player.Stop()
$player.Close()
`;
	return { command: "powershell.exe", args: ["-NoProfile", "-Command", ps] };
}

function getExtensionDir(): string {
	// When loaded from dist/, listener/ is a sibling of dist/ â†’ go up one level.
	// When loaded directly (e.g. ~/.pi/agent/extensions/speak.ts), listener/ is a
	// sibling of the .ts file â†’ __dirname is already correct.
	const candidate = join(__dirname, "..", "listener", "listener.py");
	if (existsSync(candidate)) return join(__dirname, "..");
	return __dirname;
}

function getPython(): string {
	if (existsSync("C:/Python314/python.exe")) return "C:/Python314/python.exe";
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const localPy = join(home, "AppData", "Local", "Microsoft", "WindowsApps", "python3.exe");
	if (existsSync(localPy)) return localPy;
	return "python";
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function getTelegramBotToken() {
	return process.env.PI_SPEAK_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

export default function speakExtension(pi: ExtensionAPI) {
	let speakState: SpeakState = {
		enabled: false,
		provider: "auto",
	};
	let lastAssistantText = "";
	let speakingProcess: ChildProcess | undefined;
	let playerProcess: ChildProcess | undefined;
	let speakAbortController: AbortController | undefined;
	let activeAudioDir: string | undefined;
	let phase: "ready" | "llm" | "rewrite" | "voice" | "playing" = "ready";
	let lastCtx: any;
	let listenerProcess: ChildProcess | undefined;
	let listenerRl: ReturnType<typeof createInterface> | undefined;
	let monoActive = false;
	let voiceInputActive = false;
	let voiceTarget: string | undefined;
	let sessionRegistry: Record<string, string> = {};
	let phoneBridge: TelegramPhoneBridge | undefined;
	let phoneState: PhoneBridgeState = { enabled: false };
	let remoteServer: ControlServer | undefined;
	let remoteState: RemoteState = {
		enabled: false,
		host: DEFAULT_REMOTE_HOST,
		port: DEFAULT_REMOTE_PORT,
		authToken: process.env.PI_SPEAK_HTTP_TOKEN || undefined,
	};
	let pendingPhoneTurn: PendingPhoneTurn | undefined;
	let phoneTurnChain: Promise<unknown> = Promise.resolve();
	let forceSpeechPromptNextTurn = false;

	const getSpeakRuntimeState = (): SpeakRuntimeState => ({
		provider: speakState.provider,
		rewriteEnabled: speakState.rewriteEnabled,
	});

	const updateStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		lastCtx = target;
		if (!speakState.enabled) {
			target.ui.setStatus("speak", "");
			return;
		}
		const provider = resolveTtsProvider(getSpeakRuntimeState());
		const labels: Record<typeof phase, string> = {
			ready: "ready",
			llm: "llm",
			rewrite: "rewrite",
			voice: provider,
			playing: "playing",
		};
		target.ui.setStatus("speak", `speak:${provider} · ${labels[phase]}`);
	};

	const updateMonoStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		if (!monoActive) {
			target.ui.setStatus("mono", "");
			return;
		}
		const label = voiceInputActive
			? voiceTarget
				? `mono:${voiceTarget}`
				: "mono:on"
			: "mono:standby";
		target.ui.setStatus("mono", label);
	};

	const updatePhoneStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		if (!phoneState.enabled) {
			target.ui.setStatus("phone", "");
			return;
		}
		const linked = phoneState.linkedChatId ? "linked" : `pair ${phoneState.linkCode || "pending"}`;
		target.ui.setStatus("phone", `phone:${linked}`);
	};

	const updateRemoteStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		if (!remoteState.enabled) {
			target.ui.setStatus("remote", "");
			return;
		}
		target.ui.setStatus("remote", `remote:${remoteState.port || DEFAULT_REMOTE_PORT}`);
	};

	const setPhase = (next: typeof phase, ctx?: any) => {
		phase = next;
		updateStatus(ctx);
	};

	const persistState = () => {
		pi.appendEntry<SpeakState>(STATE_TYPE, { ...speakState });
	};

	const persistMonoState = () => {
		pi.appendEntry<MonoState>(MONO_STATE_TYPE, { listening: monoActive });
	};

	const persistPhoneState = () => {
		pi.appendEntry<PhoneBridgeState>(PHONE_STATE_TYPE, { ...phoneState });
	};

	const persistRemoteState = () => {
		pi.appendEntry<RemoteState>(REMOTE_STATE_TYPE, { ...remoteState });
	};

	const persistSessionRegistry = () => {
		pi.appendEntry<SessionRegistryState>(SESSION_REGISTRY_TYPE, { sessions: sessionRegistry });
	};

	const syncPhoneState = (patch: Partial<PhoneBridgeState>, persist = false) => {
		phoneState = { ...phoneState, ...patch };
		if (persist) persistPhoneState();
		updatePhoneStatus();
	};

	const syncRemoteState = (patch: Partial<RemoteState>, persist = false) => {
		remoteState = { ...remoteState, ...patch };
		if (persist) persistRemoteState();
		updateRemoteStatus();
	};

	const cleanupAudioFiles = () => {
		if (activeAudioDir && existsSync(activeAudioDir)) {
			try {
				rmSync(activeAudioDir, { recursive: true, force: true });
			} catch {}
		}
		activeAudioDir = undefined;
	};

	const stopSpeaking = (ctx?: any) => {
		speakAbortController?.abort();
		speakAbortController = undefined;
		if (speakingProcess && !speakingProcess.killed) {
			try {
				speakingProcess.kill();
			} catch {}
		}
		if (playerProcess && !playerProcess.killed) {
			try {
				playerProcess.kill();
			} catch {}
		}
		speakingProcess = undefined;
		playerProcess = undefined;
		cleanupAudioFiles();
		setPhase("ready", ctx);
	};

	const playAudioFile = (filePath: string, ctx?: any, audioDir?: string) => {
		setPhase("playing", ctx);
		const player = getPlayerInvocation(filePath);
		const playbackDir = audioDir;
		playerProcess = spawn(player.command, player.args, {
			stdio: "ignore",
			detached: false,
			windowsHide: true,
			shell: false,
		});
		playerProcess.on("exit", () => {
			playerProcess = undefined;
			if (playbackDir && activeAudioDir === playbackDir) cleanupAudioFiles();
			setPhase("ready", ctx);
		});
		playerProcess.on("error", () => {
			playerProcess = undefined;
			if (playbackDir && activeAudioDir === playbackDir) cleanupAudioFiles();
			setPhase("ready", ctx);
		});
	};

	const speakText = async (text: string, ctx?: any) => {
		const trimmed = text.trim();
		if (!speakState.enabled || !trimmed) return;

		stopSpeaking(ctx);

		const audioDir = mkdtempSync(join(tmpdir(), "pi-speak-"));
		const outputPath = join(audioDir, "reply.mp3");
		activeAudioDir = audioDir;

		const abortController = new AbortController();
		speakAbortController = abortController;

		try {
			await synthesizeToFile({
				text: trimmed,
				outputPath,
				state: getSpeakRuntimeState(),
				signal: abortController.signal,
				onPhase: (nextPhase) => setPhase(nextPhase, ctx),
				onLegacyProcess: (process) => {
					speakingProcess = process;
				},
			});
			speakingProcess = undefined;
			if (abortController.signal.aborted) return;
			if (!existsSync(outputPath)) {
				throw new Error("Speech synthesis did not create an audio file");
			}
			playAudioFile(outputPath, ctx, audioDir);
		} catch (error) {
			speakingProcess = undefined;
			if (abortController.signal.aborted) return;
			cleanupAudioFiles();
			setPhase("ready", ctx);
			const target = ctx || lastCtx;
			target?.ui?.notify?.(`Speech synthesis failed: ${getErrorMessage(error)}`, "error");
		} finally {
			if (speakAbortController === abortController) {
				speakAbortController = undefined;
			}
		}
	};

	const renderRemoteAudio = async (text: string, ctx?: any) => {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const audioDir = mkdtempSync(join(tmpdir(), "pi-phone-reply-"));
		const outputPath = join(audioDir, "reply.mp3");
		try {
			await synthesizeToFile({
				text: trimmed,
				outputPath,
				state: getSpeakRuntimeState(),
			});
			return outputPath;
		} catch (error) {
			try {
				rmSync(audioDir, { recursive: true, force: true });
			} catch {}
			const target = ctx || lastCtx;
			target?.ui?.notify?.(`Phone audio synthesis failed: ${getErrorMessage(error)}`, "warning");
			return undefined;
		}
	};

	const findSessionByName = (name: string): string | undefined => {
		const lower = name.toLowerCase();
		for (const [regName, regPath] of Object.entries(sessionRegistry)) {
			if (regName.toLowerCase() === lower) return regPath;
		}
		return undefined;
	};

	const waitForReadyTurnContext = async () => {
		const deadline = Date.now() + PHONE_TURN_WAIT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const ctx = lastCtx;
			if (ctx) {
				const idle = ctx.isIdle?.() ?? true;
				const hasPendingMessages = ctx.hasPendingMessages?.() ?? false;
				if (idle && !hasPendingMessages && !pendingPhoneTurn) {
					return ctx;
				}
			}
			await sleep(250);
		}
		throw new Error("Timed out waiting for Pi to become ready for a phone turn");
	};

	const rejectPendingPhoneTurn = (reason: string) => {
		if (!pendingPhoneTurn) return;
		const pending = pendingPhoneTurn;
		pendingPhoneTurn = undefined;
		pending.reject(new Error(reason));
	};

	const resolvePendingPhoneTurn = async (ctx?: any) => {
		if (!pendingPhoneTurn) return;
		const pending = pendingPhoneTurn;
		pendingPhoneTurn = undefined;
		const replyText = lastAssistantText.trim() || "I finished the turn, but no assistant text was captured.";
		const audioPath = pending.wantAudio ? await renderRemoteAudio(replyText, ctx) : undefined;
		pending.resolve({
			replyText,
			audioPath,
			audioMimeType: audioPath ? getAudioMimeType(audioPath) : undefined,
			transcript: pending.transcript,
		});
	};

	const executePhoneTurn = async (
		text: string,
		transcript?: string,
		wantAudio = true,
	): Promise<PhoneTurnResult> => {
		const trimmed = text.trim();
		if (!trimmed) {
			return { replyText: "I did not receive any text to send to Pi.", transcript };
		}

		await waitForReadyTurnContext();

		return await new Promise<PhoneTurnResult>((resolve, reject) => {
			pendingPhoneTurn = { resolve, reject, transcript, wantAudio };
			forceSpeechPromptNextTurn = true;
			pi.sendUserMessage(trimmed);
		});
	};

	const enqueuePhoneTurn = (text: string, transcript?: string, wantAudio = true) => {
		const turnPromise = phoneTurnChain.then(() => executePhoneTurn(text, transcript, wantAudio));
		phoneTurnChain = turnPromise.catch(() => {});
		return turnPromise;
	};

	const getPhoneStatusText = () => {
		const runtimeStatus = phoneBridge?.getStatus();
		const linked = runtimeStatus?.linkedChatId || phoneState.linkedChatId;
		const linkCode = runtimeStatus?.linkCode || phoneState.linkCode;
		const monoStatus = !monoActive
			? "off"
			: voiceInputActive
				? voiceTarget
					? `active -> ${voiceTarget}`
					: "active"
				: `listening for "pi mono"`;
		const rewriteStatus = isRewriteEnabled(getSpeakRuntimeState()) ? "rewrite on" : "rewrite off";
		return [
			`Phone bridge ${phoneState.enabled ? "running" : "stopped"}.`,
			linked ? "Phone is linked." : `Awaiting link code ${linkCode || "unknown"}.`,
			`Speech replies: ${speakState.enabled ? "on" : "off"} via ${describeTtsProvider(getSpeakRuntimeState())} (${rewriteStatus}).`,
			`Mono listener: ${monoStatus}.`,
		].join(" ");
	};

	const startPhoneBridge = async (ctx?: any, quiet = false) => {
		const token = getTelegramBotToken();
		if (!token) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.(
				"Set PI_SPEAK_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN before enabling /phone",
				"error",
			);
			return false;
		}

		if (!phoneBridge) {
			phoneBridge = new TelegramPhoneBridge({
				token,
				state: phoneState,
				getStatusText: getPhoneStatusText,
				onStateChange: (patch) => {
					const shouldPersist = Object.keys(patch).some((key) => key !== "lastUpdateId");
					syncPhoneState(patch, shouldPersist);
				},
				onTextTurn: async (text) => {
					try {
						return await enqueuePhoneTurn(text);
					} catch (error) {
						return { replyText: `Phone bridge error: ${getErrorMessage(error)}` };
					}
				},
				onVoiceBuffer: async (buffer, mimeType) => {
					try {
						const transcription = await transcribeAudioBuffer(buffer, mimeType);
						if (!transcription.text) {
							return { replyText: "I could not understand that voice message." };
						}
						return await enqueuePhoneTurn(transcription.text, transcription.text);
					} catch (error) {
						return { replyText: `Voice transcription failed: ${getErrorMessage(error)}` };
					}
				},
			});
		}

		phoneBridge.start();
		const status = phoneBridge.getStatus();
		syncPhoneState(
			{
				enabled: true,
				linkedChatId: status.linkedChatId,
				linkCode: status.linkCode,
				lastUpdateId: status.lastUpdateId,
			},
			true,
		);

		if (!quiet) {
			const target = ctx || lastCtx;
			if (status.linkedChatId) {
				target?.ui?.notify?.("Phone bridge running and linked", "info");
			} else {
				target?.ui?.notify?.(
					`Phone bridge running. In Telegram, message your bot and send /link ${status.linkCode}`,
					"info",
				);
			}
		}
		return true;
	};

	const stopPhoneBridge = async (ctx?: any, quiet = false) => {
		rejectPendingPhoneTurn("Phone bridge stopped before the reply was delivered");
		if (phoneBridge) {
			await phoneBridge.stop().catch(() => {});
			phoneBridge = undefined;
		}
		syncPhoneState({ enabled: false }, true);
		if (!quiet) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.("Phone bridge stopped", "info");
		}
	};

	const getSpeakStatus = () => {
		const provider = resolveTtsProvider(getSpeakRuntimeState());
		return {
			enabled: speakState.enabled,
			configuredProvider: speakState.provider || "auto",
			provider,
			rewriteEnabled: isRewriteEnabled(getSpeakRuntimeState()),
			phase,
		};
	};

	const getMonoStatus = () => ({
		running: monoActive,
		voiceInputActive,
		target: voiceTarget,
		keepAliveSeconds: MONO_KEEP_ALIVE_SECONDS,
	});

	const getPhoneStatus = () => ({
		enabled: phoneState.enabled,
		linkedChatId: phoneState.linkedChatId,
		linkCode: phoneState.linkCode,
	});

	const getRemoteStatus = () => {
		const runtime = remoteServer?.getRuntimeState();
		return {
			enabled: !!runtime?.enabled || remoteState.enabled,
			host: runtime?.host || remoteState.host || DEFAULT_REMOTE_HOST,
			port: runtime?.port || remoteState.port || DEFAULT_REMOTE_PORT,
			authRequired: !!(runtime?.authToken || remoteState.authToken),
		};
	};

	const getRemoteStatusText = () => {
		const status = getRemoteStatus();
		const token = remoteServer?.getRuntimeState().authToken || remoteState.authToken || "";
		return [
			`Remote API ${status.enabled ? "running" : "stopped"}.`,
			`Bind: ${status.host}:${status.port}.`,
			token ? `Token: ${token}.` : "Token: not required.",
			"App: /app/.",
			"Endpoints: /v1/status, /v1/turn/text, /v1/turn/voice.",
		].join(" ");
	};

	const handleMonoAction = async (action: "on" | "off" | "status", ctx?: any) => {
		if (action === "on") {
			startListener(ctx);
			persistMonoState();
			return {
				ok: true,
				message: `Voice listener started. Say "pi mono" to activate (${MONO_KEEP_ALIVE_SECONDS}s keep-alive).`,
				mono: getMonoStatus(),
			};
		}
		if (action === "off") {
			stopListener(ctx);
			persistMonoState();
			return { ok: true, message: "Voice listener stopped.", mono: getMonoStatus() };
		}
		const sessions = Object.keys(sessionRegistry).join(", ") || "none";
		const status = monoActive
			? voiceInputActive
				? voiceTarget
					? `Listener running, voice active -> ${voiceTarget} (known: ${sessions})`
					: `Listener running, voice active -> current session (known: ${sessions})`
				: `Listener running, waiting for wake phrase (known: ${sessions})`
			: "Listener not running";
		return { ok: true, message: status, mono: getMonoStatus() };
	};

	const handleSpeakAction = async (
		action: "on" | "off" | "stop" | "status" | "test" | "providers" | "provider" | "rewrite",
		value?: string,
		ctx?: any,
	) => {
		if (action === "on") {
			speakState.enabled = true;
			persistState();
			setPhase("ready", ctx);
			return {
				ok: true,
				message: `Speech mode enabled (${describeTtsProvider(getSpeakRuntimeState())}).`,
				speak: getSpeakStatus(),
			};
		}
		if (action === "stop") {
			stopSpeaking(ctx);
			return {
				ok: true,
				message: speakState.enabled ? "Stopped current speech playback." : "No speech playback is active.",
				speak: getSpeakStatus(),
			};
		}
		if (action === "off") {
			speakState.enabled = false;
			persistState();
			stopSpeaking(ctx);
			updateStatus(ctx);
			return { ok: true, message: "Speech mode disabled.", speak: getSpeakStatus() };
		}
		if (action === "status") {
			const rewriteStatus = isRewriteEnabled(getSpeakRuntimeState()) ? "rewrite on" : "rewrite off";
			return {
				ok: true,
				message: speakState.enabled
					? `Speech mode is on (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus}).`
					: `Speech mode is off (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus}).`,
				speak: getSpeakStatus(),
			};
		}
		if (action === "providers") {
			return { ok: true, message: `Available providers: ${AVAILABLE_TTS_PROVIDERS.join(", ")}`, providers: AVAILABLE_TTS_PROVIDERS };
		}
		if (action === "provider") {
			const requested = (value || "").trim().toLowerCase() as TtsProvider;
			if (!AVAILABLE_TTS_PROVIDERS.includes(requested)) {
				return { ok: false, message: `Unknown provider "${value}".`, providers: AVAILABLE_TTS_PROVIDERS };
			}
			speakState.provider = requested;
			persistState();
			stopSpeaking(ctx);
			updateStatus(ctx);
			return {
				ok: true,
				message: `Speech provider set to ${describeTtsProvider(getSpeakRuntimeState())}.`,
				speak: getSpeakStatus(),
			};
		}
		if (action === "rewrite") {
			const normalized = (value || "").trim().toLowerCase();
			if (["on", "enable", "true", "1"].includes(normalized)) {
				speakState.rewriteEnabled = true;
				persistState();
				return { ok: true, message: "Speech rewrite enabled.", speak: getSpeakStatus() };
			}
			if (["off", "disable", "false", "0"].includes(normalized)) {
				speakState.rewriteEnabled = false;
				persistState();
				return { ok: true, message: "Speech rewrite disabled.", speak: getSpeakStatus() };
			}
			return { ok: false, message: `Unknown rewrite value "${value}". Use on or off.` };
		}
		speakState.enabled = true;
		persistState();
		setPhase("ready", ctx);
		void speakText(`Hey, this is Pi speak using ${describeTtsProvider(getSpeakRuntimeState())}.`, ctx);
		return {
			ok: true,
			message: `Played speech test with ${describeTtsProvider(getSpeakRuntimeState())}.`,
			speak: getSpeakStatus(),
		};
	};

	const handlePhoneAction = async (action: "on" | "off" | "status" | "code" | "unpair", ctx?: any) => {
		if (action === "on") {
			const started = await startPhoneBridge(ctx);
			return { ok: started, message: getPhoneStatusText(), phone: getPhoneStatus() };
		}
		if (action === "off") {
			await stopPhoneBridge(ctx);
			return { ok: true, message: "Phone bridge stopped.", phone: getPhoneStatus() };
		}
		if (action === "status") {
			return { ok: true, message: getPhoneStatusText(), phone: getPhoneStatus() };
		}
		if (action === "code") {
			const started = await startPhoneBridge(ctx, true);
			if (!started || !phoneBridge) {
				return { ok: false, message: "Phone bridge could not be started." };
			}
			const status = phoneBridge.getStatus();
			return {
				ok: true,
				message: `Send /link ${status.linkCode} to your Telegram bot to pair this phone.`,
				phone: getPhoneStatus(),
			};
		}
		if (!phoneBridge) {
			syncPhoneState({ linkedChatId: undefined, linkCode: undefined }, true);
			return {
				ok: true,
				message: "Phone bridge is not running. Start it with /phone on to get a new link code.",
				phone: getPhoneStatus(),
			};
		}
		const linkCode = phoneBridge.resetLink();
		syncPhoneState({ linkedChatId: undefined, linkCode }, true);
		return { ok: true, message: `Phone unpaired. New link code: ${linkCode}.`, phone: getPhoneStatus() };
	};

	const startRemoteServer = async (ctx?: any, quiet = false) => {
		if (!remoteServer) {
			remoteServer = new ControlServer({
				state: remoteState,
				onStateChange: (patch) => {
					syncRemoteState(patch, true);
				},
				getStatus: () => ({
					speak: getSpeakStatus(),
					mono: getMonoStatus(),
					phone: getPhoneStatus(),
					remote: getRemoteStatus(),
				}),
				onMonoAction: (action) => handleMonoAction(action, lastCtx),
				onSpeakAction: (action, value) => handleSpeakAction(action, value, lastCtx),
				onPhoneAction: (action) => handlePhoneAction(action, lastCtx),
				onTextTurn: (text, includeAudio) => enqueuePhoneTurn(text, undefined, includeAudio),
				onVoiceTurn: async (buffer, mimeType, includeAudio) => {
					const transcription = await transcribeAudioBuffer(buffer, mimeType);
					if (!transcription.text) {
						return { replyText: "I could not understand that voice message." };
					}
					return await enqueuePhoneTurn(transcription.text, transcription.text, includeAudio);
				},
			});
		}

		const runtime = await remoteServer.start();
		syncRemoteState(
			{
				enabled: true,
				host: runtime.host,
				port: runtime.port,
				authToken: runtime.authToken,
			},
			true,
		);

		if (!quiet) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.(getRemoteStatusText(), "info");
		}
		return true;
	};

	const stopRemoteServer = async (ctx?: any, quiet = false) => {
		if (remoteServer) {
			await remoteServer.stop().catch(() => {});
			remoteServer = undefined;
		}
		syncRemoteState({ enabled: false }, true);
		if (!quiet) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.("Remote API stopped.", "info");
		}
	};

	const stopListener = (ctx?: any) => {
		if (listenerRl) {
			try { listenerRl.close(); } catch {}
			listenerRl = undefined;
		}
		if (listenerProcess && !listenerProcess.killed) {
			const proc = listenerProcess;
			// Close stdin to signal graceful shutdown to Python
			try { proc.stdin?.end(); } catch {}
			// Force kill after 3 seconds if still alive
			const killTimer = setTimeout(() => {
				if (!proc.killed) {
					try { proc.kill(); } catch {}
				}
			}, 3000);
			proc.on("exit", () => clearTimeout(killTimer));
		}
		listenerProcess = undefined;
		monoActive = false;
		voiceInputActive = false;
		voiceTarget = undefined;
		updateMonoStatus(ctx);
	};

	const startListener = (ctx?: any) => {
		if (listenerProcess) return;

		const extDir = getExtensionDir();
		const listenerScript = join(extDir, "listener", "listener.py");
		if (!existsSync(listenerScript)) {
			const target = ctx || lastCtx;
			target?.ui?.notify?.(`Listener script not found: ${listenerScript}`, "error");
			return;
		}

		const python = getPython();
		listenerProcess = spawn(python, ["-u", listenerScript], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
			shell: false,
			env: {
				...process.env,
				VOSK_MODEL_PATH: process.env.VOSK_MODEL_PATH || "",
				WHISPER_DEVICE: process.env.WHISPER_DEVICE || "",
				WHISPER_COMPUTE: process.env.WHISPER_COMPUTE || "",
				WHISPER_MODEL: process.env.WHISPER_MODEL || "",
			},
		});

		monoActive = true;
		updateMonoStatus(ctx);

		listenerRl = createInterface({ input: listenerProcess.stdout! });
		listenerRl.on("line", (line) => {
			let event: ListenerEvent;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			// Always use lastCtx so voice events target the current session, not the
			// stale ctx from when startListener was called.
			handleListenerEvent(event, undefined);
		});

		listenerProcess.stderr?.setEncoding("utf8");
		listenerProcess.stderr?.on("data", (chunk: string) => {
			for (const line of chunk.split(/\r?\n/)) {
				if (line.trim()) {
					const target = ctx || lastCtx;
					target?.ui?.notify?.(`[listener] ${line.trim()}`, "warning");
				}
			}
		});

		listenerProcess.on("exit", (code) => {
			listenerProcess = undefined;
			monoActive = false;
			voiceInputActive = false;
			voiceTarget = undefined;
			updateMonoStatus(ctx);
			if (code !== 0 && code !== null) {
				const target = ctx || lastCtx;
				target?.ui?.notify?.(`Voice listener exited with code ${code}`, "error");
			}
		});

		listenerProcess.on("error", (err) => {
			listenerProcess = undefined;
			monoActive = false;
			voiceInputActive = false;
			voiceTarget = undefined;
			updateMonoStatus(ctx);
			const target = ctx || lastCtx;
			target?.ui?.notify?.(`Voice listener error: ${err.message}`, "error");
		});
	};

	const handleListenerEvent = (event: ListenerEvent, ctx?: any) => {
		const target = ctx || lastCtx;

		switch (event.type) {
			case "wake":
				if (event.state === "on") {
					voiceInputActive = true;
					voiceTarget = event.target || undefined;
					updateMonoStatus(target);
					if (!speakState.enabled) {
						speakState.enabled = true;
						persistState();
						setPhase("ready", target);
					}
					const targetLabel = voiceTarget ? ` (target: ${voiceTarget})` : "";
					target?.ui?.notify?.(`Voice input active${targetLabel} - say "pi mono" or "pi mono <name>" to keep alive`, "info");
				} else if (event.state === "ping") {
					// Keep-alive â€” update target if provided
					if (event.target) voiceTarget = event.target;
					updateMonoStatus(target);
				} else if (event.state === "off") {
					voiceInputActive = false;
					voiceTarget = undefined;
					updateMonoStatus(target);
					const reason = event.reason === "timeout" ? " (timed out)" : "";
					target?.ui?.notify?.(`Voice input off${reason} - say "pi mono" to reactivate`, "info");
				}
				break;

			case "transcribing":
				target?.ui?.setStatus?.("mono", "mono:transcribing");
				break;

			case "speech":
				updateMonoStatus(target);
				if (event.text && voiceInputActive) {
					void routeVoiceInput(event.text, target);
				}
				break;

			case "status":
				// Silent status updates -- just log to status bar
				break;

			case "error":
				target?.ui?.notify?.(`[listener] ${event.message}`, "error");
				break;
		}
	};

	const routeVoiceInput = async (text: string, ctx?: any) => {
		const lower = text.toLowerCase().trim();
		const target = ctx || lastCtx;

		// Speech control -- always immediate, no agent interaction
		if (lower === "stop speaking" || lower === "be quiet" || lower === "shut up" || lower === "shush") {
			stopSpeaking(target);
			return;
		}

		// Determine if agent is busy so we can queue instead of interrupt
		const idle = target?.isIdle?.() ?? true;
		const deliverAs = idle ? undefined : ("followUp" as const);

		if (!idle) {
			target?.ui?.setStatus?.("mono", "mono:queued");
		}

		// Session commands via voice
		if (lower.startsWith("new session ")) {
			const name = text.slice("new session ".length).trim();
			if (name) {
				pi.sendUserMessage(`/sess new ${name}`, deliverAs ? { deliverAs } : undefined);
				return;
			}
		}
		if (lower.startsWith("switch to session ") || lower.startsWith("switch session ")) {
			const prefix = lower.startsWith("switch to session ") ? "switch to session " : "switch session ";
			const name = text.slice(prefix.length).trim();
			if (name) {
				pi.sendUserMessage(`/sess switch ${name}`, deliverAs ? { deliverAs } : undefined);
				return;
			}
		}
		if (lower === "list sessions" || lower === "show sessions") {
			pi.sendUserMessage("/sess list", deliverAs ? { deliverAs } : undefined);
			return;
		}

		// Everything else -> user message to Pi (queued as followUp if busy)
		if (voiceTarget) {
			const sessionPath = findSessionByName(voiceTarget);
			if (sessionPath && typeof target?.switchSession === "function") {
				// Switch to target session and send the message
				target?.ui?.notify?.(`Routing to session: ${voiceTarget}`, "info");
				const result = await target.switchSession(sessionPath);
				if (!result?.cancelled) {
					pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
				}
				return;
			} else {
				target?.ui?.notify?.(`Unknown session "${voiceTarget}" - say "pi mono" to reset to current`, "warning");
			}
		}
		pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
	};

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------
	pi.registerCommand("mono", {
		description: "Control the always-on voice listener (Vosk + faster-whisper)",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();

			if (!lower || lower === "on" || lower === "start") {
				startListener(ctx);
				persistMonoState();
				ctx.ui.notify(`Voice listener started - say "pi mono" to activate (${MONO_KEEP_ALIVE_SECONDS}s keep-alive)`, "info");
				return;
			}

			if (lower === "off" || lower === "stop") {
				stopListener(ctx);
				persistMonoState();
				ctx.ui.notify("Voice listener stopped", "info");
				return;
			}

			if (lower === "status") {
				const sessions = Object.keys(sessionRegistry).join(", ") || "none";
				const status = monoActive
					? voiceInputActive
						? voiceTarget
							? `Listener running, voice active â†’ ${voiceTarget} (known: ${sessions})`
							: `Listener running, voice active â†’ current session (known: ${sessions})`
						: `Listener running, waiting for wake phrase (known: ${sessions})`
					: "Listener not running";
				ctx.ui.notify(status, "info");
				return;
			}

			ctx.ui.notify("Usage: /mono [on|off|status]", "error");
		},
	});

	pi.registerCommand("sess", {
		description: "Manage named sessions (new, switch, list, name)",
		getArgumentCompletions: (prefix) => {
			const options = ["new", "switch", "list", "name"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.trim().split(/\s+/);
			const sub = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ").trim();

			if (sub === "new") {
				const name = rest || `session-${Date.now()}`;
				if (sessionRegistry[name]) {
					ctx.ui.notify(`Warning: session "${name}" already exists and will be overwritten in registry`, "warning");
				}
				const result = await ctx.newSession();
				if (!result.cancelled) {
					pi.setSessionName(name);
					const sessionFile = ctx.sessionManager.getSessionFile();
					if (sessionFile) {
						sessionRegistry[name] = sessionFile;
						persistSessionRegistry();
					}
					ctx.ui.notify(`New session: ${name}`, "info");
				}
				return;
			}

			if (sub === "switch") {
				if (!rest) {
					ctx.ui.notify("Usage: /sess switch <name>", "error");
					return;
				}
				const sessionPath = findSessionByName(rest);
				if (!sessionPath) {
					const available = Object.keys(sessionRegistry).join(", ") || "none";
					ctx.ui.notify(`Session "${rest}" not found. Known: ${available}`, "error");
					return;
				}
				const result = await ctx.switchSession(sessionPath);
				if (!result.cancelled) {
					ctx.ui.notify(`Switched to session: ${rest}`, "info");
				}
				return;
			}

			if (sub === "list") {
				const names = Object.entries(sessionRegistry)
					.map(([name, _path]) => name)
					.join(", ");
				ctx.ui.notify(names ? `Sessions: ${names}` : "No named sessions", "info");
				return;
			}

			if (sub === "name") {
				if (!rest) {
					const current = pi.getSessionName();
					ctx.ui.notify(current ? `Current: ${current}` : "No session name set", "info");
					return;
				}
				pi.setSessionName(rest);
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (sessionFile) {
					sessionRegistry[rest] = sessionFile;
					persistSessionRegistry();
				}
				ctx.ui.notify(`Session named: ${rest}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /sess [new|switch|list|name] <args>", "error");
		},
	});

	pi.registerCommand("phone", {
		description: "Remote Pi over Telegram text and voice messages",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "code", "unpair"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();

			if (!lower || lower === "on" || lower === "start") {
				await startPhoneBridge(ctx);
				return;
			}

			if (lower === "off" || lower === "stop") {
				await stopPhoneBridge(ctx);
				return;
			}

			if (lower === "status") {
				const status = phoneBridge?.getStatus();
				const linkHint =
					status && !status.linkedChatId
						? ` Send /link ${status.linkCode} to your bot in Telegram.`
						: "";
				ctx.ui.notify(`${getPhoneStatusText()}${linkHint}`, "info");
				return;
			}

			if (lower === "code") {
				const started = await startPhoneBridge(ctx, true);
				if (!started || !phoneBridge) return;
				const status = phoneBridge.getStatus();
				ctx.ui.notify(`Send /link ${status.linkCode} to your Telegram bot to pair this phone`, "info");
				return;
			}

			if (lower === "unpair") {
				if (!phoneBridge) {
					syncPhoneState({ linkedChatId: undefined, linkCode: undefined }, true);
					ctx.ui.notify("Phone bridge is not running. Start it with /phone on to get a new link code.", "info");
					return;
				}
				const linkCode = phoneBridge.resetLink();
				syncPhoneState({ linkedChatId: undefined, linkCode }, true);
				ctx.ui.notify(`Phone unpaired. New link code: ${linkCode}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /phone [on|off|status|code|unpair]", "error");
		},
	});

	pi.registerCommand("remote", {
		description: "Control Pi through the local HTTP API for phone remotes and automations",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status", "token"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const lower = args.trim().toLowerCase();

			if (!lower || lower === "on" || lower === "start") {
				await startRemoteServer(ctx);
				return;
			}

			if (lower === "off" || lower === "stop") {
				await stopRemoteServer(ctx);
				return;
			}

			if (lower === "status") {
				ctx.ui.notify(getRemoteStatusText(), "info");
				return;
			}

			if (lower === "token") {
				if (!remoteServer && !remoteState.authToken) {
					await startRemoteServer(ctx, true);
				}
				const token = remoteServer?.getRuntimeState().authToken || remoteState.authToken || "";
				if (!token) {
					ctx.ui.notify("No remote token is configured yet. Start the remote API with /remote on.", "warning");
					return;
				}
				ctx.ui.notify(`Remote token: ${token}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /remote [on|off|status|token]", "error");
		},
	});

	pi.registerCommand("speak", {
		description: "Enable spoken assistant replies with provider selection",
		getArgumentCompletions: (prefix) => {
			const options = [
				"on",
				"off",
				"stop",
				"status",
				"test",
				"providers",
				"provider auto",
				"provider legacy",
				"provider edge",
				"provider openai",
				"provider elevenlabs",
				"rewrite on",
				"rewrite off",
			];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const raw = args.trim();
			const lower = raw.toLowerCase();

			if (!raw || lower === "on" || lower === "enable" || lower === "start") {
				speakState.enabled = true;
				persistState();
				setPhase("ready", ctx);
				ctx.ui.notify(`Speech mode enabled (${describeTtsProvider(getSpeakRuntimeState())})`, "info");
				return;
			}

			if (lower === "stop" || lower === "interrupt" || lower === "quiet" || lower === "shush") {
				stopSpeaking(ctx);
				ctx.ui.notify(
					speakState.enabled ? "Stopped current speech playback" : "No speech playback is active",
					"info",
				);
				return;
			}

			if (lower === "off" || lower === "disable") {
				speakState.enabled = false;
				persistState();
				stopSpeaking(ctx);
				updateStatus(ctx);
				ctx.ui.notify("Speech mode disabled", "info");
				return;
			}

			if (lower === "status") {
				const rewriteStatus = isRewriteEnabled(getSpeakRuntimeState()) ? "rewrite on" : "rewrite off";
				ctx.ui.notify(
					speakState.enabled
						? `Speech mode is on (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus})`
						: `Speech mode is off (${describeTtsProvider(getSpeakRuntimeState())}, ${rewriteStatus})`,
					"info",
				);
				return;
			}

			if (lower === "providers") {
				ctx.ui.notify(`Available providers: ${AVAILABLE_TTS_PROVIDERS.join(", ")}`, "info");
				return;
			}

			if (lower.startsWith("provider ")) {
				const requested = lower.slice("provider ".length).trim() as TtsProvider;
				if (!AVAILABLE_TTS_PROVIDERS.includes(requested)) {
					ctx.ui.notify(`Unknown provider "${requested}". Use /speak providers`, "error");
					return;
				}
				speakState.provider = requested;
				persistState();
				stopSpeaking(ctx);
				updateStatus(ctx);
				ctx.ui.notify(`Speech provider set to ${describeTtsProvider(getSpeakRuntimeState())}`, "info");
				return;
			}

			if (lower === "rewrite on" || lower === "rewrite enable") {
				speakState.rewriteEnabled = true;
				persistState();
				ctx.ui.notify("Speech rewrite enabled", "info");
				return;
			}

			if (lower === "rewrite off" || lower === "rewrite disable") {
				speakState.rewriteEnabled = false;
				persistState();
				ctx.ui.notify("Speech rewrite disabled", "info");
				return;
			}

			if (lower === "test") {
				speakState.enabled = true;
				persistState();
				setPhase("ready", ctx);
				void speakText(`Hey, this is Pi speak using ${describeTtsProvider(getSpeakRuntimeState())}.`, ctx);
				ctx.ui.notify(`Played speech test with ${describeTtsProvider(getSpeakRuntimeState())}`, "info");
				return;
			}

			speakState.enabled = true;
			persistState();
			setPhase("ready", ctx);
			ctx.ui.notify(`Speech mode enabled (${describeTtsProvider(getSpeakRuntimeState())})`, "info");
			pi.sendUserMessage(raw);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const remoteRuntime = remoteServer?.getRuntimeState();
		speakState = {
			enabled: false,
			provider: "auto",
		};
		remoteState = {
			enabled: !!remoteRuntime?.enabled,
			host: remoteRuntime?.host || DEFAULT_REMOTE_HOST,
			port: remoteRuntime?.port || DEFAULT_REMOTE_PORT,
			authToken: remoteRuntime?.authToken || process.env.PI_SPEAK_HTTP_TOKEN || undefined,
		};
		lastAssistantText = "";
		phase = "ready";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data && typeof entry.data === "object") {
				const savedSpeakState = entry.data as SpeakState;
				speakState = {
					...speakState,
					...savedSpeakState,
					enabled: !!savedSpeakState.enabled,
				};
			}
			if (entry.type === "custom" && entry.customType === MONO_STATE_TYPE && entry.data && typeof entry.data === "object") {
				const mono = entry.data as MonoState;
				if (mono.listening && !monoActive) {
					startListener(ctx);
				}
			}
			if (entry.type === "custom" && entry.customType === PHONE_STATE_TYPE && entry.data && typeof entry.data === "object") {
				phoneState = { ...phoneState, ...(entry.data as PhoneBridgeState) };
			}
			if (entry.type === "custom" && entry.customType === REMOTE_STATE_TYPE && entry.data && typeof entry.data === "object") {
				remoteState = { ...remoteState, ...(entry.data as RemoteState) };
			}
			if (entry.type === "custom" && entry.customType === SESSION_REGISTRY_TYPE && entry.data && typeof entry.data === "object") {
				const reg = entry.data as SessionRegistryState;
				if (reg.sessions) {
					sessionRegistry = { ...sessionRegistry, ...reg.sessions };
				}
			}
		}
		// Register current session in registry if it has a name
		const currentName = pi.getSessionName();
		const currentFile = ctx.sessionManager.getSessionFile();
		if (currentName && currentFile) {
			sessionRegistry[currentName] = currentFile;
		}

		if (phoneBridge) {
			const status = phoneBridge.getStatus();
			phoneState = {
				...phoneState,
				enabled: true,
				linkedChatId: status.linkedChatId,
				linkCode: status.linkCode,
				lastUpdateId: status.lastUpdateId,
			};
		} else if (phoneState.enabled) {
			await startPhoneBridge(ctx, true);
		}

		if (remoteServer) {
			const runtime = remoteServer.getRuntimeState();
			syncRemoteState(
				{
					enabled: true,
					host: runtime.host,
					port: runtime.port,
					authToken: runtime.authToken,
				},
				false,
			);
		} else if (remoteState.enabled) {
			await startRemoteServer(ctx, true);
		}

		updateStatus(ctx);
		updateMonoStatus(ctx);
		updatePhoneStatus(ctx);
		updateRemoteStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastCtx = ctx;
		if (Object.keys(sessionRegistry).length > 0) {
			persistSessionRegistry();
		}
		rejectPendingPhoneTurn("Session changed before the phone reply was delivered");
		stopSpeaking(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		const shouldInjectSpeechPrompt = speakState.enabled || forceSpeechPromptNextTurn;
		forceSpeechPromptNextTurn = false;
		if (!shouldInjectSpeechPrompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SPEECH_MODE_PROMPT}`,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		lastAssistantText = "";
		if (speakState.enabled) setPhase("llm", ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!event.message || event.message.role !== "assistant") return;
		const text = extractText(event.message.content);
		if (text) lastAssistantText = text;
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		const replyText = lastAssistantText.trim();
		if (speakState.enabled && ctx.hasUI) {
			if (replyText) {
				void speakText(replyText, ctx);
			} else {
				setPhase("ready", ctx);
			}
		}
		if (pendingPhoneTurn) {
			await resolvePendingPhoneTurn(ctx);
		}
	});
}


