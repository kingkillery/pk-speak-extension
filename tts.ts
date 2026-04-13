import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EdgeTTS } from "node-edge-tts";

export type TtsProvider = "auto" | "legacy" | "edge" | "openai" | "elevenlabs";

export type SpeakRuntimeState = {
	enabled?: boolean;
	provider?: TtsProvider;
	rewriteEnabled?: boolean;
};

export type SynthesisPhase = "rewrite" | "voice";

export type SynthesisOptions = {
	text: string;
	outputPath: string;
	state?: SpeakRuntimeState;
	signal?: AbortSignal;
	onPhase?: (phase: SynthesisPhase) => void;
	onLegacyProcess?: (process: ChildProcess | undefined) => void;
};

export type SynthesisResult = {
	provider: Exclude<TtsProvider, "auto">;
	rewriteApplied: boolean;
};

export const DEFAULT_LEGACY_VOICE = "adam";
export const DEFAULT_EDGE_VOICE = process.env.PI_SPEAK_EDGE_VOICE || "en-US-AriaNeural";
export const DEFAULT_OPENAI_VOICE = process.env.PI_SPEAK_OPENAI_VOICE || "alloy";
export const DEFAULT_OPENAI_MODEL = process.env.PI_SPEAK_OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
export const DEFAULT_ELEVENLABS_VOICE_ID =
	process.env.PI_SPEAK_ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
export const DEFAULT_ELEVENLABS_MODEL_ID =
	process.env.PI_SPEAK_ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
export const DEFAULT_REWRITE_MODEL =
	process.env.PI_SPEAK_REWRITE_MODEL || "openai/gpt-oss-20b:nitro";

const OPENROUTER_URL = process.env.PI_SPEAK_OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";

const elevenLabsAliases: Record<string, string> = {
	adam: "pNInz6obpgDQGcFmaJgB",
};

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		throw new Error("Speech synthesis aborted");
	}
}

function getOpenAiAudioKey() {
	return process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY || "";
}

function getPythonExecutable() {
	if (process.env.PI_SPEAK_PYTHON?.trim()) return process.env.PI_SPEAK_PYTHON.trim();
	if (existsSync("C:/Python314/python.exe")) return "C:/Python314/python.exe";
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const localPy = join(home, "AppData", "Local", "Microsoft", "WindowsApps", "python3.exe");
	if (existsSync(localPy)) return localPy;
	return "python";
}

function getSpeak11Invocation(outputPath: string) {
	const configured = process.env.PI_SPEAK_SPEAK11_PATH?.trim();
	if (configured) {
		const python = getPythonExecutable();
		if (configured.toLowerCase().endsWith(".py")) {
			return {
				command: python,
				args: [configured, "--stdin", "-s", "-v", DEFAULT_LEGACY_VOICE, "-o", outputPath],
			};
		}
		if (configured.toLowerCase().endsWith(".cmd") || configured.toLowerCase().endsWith(".bat")) {
			return {
				command: "cmd.exe",
				args: ["/c", configured, "--stdin", "-s", "-v", DEFAULT_LEGACY_VOICE, "-o", outputPath],
			};
		}
		return {
			command: configured,
			args: ["--stdin", "-s", "-v", DEFAULT_LEGACY_VOICE, "-o", outputPath],
		};
	}

	const home = process.env.USERPROFILE || process.env.HOME || "";
	const pyScript = join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.py");
	const cmdScript = join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.cmd");
	const python = getPythonExecutable();

	if (existsSync(pyScript)) {
		return { command: python, args: [pyScript, "--stdin", "-s", "-v", DEFAULT_LEGACY_VOICE, "-o", outputPath] };
	}
	if (existsSync(cmdScript)) {
		return { command: "cmd.exe", args: ["/c", cmdScript, "--stdin", "-s", "-v", DEFAULT_LEGACY_VOICE, "-o", outputPath] };
	}
	return { command: "cmd.exe", args: ["/c", "speak11", "--stdin", "-s", "-v", DEFAULT_LEGACY_VOICE, "-o", outputPath] };
}

export function hasLegacySpeak11() {
	if (process.env.PI_SPEAK_SPEAK11_PATH?.trim()) return true;
	const home = process.env.USERPROFILE || process.env.HOME || "";
	return (
		existsSync(join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.py")) ||
		existsSync(join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", "speak11.cmd"))
	);
}

export function resolveTtsProvider(state?: SpeakRuntimeState): Exclude<TtsProvider, "auto"> {
	const configured = (state?.provider || process.env.PI_SPEAK_TTS_PROVIDER || "auto").toLowerCase() as TtsProvider;
	if (configured !== "auto") return configured;
	if (hasLegacySpeak11()) return "legacy";
	if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
	if (getOpenAiAudioKey()) return "openai";
	return "edge";
}

export function isRewriteEnabled(state?: SpeakRuntimeState) {
	if (typeof state?.rewriteEnabled === "boolean") return state.rewriteEnabled;
	const envValue = (process.env.PI_SPEAK_REWRITE_ENABLED || "").trim().toLowerCase();
	if (!envValue) return true;
	return !["0", "false", "off", "no"].includes(envValue);
}

export function describeTtsProvider(state?: SpeakRuntimeState) {
	const provider = resolveTtsProvider(state);
	switch (provider) {
		case "legacy":
			return `legacy/speak11 (${DEFAULT_LEGACY_VOICE})`;
		case "edge":
			return `edge (${DEFAULT_EDGE_VOICE})`;
		case "openai":
			return `openai (${DEFAULT_OPENAI_MODEL}/${DEFAULT_OPENAI_VOICE})`;
		case "elevenlabs":
			return `elevenlabs (${DEFAULT_ELEVENLABS_VOICE_ID})`;
	}
}

async function rewriteForSpeech(text: string, signal?: AbortSignal) {
	const apiKey = process.env.OPENROUTER_API_KEY || "";
	if (!apiKey) return { text, applied: false };

	throwIfAborted(signal);
	const response = await fetch(OPENROUTER_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": process.env.PI_SPEAK_HTTP_REFERER || "https://github.com/prest/pi-speak-extension",
			"X-Title": "pi-speak-extension",
		},
		body: JSON.stringify({
			model: DEFAULT_REWRITE_MODEL,
			temperature: 0.2,
			messages: [
				{
					role: "system",
					content:
						"You rewrite assistant replies for spoken delivery. Keep all key technical meaning, remove markdown/table formatting, compress long lists, and produce natural spoken English only. Do not add commentary about the rewrite.",
				},
				{
					role: "user",
					content: text.slice(0, 12000),
				},
			],
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`OpenRouter rewrite failed (${response.status})`);
	}
	const json = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const rewritten = json.choices?.[0]?.message?.content?.trim();
	return { text: rewritten || text, applied: !!rewritten };
}

function getEdgeRate() {
	const raw = Number.parseFloat(process.env.PI_SPEAK_EDGE_RATE || "1");
	if (!Number.isFinite(raw) || raw === 1) return undefined;
	const pct = Math.round((raw - 1) * 100);
	return `${pct >= 0 ? "+" : ""}${pct}%`;
}

async function synthesizeEdge(text: string, outputPath: string, signal?: AbortSignal) {
	throwIfAborted(signal);
	const tts = new EdgeTTS({
		voice: DEFAULT_EDGE_VOICE,
		lang: process.env.PI_SPEAK_EDGE_LANG || DEFAULT_EDGE_VOICE.split("-").slice(0, 2).join("-"),
		outputFormat: "audio-24khz-48kbitrate-mono-mp3",
		rate: getEdgeRate(),
		timeout: Number.parseInt(process.env.PI_SPEAK_EDGE_TIMEOUT_MS || "15000", 10),
	});
	await tts.ttsPromise(text, outputPath);
}

async function synthesizeOpenAI(text: string, outputPath: string, signal?: AbortSignal) {
	const apiKey = getOpenAiAudioKey();
	if (!apiKey) throw new Error("OPENAI_API_KEY or VOICE_TOOLS_OPENAI_KEY is required for OpenAI TTS");
	throwIfAborted(signal);
	const response = await fetch(`${process.env.PI_SPEAK_OPENAI_BASE_URL || "https://api.openai.com/v1"}/audio/speech`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: DEFAULT_OPENAI_MODEL,
			voice: DEFAULT_OPENAI_VOICE,
			input: text,
			response_format: "mp3",
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(`OpenAI TTS failed (${response.status})`);
	}
	const audio = Buffer.from(await response.arrayBuffer());
	await writeFile(outputPath, audio);
}

async function synthesizeElevenLabs(text: string, outputPath: string, signal?: AbortSignal) {
	const apiKey = process.env.ELEVENLABS_API_KEY || "";
	if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs TTS");
	throwIfAborted(signal);
	const configuredVoice = (process.env.PI_SPEAK_ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID).trim();
	const voiceId = elevenLabsAliases[configuredVoice.toLowerCase()] || configuredVoice;
	const response = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
		{
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				text,
				model_id: DEFAULT_ELEVENLABS_MODEL_ID,
			}),
			signal,
		},
	);
	if (!response.ok) {
		throw new Error(`ElevenLabs TTS failed (${response.status})`);
	}
	const audio = Buffer.from(await response.arrayBuffer());
	await writeFile(outputPath, audio);
}

function synthesizeLegacy(text: string, outputPath: string, signal?: AbortSignal, onPhase?: (phase: SynthesisPhase) => void, onLegacyProcess?: (process: ChildProcess | undefined) => void) {
	return new Promise<void>((resolve, reject) => {
		const { command, args } = getSpeak11Invocation(outputPath);
		onPhase?.("rewrite");
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
			shell: false,
		});
		onLegacyProcess?.(child);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");

		const abortHandler = () => {
			try {
				child.kill();
			} catch {}
			reject(new Error("Speech synthesis aborted"));
		};
		signal?.addEventListener("abort", abortHandler, { once: true });

		const handleOutput = (chunk: string) => {
			for (const line of chunk.split(/\r?\n/)) {
				const lower = line.toLowerCase();
				if (!lower.trim()) continue;
				if (lower.includes("generating with") || lower.includes("generating")) {
					onPhase?.("voice");
				}
			}
		};

		child.stdout?.on("data", (data) => handleOutput(String(data)));
		child.stderr?.on("data", (data) => handleOutput(String(data)));
		child.on("error", (error) => {
			onLegacyProcess?.(undefined);
			reject(error);
		});
		child.on("exit", (code) => {
			onLegacyProcess?.(undefined);
			if (code === 0) resolve();
			else reject(new Error(`speak11 exited with code ${code}`));
		});
		child.stdin?.write(text);
		child.stdin?.end();
	});
}

export async function synthesizeToFile(options: SynthesisOptions): Promise<SynthesisResult> {
	const provider = resolveTtsProvider(options.state);
	if (provider === "legacy") {
		await synthesizeLegacy(
			options.text,
			options.outputPath,
			options.signal,
			options.onPhase,
			options.onLegacyProcess,
		);
		return {
			provider,
			rewriteApplied: true,
		};
	}

	options.onPhase?.("rewrite");
	const rewritten = isRewriteEnabled(options.state)
		? await rewriteForSpeech(options.text, options.signal)
		: { text: options.text, applied: false };

	throwIfAborted(options.signal);
	options.onPhase?.("voice");

	switch (provider) {
		case "edge":
			await synthesizeEdge(rewritten.text, options.outputPath, options.signal);
			break;
		case "openai":
			await synthesizeOpenAI(rewritten.text, options.outputPath, options.signal);
			break;
		case "elevenlabs":
			await synthesizeElevenLabs(rewritten.text, options.outputPath, options.signal);
			break;
		default:
			throw new Error(`Unsupported TTS provider: ${provider satisfies never}`);
	}

	return {
		provider,
		rewriteApplied: rewritten.applied,
	};
}

export function getAudioMimeType(filePath: string) {
	const lower = basename(filePath).toLowerCase();
	if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
	if (lower.endsWith(".wav")) return "audio/wav";
	return "audio/mpeg";
}
