import { GoogleGenAI } from "@google/genai";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, join } from "node:path";
import { withAbortTimeout } from "./request-timeout.js";

export type TtsProvider = "auto" | "legacy" | "edge" | "openai" | "elevenlabs" | "gemini" | "sag" | "higgs" | "stable-audio" | "minimax";

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
	/**
	 * When false, primary-provider failures are not retried via Edge.
	 * Defaults to true so existing callers keep current fallback behavior.
	 */
	allowProviderFallback?: boolean;
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
export const DEFAULT_GEMINI_TTS_MODEL = process.env.PI_SPEAK_GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";
export const DEFAULT_GEMINI_TTS_VOICE = process.env.PI_SPEAK_GEMINI_TTS_VOICE || "Kore";
export const DEFAULT_ELEVENLABS_VOICE_ID =
	process.env.PI_SPEAK_ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
export const DEFAULT_ELEVENLABS_MODEL_ID =
	process.env.PI_SPEAK_ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT =
	process.env.PI_SPEAK_ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";
export const DEFAULT_SAG_MODEL_ID = process.env.PI_SPEAK_SAG_MODEL_ID || DEFAULT_ELEVENLABS_MODEL_ID;
export const DEFAULT_SAG_VOICE =
	process.env.PI_SPEAK_SAG_VOICE || process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID;
export const DEFAULT_HIGGS_SPACE = process.env.PI_SPEAK_HIGGS_SPACE || "multimodalart/higgs-audio-v3-tts";
export const DEFAULT_HIGGS_REFERENCE_AUDIO = process.env.PI_SPEAK_HIGGS_REFERENCE_AUDIO || "";
export const DEFAULT_HIGGS_REFERENCE_TEXT = process.env.PI_SPEAK_HIGGS_REFERENCE_TEXT || "";
export const DEFAULT_HIGGS_TEMPERATURE = Number.parseFloat(process.env.PI_SPEAK_HIGGS_TEMPERATURE || "0.7");
export const DEFAULT_HIGGS_TOP_P = Number.parseFloat(process.env.PI_SPEAK_HIGGS_TOP_P || "0.95");
export const DEFAULT_HIGGS_TOP_K = Number.parseInt(process.env.PI_SPEAK_HIGGS_TOP_K || "50", 10);
export const DEFAULT_HIGGS_MAX_NEW_TOKENS = Number.parseInt(process.env.PI_SPEAK_HIGGS_MAX_NEW_TOKENS || "2048", 10);
export const DEFAULT_HIGGS_SEED = Number.parseInt(process.env.PI_SPEAK_HIGGS_SEED || "-1", 10);
export const DEFAULT_STABLE_AUDIO_SPACE = process.env.PI_SPEAK_STABLE_AUDIO_SPACE || "stabilityai/stable-audio-3";
export const DEFAULT_STABLE_AUDIO_VARIANT = process.env.PI_SPEAK_STABLE_AUDIO_VARIANT || "small-sfx";
export const DEFAULT_STABLE_AUDIO_DURATION = Number.parseFloat(process.env.PI_SPEAK_STABLE_AUDIO_DURATION || "8");
export const DEFAULT_STABLE_AUDIO_STEPS = Number.parseInt(process.env.PI_SPEAK_STABLE_AUDIO_STEPS || "8", 10);
export const DEFAULT_STABLE_AUDIO_CFG_SCALE = Number.parseFloat(process.env.PI_SPEAK_STABLE_AUDIO_CFG_SCALE || "1.0");
export const DEFAULT_STABLE_AUDIO_SAMPLER = process.env.PI_SPEAK_STABLE_AUDIO_SAMPLER || "pingpong";
export const DEFAULT_STABLE_AUDIO_SEED = Number.parseInt(process.env.PI_SPEAK_STABLE_AUDIO_SEED || "0", 10);
export const DEFAULT_REWRITE_MODEL =
	process.env.PI_SPEAK_REWRITE_MODEL || "openai/gpt-oss-20b:nitro";
export const DEFAULT_MINIMAX_VOICE_ID = process.env.PI_SPEAK_MINIMAX_VOICE_ID || "male-qn-qingse";
export const DEFAULT_MINIMAX_MODEL = process.env.PI_SPEAK_MINIMAX_MODEL || "speech-01-turbo";
export const DEFAULT_MINIMAX_SAMPLE_RATE = Number.parseInt(process.env.PI_SPEAK_MINIMAX_SAMPLE_RATE || "24000", 10);
export const DEFAULT_MINIMAX_BITRATE = Number.parseInt(process.env.PI_SPEAK_MINIMAX_BITRATE || "32000", 10);
export const DEFAULT_MINIMAX_FORMAT = process.env.PI_SPEAK_MINIMAX_FORMAT || "mp3";

const OPENROUTER_URL = process.env.PI_SPEAK_OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const require = createRequire(import.meta.url);

const elevenLabsAliases: Record<string, string> = {
	adam: "pNInz6obpgDQGcFmaJgB",
};

function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}

function hasEdgeTts() {
	try {
		require.resolve("node-edge-tts");
		return true;
	} catch {
		return false;
	}
}

async function loadEdgeTts() {
	try {
		const mod = await import("node-edge-tts");
		return mod.EdgeTTS;
	} catch (error) {
		throw new Error(
			`Edge TTS is unavailable because the optional 'node-edge-tts' dependency could not be loaded: ${getErrorMessage(error)}`,
		);
	}
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		throw new Error("Speech synthesis aborted");
	}
}

function getOpenAiAudioKey() {
	// Require a dedicated key for audio TTS — avoid consuming the general LLM key
	return process.env.PI_SPEAK_OPENAI_KEY || process.env.VOICE_TOOLS_OPENAI_KEY || "";
}

function getGeminiTtsApiKey() {
	return process.env.PI_SPEAK_GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
}

function getGeminiTtsVertexConfig() {
	const project = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GCLOUD_PROJECT?.trim() || process.env.PI_SPEAK_VERTEX_PROJECT?.trim();
	const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || process.env.GOOGLE_CLOUD_REGION?.trim() || process.env.PI_SPEAK_VERTEX_LOCATION?.trim();
	if (!project || !location) return undefined;
	return { project, location };
}

function hasGeminiTtsAuth() {
	return !!(getGeminiTtsApiKey() || process.env.PI_SPEAK_VERTEX_API_KEY || getGeminiTtsVertexConfig());
}
function getMinimaxApiKey() {
	return process.env.PI_SPEAK_MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || "";
}

function hasMinimaxAuth() {
	return !!getMinimaxApiKey();
}

function createGeminiTtsClient() {
	const apiKey = getGeminiTtsApiKey();
	if (apiKey) {
		return new GoogleGenAI({
			apiKey,
			apiVersion: process.env.PI_SPEAK_GEMINI_API_VERSION || "v1beta",
		});
	}
	const vertex = getGeminiTtsVertexConfig();
	if (vertex) {
		return new GoogleGenAI({
			vertexai: true,
			project: vertex.project,
			location: vertex.location,
			apiVersion: process.env.PI_SPEAK_VERTEX_API_VERSION || "v1beta1",
		});
	}
	const vertexApiKey = process.env.PI_SPEAK_VERTEX_API_KEY?.trim();
	if (vertexApiKey) {
		return new GoogleGenAI({
			vertexai: true,
			apiKey: vertexApiKey,
			apiVersion: process.env.PI_SPEAK_VERTEX_API_VERSION || "v1beta1",
		});
	}
	throw new Error("Gemini TTS requires GOOGLE_API_KEY, GEMINI_API_KEY, or Vertex AI configuration.");
}

function getSagCommand() {
	const configured = process.env.PI_SPEAK_SAG_PATH?.trim();
	if (configured) return configured;
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const executable = process.platform === "win32" ? "sag.exe" : "sag";
	const candidates = [
		join(home, ".local", "bin", executable),
		join(home, "bin", executable),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return "sag";
}

function isCommandAvailable(command: string) {
	if (command.includes("/") || command.includes("\\") || command.toLowerCase().endsWith(".exe")) {
		return existsSync(command);
	}
	const executableNames = process.platform === "win32" && !/\.(?:exe|cmd|bat)$/i.test(command)
		? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
		: [command];
	for (const dir of (process.env.PATH || "").split(delimiter)) {
		if (!dir) continue;
		for (const name of executableNames) {
			if (existsSync(join(dir, name))) return true;
		}
	}
	return false;
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

export function hasSag() {
	return isCommandAvailable(getSagCommand());
}

export function hasHiggsReferenceAudio() {
	const reference = getHiggsReferenceAudio().trim();
	if (!reference) return false;
	if (/^https?:\/\//i.test(reference)) return true;
	return existsSync(reference);
}

function getHiggsReferenceAudio() {
	return process.env.PI_SPEAK_HIGGS_REFERENCE_AUDIO || DEFAULT_HIGGS_REFERENCE_AUDIO;
}

function getHiggsReferenceText() {
	return process.env.PI_SPEAK_HIGGS_REFERENCE_TEXT || DEFAULT_HIGGS_REFERENCE_TEXT;
}

function isProviderAvailable(provider: Exclude<TtsProvider, "auto">) {
	switch (provider) {
		case "legacy":
			return hasLegacySpeak11();
		case "elevenlabs":
			return !!process.env.ELEVENLABS_API_KEY;
		case "openai":
			return !!getOpenAiAudioKey();
		case "gemini":
			return hasGeminiTtsAuth();
		case "sag":
			return hasSag() && !!process.env.ELEVENLABS_API_KEY;
		case "edge":
			return hasEdgeTts();
		case "higgs":
			return hasHiggsReferenceAudio();
		case "stable-audio":
			return true;
		case "minimax":
			return hasMinimaxAuth();
	}
	return false;
}

export function resolveTtsProvider(state?: SpeakRuntimeState): Exclude<TtsProvider, "auto"> {
	const configured = (state?.provider || process.env.PI_SPEAK_TTS_PROVIDER || "auto").toLowerCase() as TtsProvider;
	if (configured !== "auto") {
		if (isProviderAvailable(configured)) return configured;
	}
	if (hasLegacySpeak11()) return "legacy";
	if (hasGeminiTtsAuth()) return "gemini";
	if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
	if (getOpenAiAudioKey()) return "openai";
	if (hasMinimaxAuth()) return "minimax";
	return "edge";
}

export function isSanitizeEnabled() {
	const envValue = (process.env.PI_SPEAK_SANITIZE || "").trim().toLowerCase();
	if (!envValue) return true;
	return envValue !== "false" && envValue !== "0" && envValue !== "off";
}


/**
 * Deterministic, offline cleanup of agent text for spoken delivery.
 *
 * This runs for every non-legacy provider regardless of which agent runtime
 * produced the text (pi, codex, oh-my-pi, claude code). It is the last line of
 * defense when the optional LLM rewrite is disabled or unavailable, so raw
 * markdown, code fences, URLs, and emoji never get read aloud verbatim.
 *
 * It is intentionally idempotent and safe to run on already-rewritten text.
 */
export function sanitizeForSpeech(text: string): string {
	if (!text) return "";
	let out = text.replace(/\r\n/g, "\n");

	// Fenced code blocks read terribly aloud — collapse them to a short phrase.
	out = out.replace(/```[\s\S]*?```/g, " code snippet. ");
	out = out.replace(/~~~[\s\S]*?~~~/g, " code snippet. ");

	// Images and links: keep the human-facing label, drop the target.
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

	// Bare URLs become a neutral spoken token.
	out = out.replace(/\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi, "link");

	// Inline code and emphasis markers: keep the word, drop the markup.
	out = out.replace(/`([^`]+)`/g, "$1");
	out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
	// Single-emphasis. `*` may be intraword, but `_` is emphasis ONLY at word
	// boundaries (CommonMark) — otherwise snake_case identifiers get mangled into
	// "snakecaseword" when spoken. Handle the two markers separately so an
	// underscore inside an identifier is left intact.
	out = out.replace(/\*(?=\S)([^*]*?)(?<=\S)\*/g, "$1");
	out = out.replace(/(^|[^A-Za-z0-9_])_(?=\S)([^_]*?)(?<=\S)_(?![A-Za-z0-9_])/g, "$1$2");
	out = out.replace(/~~(.*?)~~/g, "$1");

	// Line-leading structure: headings, blockquotes, and list bullets.
	out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
	out = out.replace(/^[ \t]*>[ \t]?/gm, "");
	out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "");
	out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");

	// Tables: pipes and separator rows are pure noise when spoken.
	out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, " ");
	out = out.replace(/\|/g, " ");

	// Drop emoji and other pictographic symbols.
	out = out.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, "");

	// Collapse whitespace introduced by the substitutions above.
	out = out.replace(/[ \t]+/g, " ");
	out = out.replace(/ ?\n ?/g, "\n");
	out = out.replace(/\n{3,}/g, "\n\n");

	return out.trim();
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
		case "gemini":
			return `gemini (${DEFAULT_GEMINI_TTS_MODEL}/${DEFAULT_GEMINI_TTS_VOICE})`;
		case "elevenlabs":
			return `elevenlabs (${DEFAULT_ELEVENLABS_VOICE_ID})`;
		case "sag":
			return `sag (${DEFAULT_SAG_MODEL_ID}/${DEFAULT_SAG_VOICE})`;
		case "higgs":
			return `higgs (${DEFAULT_HIGGS_SPACE})`;
		case "stable-audio":
			return `stable-audio (${DEFAULT_STABLE_AUDIO_SPACE}/${DEFAULT_STABLE_AUDIO_VARIANT})`;
		case "minimax":
			return `minimax (${DEFAULT_MINIMAX_MODEL}/${DEFAULT_MINIMAX_VOICE_ID})`;
	}
}

export function getTtsDiagnostics(state?: SpeakRuntimeState) {
	return {
		configuredProvider: state?.provider || process.env.PI_SPEAK_TTS_PROVIDER || "auto",
		resolvedProvider: resolveTtsProvider(state),
		rewriteEnabled: isRewriteEnabled(state),
		sanitizeEnabled: isSanitizeEnabled(),
		providers: {
			legacy: {
				available: hasLegacySpeak11(),
			},
			edge: {
				available: hasEdgeTts(),
				voice: DEFAULT_EDGE_VOICE,
			},
			openai: {
				available: !!getOpenAiAudioKey(),
				model: DEFAULT_OPENAI_MODEL,
				voice: DEFAULT_OPENAI_VOICE,
			},
			gemini: {
				available: hasGeminiTtsAuth(),
				model: DEFAULT_GEMINI_TTS_MODEL,
				voice: DEFAULT_GEMINI_TTS_VOICE,
				vertexConfigured: !!(process.env.PI_SPEAK_VERTEX_API_KEY || getGeminiTtsVertexConfig()),
			},
			elevenlabs: {
				available: !!process.env.ELEVENLABS_API_KEY,
				model: DEFAULT_ELEVENLABS_MODEL_ID,
				voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
				outputFormat: DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
			},
			sag: {
				available: hasSag(),
				authAvailable: !!process.env.ELEVENLABS_API_KEY,
				command: getSagCommand(),
				model: DEFAULT_SAG_MODEL_ID,
				voice: DEFAULT_SAG_VOICE,
				outputFormat: DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
			},
			higgs: {
				available: hasHiggsReferenceAudio(),
				space: DEFAULT_HIGGS_SPACE,
				referenceAudioConfigured: !!getHiggsReferenceAudio().trim(),
				referenceTextConfigured: !!getHiggsReferenceText().trim(),
				temperature: DEFAULT_HIGGS_TEMPERATURE,
				topP: DEFAULT_HIGGS_TOP_P,
				topK: DEFAULT_HIGGS_TOP_K,
				maxNewTokens: DEFAULT_HIGGS_MAX_NEW_TOKENS,
				seed: DEFAULT_HIGGS_SEED,
			},
			stableAudio: {
				available: true,
				space: DEFAULT_STABLE_AUDIO_SPACE,
				variant: DEFAULT_STABLE_AUDIO_VARIANT,
				duration: DEFAULT_STABLE_AUDIO_DURATION,
				steps: DEFAULT_STABLE_AUDIO_STEPS,
				cfgScale: DEFAULT_STABLE_AUDIO_CFG_SCALE,
				sampler: DEFAULT_STABLE_AUDIO_SAMPLER,
				seed: DEFAULT_STABLE_AUDIO_SEED,
			},
			minimax: {
				available: hasMinimaxAuth(),
				model: DEFAULT_MINIMAX_MODEL,
				voiceId: DEFAULT_MINIMAX_VOICE_ID,
				sampleRate: DEFAULT_MINIMAX_SAMPLE_RATE,
				bitrate: DEFAULT_MINIMAX_BITRATE,
				format: DEFAULT_MINIMAX_FORMAT,
			},
		},
	};
}

async function rewriteForSpeech(text: string, signal?: AbortSignal) {
	const apiKey = process.env.OPENROUTER_API_KEY || "";
	if (!apiKey) return { text, applied: false };

	throwIfAborted(signal);
	const response = await withAbortTimeout(
		(requestSignal) =>
			fetch(OPENROUTER_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": process.env.PI_SPEAK_HTTP_REFERER || "https://github.com/kingkillery/pk-speak-extension",
					"X-Title": process.env.PI_SPEAK_APP_TITLE || "pk-speak-extension",
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
				signal: requestSignal,
			}),
		signal,
	);

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
	const EdgeTTS = await loadEdgeTts();
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
	if (!apiKey) throw new Error("PI_SPEAK_OPENAI_KEY or VOICE_TOOLS_OPENAI_KEY is required for OpenAI TTS");
	throwIfAborted(signal);
	const response = await withAbortTimeout(
		(requestSignal) =>
			fetch(`${process.env.PI_SPEAK_OPENAI_BASE_URL || "https://api.openai.com/v1"}/audio/speech`, {
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
				signal: requestSignal,
			}),
		signal,
	);
	if (!response.ok) {
		throw new Error(`OpenAI TTS failed (${response.status})`);
	}
	const audio = Buffer.from(await response.arrayBuffer());
	await writeFile(outputPath, audio);
}

type GeminiAudioOutput = {
	data: string;
	mimeType?: string;
	channels?: number;
	sampleRate?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function getGeminiAudioOutput(value: unknown): GeminiAudioOutput | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const data = typeof record.data === "string" ? record.data : undefined;
	if (!data) return undefined;
	const channels = typeof record.channels === "number" ? record.channels : undefined;
	const sampleRate = typeof record.sample_rate === "number"
		? record.sample_rate
		: typeof record.sampleRate === "number"
			? record.sampleRate
			: undefined;
	return {
		data,
		mimeType: typeof record.mime_type === "string"
			? record.mime_type
			: typeof record.mimeType === "string"
				? record.mimeType
				: undefined,
		channels,
		sampleRate,
	};
}

function extractGeminiAudioOutput(interaction: unknown): GeminiAudioOutput {
	const record = asRecord(interaction);
	const direct = getGeminiAudioOutput(record?.output_audio);
	if (direct) return direct;
	const outputs = record?.outputs;
	if (Array.isArray(outputs)) {
		for (const output of outputs) {
			const audio = getGeminiAudioOutput(output);
			if (audio) return audio;
		}
	}
	throw new Error("Gemini TTS response did not include audio data");
}

function wavFromPcm(pcm: Buffer, channels = 1, sampleRate = 24000, bitsPerSample = 16) {
	const header = Buffer.alloc(44);
	const byteRate = sampleRate * channels * bitsPerSample / 8;
	const blockAlign = channels * bitsPerSample / 8;
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

async function synthesizeGemini(text: string, outputPath: string, signal?: AbortSignal) {
	throwIfAborted(signal);
	const client = createGeminiTtsClient();
	const interaction = await withAbortTimeout(
		(requestSignal) =>
			client.interactions.create({
				model: DEFAULT_GEMINI_TTS_MODEL,
				input: text,
				response_format: { type: "audio" },
				generation_config: {
					speech_config: [
						{ voice: DEFAULT_GEMINI_TTS_VOICE },
					],
				},
			}, {
				signal: requestSignal,
				timeout: Number.parseInt(process.env.PI_SPEAK_GEMINI_TTS_TIMEOUT_MS || "30000", 10),
			}),
		signal,
	);
	const audio = extractGeminiAudioOutput(interaction);
	const bytes = Buffer.from(audio.data, "base64");
	const isWav = audio.mimeType === "audio/wav" && bytes.subarray(0, 4).toString("ascii") === "RIFF";
	await writeFile(
		outputPath,
		isWav ? bytes : wavFromPcm(bytes, audio.channels || 1, audio.sampleRate || 24000),
	);
}

async function synthesizeElevenLabs(text: string, outputPath: string, signal?: AbortSignal) {
	const apiKey = process.env.ELEVENLABS_API_KEY || "";
	if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required for ElevenLabs TTS");
	throwIfAborted(signal);
	const configuredVoice = (process.env.PI_SPEAK_ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID).trim();
	const voiceId = elevenLabsAliases[configuredVoice.toLowerCase()] || configuredVoice;
	const response = await withAbortTimeout(
		(requestSignal) =>
			fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${encodeURIComponent(DEFAULT_ELEVENLABS_OUTPUT_FORMAT)}`, {
				method: "POST",
				headers: {
					"xi-api-key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					text,
					model_id: DEFAULT_ELEVENLABS_MODEL_ID,
					voice_settings: {
						stability: Number.parseFloat(process.env.PI_SPEAK_ELEVENLABS_STABILITY || "0.5"),
						similarity_boost: Number.parseFloat(process.env.PI_SPEAK_ELEVENLABS_SIMILARITY_BOOST || "0.8"),
						style: Number.parseFloat(process.env.PI_SPEAK_ELEVENLABS_STYLE || "0"),
						use_speaker_boost: (process.env.PI_SPEAK_ELEVENLABS_SPEAKER_BOOST || "true").toLowerCase() !== "false",
						speed: Number.parseFloat(process.env.PI_SPEAK_ELEVENLABS_SPEED || "1"),
					},
					apply_text_normalization: process.env.PI_SPEAK_ELEVENLABS_TEXT_NORMALIZATION || "off",
				}),
				signal: requestSignal,
			}),
		signal,
	);
	if (!response.ok) {
		throw new Error(`ElevenLabs TTS failed (${response.status})`);
	}
	const audio = Buffer.from(await response.arrayBuffer());
	await writeFile(outputPath, audio);
}
async function synthesizeMinimax(text: string, outputPath: string, signal?: AbortSignal) {
	const apiKey = getMinimaxApiKey();
	if (!apiKey) throw new Error("MINIMAX_API_KEY or PI_SPEAK_MINIMAX_API_KEY is required for Minimax TTS");
	const voiceId = process.env.PI_SPEAK_MINIMAX_VOICE_ID || DEFAULT_MINIMAX_VOICE_ID;
	const model = process.env.PI_SPEAK_MINIMAX_MODEL || DEFAULT_MINIMAX_MODEL;
	const response = await withAbortTimeout(
		(requestSignal) =>
			fetch("https://api.minimax.chat/v1/t2a_v2", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					text,
					voice_setting: {
						voice_id: voiceId,
						seed: Number.parseInt(process.env.PI_SPEAK_MINIMAX_SEED || "-1", 10),
						vol: Number.parseFloat(process.env.PI_SPEAK_MINIMAX_VOL || "1.0"),
						speed: Number.parseFloat(process.env.PI_SPEAK_MINIMAX_SPEED || "1.0"),
						pitch: Number.parseInt(process.env.PI_SPEAK_MINIMAX_PITCH || "0", 10),
					},
					audio_setting: {
						sample_rate: Number.parseInt(process.env.PI_SPEAK_MINIMAX_SAMPLE_RATE || "24000", 10),
						bitrate: Number.parseInt(process.env.PI_SPEAK_MINIMAX_BITRATE || "32000", 10),
						format: process.env.PI_SPEAK_MINIMAX_FORMAT || "mp3",
						channel: Number.parseInt(process.env.PI_SPEAK_MINIMAX_CHANNEL || "1", 10),
					},
					stream: false,
				}),
				signal: requestSignal,
			}),
		signal,
	);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Minimax TTS failed (${response.status})${body ? `: ${body.slice(0, 240)}` : ""}`);
	}
	const json = (await response.json()) as { data?: { audio_hex?: string; audio?: string }; base_resp?: { status_msg?: string } };
	const hexAudio = json.data?.audio_hex || json.data?.audio;
	if (!hexAudio) {
		throw new Error(`Minimax TTS returned no audio${json.base_resp?.status_msg ? `: ${json.base_resp.status_msg}` : ""}`);
	}
	await writeFile(outputPath, Buffer.from(hexAudio, "hex"));
}


function getGradioSpaceBase(space: string) {
	const trimmed = space.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
	return `https://${trimmed.replace("/", "-")}.hf.space`;
}

async function uploadGradioFile(space: string, filePathOrUrl: string, signal?: AbortSignal) {
	const baseUrl = getGradioSpaceBase(space);
	const source = filePathOrUrl.trim();
	if (!source) throw new Error("A Gradio audio file path or URL is required");

	let bytes: Buffer;
	let fileName: string;
	if (/^https?:\/\//i.test(source)) {
		const response = await withAbortTimeout(
			(requestSignal) => fetch(source, { signal: requestSignal }),
			signal,
		);
		if (!response.ok) throw new Error(`Failed to fetch Gradio upload source (${response.status})`);
		bytes = Buffer.from(await response.arrayBuffer());
		fileName = basename(new URL(source).pathname) || "reference-audio.wav";
	} else {
		bytes = await readFile(source);
		fileName = basename(source) || "reference-audio.wav";
	}

	const form = new FormData();
	form.append("files", new Blob([new Uint8Array(bytes)]), fileName);
	const uploadResponse = await withAbortTimeout(
		(requestSignal) =>
			fetch(`${baseUrl}/upload`, {
				method: "POST",
				body: form,
				signal: requestSignal,
			}),
		signal,
	);
	if (!uploadResponse.ok) {
		throw new Error(`Gradio upload failed (${uploadResponse.status})`);
	}
	const uploadJson = await uploadResponse.json();
	const uploadedPath = Array.isArray(uploadJson) ? uploadJson[0] : uploadJson?.[0] || uploadJson?.path;
	if (typeof uploadedPath !== "string" || !uploadedPath) {
		throw new Error("Gradio upload did not return a file path");
	}
	return {
		path: uploadedPath,
		meta: { _type: "gradio.FileData" },
	};
}

function parseGradioEventData(streamText: string) {
	let latestData: unknown;
	for (const block of streamText.split(/\n\n+/)) {
		const lines = block.split(/\r?\n/);
		const eventLine = lines.find((line) => line.startsWith("event:"));
		const dataLines = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim());
		if (!dataLines.length) continue;
		const dataText = dataLines.join("\n");
		if (!dataText || dataText === "null") continue;
		try {
			const parsed = JSON.parse(dataText);
			latestData = parsed;
			if (eventLine?.includes("complete")) return parsed;
		} catch {
			latestData = dataText;
		}
	}
	return latestData;
}

async function callGradioApi(space: string, apiName: string, payload: Record<string, unknown>, signal?: AbortSignal) {
	const baseUrl = getGradioSpaceBase(space);
	const endpoint = apiName.replace(/^\//, "");
	const startResponse = await withAbortTimeout(
		(requestSignal) =>
			fetch(`${baseUrl}/call/v2/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: requestSignal,
			}),
		signal,
	);
	if (!startResponse.ok) {
		throw new Error(`Gradio ${apiName} start failed (${startResponse.status})`);
	}
	const startJson = await startResponse.json();
	const eventId = startJson?.event_id || startJson?.eventId || startJson?.id;
	if (typeof eventId !== "string" || !eventId) {
		throw new Error(`Gradio ${apiName} did not return an event id`);
	}

	const eventResponse = await withAbortTimeout(
		(requestSignal) =>
			fetch(`${baseUrl}/call/${endpoint}/${eventId}`, {
				headers: { Accept: "text/event-stream" },
				signal: requestSignal,
			}),
		signal,
	);
	if (!eventResponse.ok) {
		throw new Error(`Gradio ${apiName} event stream failed (${eventResponse.status})`);
	}
	return parseGradioEventData(await eventResponse.text());
}

function extractGradioAudioRef(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const ref = extractGradioAudioRef(item);
			if (ref) return ref;
		}
		return undefined;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["url", "path", "name"]) {
			const candidate = record[key];
			if (typeof candidate === "string" && candidate) return candidate;
		}
		for (const key of ["data", "value", "file"]) {
			const ref = extractGradioAudioRef(record[key]);
			if (ref) return ref;
		}
	}
	return undefined;
}

async function writeGradioAudioOutput(space: string, gradioResult: unknown, outputPath: string, signal?: AbortSignal) {
	const audioRef = extractGradioAudioRef(gradioResult);
	if (!audioRef) throw new Error("Gradio response did not include an audio output");
	const baseUrl = getGradioSpaceBase(space);
	const audioUrl = /^https?:\/\//i.test(audioRef)
		? audioRef
		: audioRef.startsWith("/file=")
			? `${baseUrl}${audioRef}`
			: audioRef.startsWith("file=")
				? `${baseUrl}/${audioRef}`
				: `${baseUrl}/file=${audioRef}`;
	const audioResponse = await withAbortTimeout(
		(requestSignal) => fetch(audioUrl, { signal: requestSignal }),
		signal,
	);
	if (!audioResponse.ok) {
		throw new Error(`Failed to download Gradio audio output (${audioResponse.status})`);
	}
	await writeFile(outputPath, Buffer.from(await audioResponse.arrayBuffer()));
}

async function synthesizeHiggs(text: string, outputPath: string, signal?: AbortSignal) {
	const referenceAudio = getHiggsReferenceAudio().trim();
	if (!referenceAudio) {
		throw new Error("PI_SPEAK_HIGGS_REFERENCE_AUDIO is required for Higgs TTS");
	}
	const referenceAudioFile = await uploadGradioFile(DEFAULT_HIGGS_SPACE, referenceAudio, signal);
	const referenceText = getHiggsReferenceText().trim() || String(
		await callGradioApi(DEFAULT_HIGGS_SPACE, "/transcribe", {
			reference_audio: referenceAudioFile,
		}, signal),
	).trim();
	if (!referenceText) {
		throw new Error("PI_SPEAK_HIGGS_REFERENCE_TEXT is required when Higgs transcription is unavailable");
	}
	const result = await callGradioApi(DEFAULT_HIGGS_SPACE, "/synthesize", {
		text,
		reference_audio: referenceAudioFile,
		reference_text: referenceText,
		temperature: DEFAULT_HIGGS_TEMPERATURE,
		top_p: DEFAULT_HIGGS_TOP_P,
		top_k: DEFAULT_HIGGS_TOP_K,
		max_new_tokens: DEFAULT_HIGGS_MAX_NEW_TOKENS,
		seed: DEFAULT_HIGGS_SEED,
	}, signal);
	await writeGradioAudioOutput(DEFAULT_HIGGS_SPACE, result, outputPath, signal);
}

async function synthesizeStableAudio(text: string, outputPath: string, signal?: AbortSignal) {
	const result = await callGradioApi(DEFAULT_STABLE_AUDIO_SPACE, "/infer", {
		variant_key: DEFAULT_STABLE_AUDIO_VARIANT,
		prompt: text,
		duration: DEFAULT_STABLE_AUDIO_DURATION,
		steps: DEFAULT_STABLE_AUDIO_STEPS,
		cfg_scale: DEFAULT_STABLE_AUDIO_CFG_SCALE,
		sampler_type: DEFAULT_STABLE_AUDIO_SAMPLER,
		seed: DEFAULT_STABLE_AUDIO_SEED,
	}, signal);
	await writeGradioAudioOutput(DEFAULT_STABLE_AUDIO_SPACE, result, outputPath, signal);
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

function synthesizeSag(text: string, outputPath: string, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (!process.env.ELEVENLABS_API_KEY) {
			reject(new Error("ELEVENLABS_API_KEY is required for sag TTS"));
			return;
		}
		const child = spawn(getSagCommand(), [
			"speak",
			"--no-play",
			"--model-id",
			DEFAULT_SAG_MODEL_ID,
			"--voice",
			DEFAULT_SAG_VOICE,
			"--format",
			DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
			"--output",
			outputPath,
		], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: false,
			windowsHide: true,
			shell: false,
		});
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abortHandler);
			child.stdin?.removeListener("error", handleStdinError);
			if (error) reject(error);
			else resolve();
		};
		const abortHandler = () => {
			try {
				child.kill();
			} catch {}
			finish(new Error("Speech synthesis aborted"));
		};
		const handleStdinError = (error: Error) => {
			finish(new Error(`Failed to write sag stdin: ${getErrorMessage(error)}`));
		};
		signal?.addEventListener("abort", abortHandler, { once: true });
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			finish(error);
		});
		child.on("exit", (code) => {
			if (code === 0) finish();
			else finish(new Error(`sag exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
		});
		if (!child.stdin) {
			finish(new Error("Failed to write sag stdin: stdin is unavailable"));
			return;
		}
		child.stdin.on("error", handleStdinError);
		try {
			child.stdin.write(text, (error) => {
				if (error) handleStdinError(error);
			});
			child.stdin.end();
		} catch (error) {
			handleStdinError(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export const activeAbortControllers = new Set<AbortController>();

export function abortAllActiveTTS() {
	for (const controller of activeAbortControllers) {
		controller.abort();
	}
	activeAbortControllers.clear();
}

export const testOverrides = {
	synthesizeElevenLabs: null as (null | ((text: string, outputPath: string, signal?: AbortSignal) => Promise<void>)),
	synthesizeEdge: null as (null | ((text: string, outputPath: string, signal?: AbortSignal) => Promise<void>)),
	synthesizeGemini: null as (null | ((text: string, outputPath: string, signal?: AbortSignal) => Promise<void>)),
	synthesizeHiggs: null as (null | ((text: string, outputPath: string, signal?: AbortSignal) => Promise<void>)),
	synthesizeStableAudio: null as (null | ((text: string, outputPath: string, signal?: AbortSignal) => Promise<void>)),
};

export async function synthesizeToFile(options: SynthesisOptions): Promise<SynthesisResult> {
	const provider = resolveTtsProvider(options.state);
	const localController = new AbortController();
	activeAbortControllers.add(localController);

	const onAbort = () => {
		localController.abort();
	};
	if (options.signal) {
		options.signal.addEventListener("abort", onAbort);
	}

	try {
		if (provider === "legacy") {
			await synthesizeLegacy(
				options.text,
				options.outputPath,
				localController.signal,
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
			? await rewriteForSpeech(options.text, localController.signal).catch(() => ({ text: options.text, applied: false }))
			: { text: options.text, applied: false };

		throwIfAborted(localController.signal);
		options.onPhase?.("voice");

		const spokenText = isSanitizeEnabled() ? sanitizeForSpeech(rewritten.text) : rewritten.text;

		let finalProvider = provider;
		try {
			switch (provider) {
				case "edge":
					if (testOverrides.synthesizeEdge) {
						await testOverrides.synthesizeEdge(spokenText, options.outputPath, localController.signal);
					} else {
						await synthesizeEdge(spokenText, options.outputPath, localController.signal);
					}
					break;
				case "openai":
					await synthesizeOpenAI(spokenText, options.outputPath, localController.signal);
					break;
				case "gemini":
					if (testOverrides.synthesizeGemini) {
						await testOverrides.synthesizeGemini(spokenText, options.outputPath, localController.signal);
					} else {
						await synthesizeGemini(spokenText, options.outputPath, localController.signal);
					}
					break;
				case "elevenlabs":
					if (testOverrides.synthesizeElevenLabs) {
						await testOverrides.synthesizeElevenLabs(spokenText, options.outputPath, localController.signal);
					} else {
						await synthesizeElevenLabs(spokenText, options.outputPath, localController.signal);
					}
					break;
				case "sag":
					await synthesizeSag(spokenText, options.outputPath, localController.signal);
					break;
				case "higgs":
					if (testOverrides.synthesizeHiggs) {
						await testOverrides.synthesizeHiggs(spokenText, options.outputPath, localController.signal);
					} else {
						await synthesizeHiggs(spokenText, options.outputPath, localController.signal);
					}
					break;
				case "stable-audio":
					if (testOverrides.synthesizeStableAudio) {
						await testOverrides.synthesizeStableAudio(spokenText, options.outputPath, localController.signal);
					} else {
						await synthesizeStableAudio(spokenText, options.outputPath, localController.signal);
					}
					break;
				case "minimax":
					await synthesizeMinimax(spokenText, options.outputPath, localController.signal);
					break;
				default:
					throw new Error(`Unsupported TTS provider: ${provider satisfies never}`);
			}
		} catch (error) {
			const allowProviderFallback = options.allowProviderFallback !== false;
			if (
				allowProviderFallback
				&& (provider === "openai" || provider === "gemini" || provider === "elevenlabs" || provider === "sag" || provider === "higgs" || provider === "stable-audio" || provider === "minimax")
			) {
				console.warn(`[TTS Fallback] Primary provider '${provider}' failed: ${getErrorMessage(error)}. Falling back to 'edge' TTS. Metrics: { timestamp: ${Date.now()}, originalProvider: "${provider}", targetProvider: "edge", error: "${getErrorMessage(error)}" }`);
				if (testOverrides.synthesizeEdge) {
					await testOverrides.synthesizeEdge(spokenText, options.outputPath, localController.signal);
				} else {
					await synthesizeEdge(spokenText, options.outputPath, localController.signal);
				}
				finalProvider = "edge";
			} else {
				throw error;
			}
		}

		return {
			provider: finalProvider,
			rewriteApplied: rewritten.applied,
		};
	} finally {
		activeAbortControllers.delete(localController);
		if (options.signal) {
			options.signal.removeEventListener("abort", onAbort);
		}
	}
}

export function getAudioMimeType(filePath: string) {
	try {
		const header = readFileSync(filePath, { flag: "r" }).subarray(0, 12);
		if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE") {
			return "audio/wav";
		}
	} catch {}
	const lower = basename(filePath).toLowerCase();
	if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
	if (lower.endsWith(".wav")) return "audio/wav";
	return "audio/mpeg";
}
