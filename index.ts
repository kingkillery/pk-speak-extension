import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

type SpeakState = {
	enabled: boolean;
};

type MonoState = {
	listening: boolean;
};

type SessionRegistryState = {
	sessions: Record<string, string>; // name -> sessionPath
};

type ListenerEvent =
	| { type: "wake"; state: "on" | "off" | "ping"; reason?: string }
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
const SESSION_REGISTRY_TYPE = "session-registry";
const DEFAULT_VOICE = "adam";
const SPEECH_MODE_PROMPT = `Activate CodeChat mode for this conversation.

Speech pipeline for this session:
1. The user submits text.
2. Pi generates the full assistant response for the UI.
3. The spoken version of that response is rewritten for audio clarity through OpenRouter using model openai/gpt-oss-20b:nitro.
4. The rewritten text is then voiced through the ElevenLabs API using the ${DEFAULT_VOICE} voice.

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
- Mention filenames and functions naturally, like “in speak11.py” or “the listen function,” instead of long path strings.
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
	// When loaded from dist/, listener/ is a sibling of dist/ → go up one level.
	// When loaded directly (e.g. ~/.pi/agent/extensions/speak.ts), listener/ is a
	// sibling of the .ts file → __dirname is already correct.
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

export default function speakExtension(pi: ExtensionAPI) {
	let enabled = false;
	let lastAssistantText = "";
	let speakingProcess: ChildProcess | undefined;
	let playerProcess: ChildProcess | undefined;
	let activeAudioDir: string | undefined;
	let phase: "ready" | "llm" | "rewrite" | "voice" | "playing" = "ready";
	let lastCtx: any;

	// Voice listener state
	let listenerProcess: ChildProcess | undefined;
	let listenerRl: ReturnType<typeof createInterface> | undefined;
	let monoActive = false; // whether the listener background process is running
	let voiceInputActive = false; // whether "pi mono on" has been heard (voice commands flowing)
	let sessionRegistry: Record<string, string> = {}; // name -> sessionPath

	const updateStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		lastCtx = target;
		if (!enabled) {
			target.ui.setStatus("speak", "");
			return;
		}
		const labels: Record<typeof phase, string> = {
			ready: "ready",
			llm: "llm",
			rewrite: "rewrite",
			voice: "elevenlabs",
			playing: "playing",
		};
		target.ui.setStatus("speak", `speak:${DEFAULT_VOICE} · ${labels[phase]}`);
	};

	const setPhase = (next: typeof phase, ctx?: any) => {
		phase = next;
		updateStatus(ctx);
	};

	const persistState = () => {
		pi.appendEntry<SpeakState>(STATE_TYPE, { enabled });
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

	const speakText = (text: string, ctx?: any) => {
		const trimmed = text.trim();
		if (!enabled || !trimmed) return;
		stopSpeaking(ctx);
		setPhase("rewrite", ctx);

		activeAudioDir = mkdtempSync(join(tmpdir(), "pi-speak-"));
		const outputPath = join(activeAudioDir, "reply.mp3");
		const { command, args } = getSpeakInvocation(outputPath);
		speakingProcess = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
			shell: false,
		});

		speakingProcess.stdout?.setEncoding("utf8");
		speakingProcess.stderr?.setEncoding("utf8");

		const handleOutput = (chunk: string) => {
			for (const line of chunk.split(/\r?\n/)) {
				const lower = line.toLowerCase();
				if (!lower.trim()) continue;
				if (lower.includes("summarizing")) setPhase("rewrite", ctx);
				else if (lower.includes("generating with") || lower.includes("generating")) setPhase("voice", ctx);
			}
		};

		const startPlayback = () => {
			if (!existsSync(outputPath)) {
				cleanupAudioFiles();
				setPhase("ready", ctx);
				return;
			}
			setPhase("playing", ctx);
			const player = getPlayerInvocation(outputPath);
			playerProcess = spawn(player.command, player.args, {
				stdio: "ignore",
				detached: false,
				windowsHide: true,
				shell: false,
			});
			playerProcess.on("exit", () => {
				playerProcess = undefined;
				cleanupAudioFiles();
				setPhase("ready", ctx);
			});
			playerProcess.on("error", () => {
				playerProcess = undefined;
				cleanupAudioFiles();
				setPhase("ready", ctx);
			});
		};

		speakingProcess.stdout?.on("data", (data) => handleOutput(String(data)));
		speakingProcess.stderr?.on("data", (data) => handleOutput(String(data)));
		speakingProcess.on("exit", (code) => {
			speakingProcess = undefined;
			if (code === 0) startPlayback();
			else {
				cleanupAudioFiles();
				setPhase("ready", ctx);
				const target = ctx || lastCtx;
				target?.ui?.notify?.(`Speech synthesis failed (exit code ${code})`, "error");
			}
		});
		speakingProcess.on("error", (err) => {
			speakingProcess = undefined;
			cleanupAudioFiles();
			setPhase("ready", ctx);
			const target = ctx || lastCtx;
			target?.ui?.notify?.(`Speech synthesis error: ${err.message}`, "error");
		});
		speakingProcess.stdin?.write(trimmed);
		speakingProcess.stdin?.end();
	};

	// -----------------------------------------------------------------------
	// Voice listener management
	// -----------------------------------------------------------------------
	const updateMonoStatus = (ctx?: any) => {
		const target = ctx || lastCtx;
		if (!target?.hasUI) return;
		if (!monoActive) {
			target.ui.setStatus("mono", "");
			return;
		}
		const label = voiceInputActive ? "mono:on" : "mono:standby";
		target.ui.setStatus("mono", label);
	};

	const persistMonoState = () => {
		pi.appendEntry<MonoState>(MONO_STATE_TYPE, { listening: monoActive });
	};

	const persistSessionRegistry = () => {
		pi.appendEntry<SessionRegistryState>(SESSION_REGISTRY_TYPE, { sessions: sessionRegistry });
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
					updateMonoStatus(target);
					if (!enabled) {
						enabled = true;
						persistState();
						setPhase("ready", target);
					}
					target?.ui?.notify?.("Voice input active (say 'pi mono' to keep alive)", "info");
				} else if (event.state === "ping") {
					// Keep-alive -- just update status to show it's still active
					updateMonoStatus(target);
				} else if (event.state === "off") {
					voiceInputActive = false;
					updateMonoStatus(target);
					const reason = event.reason === "timeout" ? " (timed out)" : "";
					target?.ui?.notify?.(`Voice input off${reason} — say 'pi mono' to reactivate`, "info");
				}
				break;

			case "transcribing":
				target?.ui?.setStatus?.("mono", "mono:transcribing...");
				break;

			case "speech":
				updateMonoStatus(target);
				if (event.text && voiceInputActive) {
					routeVoiceInput(event.text, target);
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

	const routeVoiceInput = (text: string, ctx?: any) => {
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
		pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
	};

	// -----------------------------------------------------------------------
	// Session registry helpers
	// -----------------------------------------------------------------------
	const findSessionByName = (name: string): string | undefined => {
		const lower = name.toLowerCase();
		// Check registry first
		for (const [regName, regPath] of Object.entries(sessionRegistry)) {
			if (regName.toLowerCase() === lower) return regPath;
		}
		return undefined;
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
				ctx.ui.notify("Voice listener started — say 'pi mono' to activate (10s keep-alive)", "info");
				return;
			}

			if (lower === "off" || lower === "stop") {
				stopListener(ctx);
				persistMonoState();
				ctx.ui.notify("Voice listener stopped", "info");
				return;
			}

			if (lower === "status") {
				const status = monoActive
					? voiceInputActive
						? "Listener running, voice input active"
						: "Listener running, waiting for wake phrase"
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

	pi.registerCommand("speak", {
		description: "Enable real ElevenLabs voice mode for assistant replies",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "stop", "interrupt", "status", "test"];
			const matches = options.filter((opt) => opt.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const raw = args.trim();
			const lower = raw.toLowerCase();

			if (!raw || lower === "on" || lower === "enable" || lower === "start") {
				enabled = true;
				persistState();
				setPhase("ready", ctx);
				ctx.ui.notify(`Speech mode enabled (${DEFAULT_VOICE})`, "info");
				return;
			}

			if (lower === "stop" || lower === "interrupt" || lower === "quiet" || lower === "shush") {
				stopSpeaking(ctx);
				ctx.ui.notify(enabled ? "Stopped current speech playback" : "No speech playback is active", "info");
				return;
			}

			if (lower === "off" || lower === "disable") {
				enabled = false;
				persistState();
				stopSpeaking(ctx);
				updateStatus(ctx);
				ctx.ui.notify("Speech mode disabled", "info");
				return;
			}

			if (lower === "status") {
				ctx.ui.notify(enabled ? `Speech mode is on (${DEFAULT_VOICE})` : "Speech mode is off", "info");
				return;
			}

			if (lower === "test") {
				enabled = true;
				persistState();
				setPhase("rewrite", ctx);
				speakText("Hey, this is Adam using ElevenLabs through Pi speak mode.", ctx);
				ctx.ui.notify(`Played speech test with ${DEFAULT_VOICE}`, "info");
				return;
			}

			enabled = true;
			persistState();
			setPhase("ready", ctx);
			ctx.ui.notify(`Speech mode enabled (${DEFAULT_VOICE})`, "info");
			pi.sendUserMessage(raw);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		enabled = false;
		lastAssistantText = "";
		phase = "ready";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data && typeof entry.data === "object") {
				enabled = !!(entry.data as SpeakState).enabled;
			}
			if (entry.type === "custom" && entry.customType === MONO_STATE_TYPE && entry.data && typeof entry.data === "object") {
				const mono = entry.data as MonoState;
				if (mono.listening && !monoActive) {
					startListener(ctx);
				}
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
		updateStatus(ctx);
		updateMonoStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastCtx = ctx;
		// Snapshot the full session registry before shutdown so it survives restarts
		if (Object.keys(sessionRegistry).length > 0) {
			persistSessionRegistry();
		}
		stopSpeaking(ctx);
		// Don't stop the listener here -- it should survive session switches.
		// It will be cleaned up when the extension process exits.
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		if (!enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SPEECH_MODE_PROMPT}`,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		lastAssistantText = "";
		if (enabled) setPhase("llm", ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!enabled || !event.message || event.message.role !== "assistant") return;
		const text = extractText(event.message.content);
		if (text) lastAssistantText = text;
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		if (!enabled || !ctx.hasUI) return;
		if (lastAssistantText) speakText(lastAssistantText, ctx);
		else setPhase("ready", ctx);
	});
}
