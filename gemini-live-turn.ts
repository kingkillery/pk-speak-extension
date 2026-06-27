import { GoogleGenAI, Modality, Type, type LiveServerMessage, type LiveServerToolCall } from "@google/genai";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTurnResult } from "./remote-turn-manager.js";

const DEFAULT_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
// Vertex AI does not expose the developer-API native-audio preview name. The
// half-cascade Live model below is the one that resolves over Vertex BidiGenerateContent.
const DEFAULT_VERTEX_LIVE_MODEL = "gemini-live-2.5-flash";
const DEFAULT_TEXT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 45000;
// Vertex Live (BidiGenerateContent) wants v1beta1; the developer API wants v1beta.
const DEFAULT_VERTEX_API_VERSION = "v1beta1";
// Vertex serves Gemini Live publisher models from the `global` location, not regional ones.
const DEFAULT_VERTEX_LIVE_LOCATION = "global";

type GeminiBackend = "developer-api" | "vertex";

export function isGeminiLiveConfigured(env: NodeJS.ProcessEnv = process.env) {
	return !!(env.PI_SPEAK_VERTEX_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_API_KEY || getVertexConfig(env));
}

export function getGeminiLiveModel(env: NodeJS.ProcessEnv = process.env) {
	const override = env.PI_SPEAK_GEMINI_LIVE_MODEL?.trim();
	if (override) return override;
	return getGeminiBackend(env) === "vertex" ? DEFAULT_VERTEX_LIVE_MODEL : DEFAULT_LIVE_MODEL;
}

// Vertex Live requires apiVersion v1beta1; the generic PI_SPEAK_GEMINI_API_VERSION
// (often v1beta or v1) is correct for the developer API but breaks the Vertex Live
// websocket handshake. Resolve per-backend, honoring an explicit Vertex-only override.
export function getGeminiApiVersion(backend: GeminiBackend, env: NodeJS.ProcessEnv = process.env) {
	if (backend === "vertex") {
		return env.PI_SPEAK_VERTEX_API_VERSION?.trim() || DEFAULT_VERTEX_API_VERSION;
	}
	return env.PI_SPEAK_GEMINI_API_VERSION?.trim() || "v1beta";
}

export function getGeminiBackend(env: NodeJS.ProcessEnv = process.env): GeminiBackend {
	const configured = (env.PI_SPEAK_GEMINI_BACKEND || env.GOOGLE_GENAI_BACKEND || "").trim().toLowerCase();
	if (configured === "vertex" || configured === "vertexai" || configured === "gcloud") return "vertex";
	if (configured === "developer-api" || configured === "developer" || configured === "api") return "developer-api";
	if (isTruthy(env.GOOGLE_GENAI_USE_VERTEXAI) || isTruthy(env.GOOGLE_GENAI_USE_ENTERPRISE)) return "vertex";
	if (env.PI_SPEAK_VERTEX_API_KEY) return "vertex";
	if (!env.GOOGLE_API_KEY && !env.GEMINI_API_KEY && getVertexConfig(env)) return "vertex";
	return "developer-api";
}

function getVertexConfig(env: NodeJS.ProcessEnv = process.env) {
	const project = env.GOOGLE_CLOUD_PROJECT?.trim() || env.GCLOUD_PROJECT?.trim() || env.PI_SPEAK_VERTEX_PROJECT?.trim();
	const location = env.GOOGLE_CLOUD_LOCATION?.trim() || env.GOOGLE_CLOUD_REGION?.trim() || env.PI_SPEAK_VERTEX_LOCATION?.trim();
	if (!project || !location) return undefined;
	return { project, location };
}

export function createGeminiClient(
	env: NodeJS.ProcessEnv = process.env,
	options: { live?: boolean } = {},
) {
	const backend = getGeminiBackend(env);
	const apiVersion = getGeminiApiVersion(backend, env);
	if (backend === "vertex") {
		const vertex = getVertexConfig(env);
		if (vertex) {
			// Vertex Live publisher models are served from `global`; regional locations
			// resolve fine for text/generateContent but reject the Live websocket.
			const location = options.live
				? env.PI_SPEAK_VERTEX_LIVE_LOCATION?.trim() || DEFAULT_VERTEX_LIVE_LOCATION
				: vertex.location;
			return {
				ai: new GoogleGenAI({
					vertexai: true,
					project: vertex.project,
					location,
					apiVersion,
				}),
				backend: "vertex" as const,
			};
		}
		const apiKey = env.PI_SPEAK_VERTEX_API_KEY?.trim();
		if (!apiKey) {
			throw new Error("Vertex AI Gemini requires PI_SPEAK_VERTEX_API_KEY, or GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.");
		}
		return {
			ai: new GoogleGenAI({
				vertexai: true,
				apiKey,
				apiVersion,
			}),
			backend: "vertex" as const,
		};
	}
	const apiKey = env.GOOGLE_API_KEY || env.GEMINI_API_KEY;
	if (!apiKey) throw new Error("GOOGLE_API_KEY is required for Gemini Developer API turns, or configure Vertex AI.");
	return {
		ai: new GoogleGenAI({ apiKey, apiVersion }),
		backend: "developer-api" as const,
	};
}

function isTruthy(value: string | undefined) {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export async function runGeminiTextTurn(
	prompt: string,
	options: { apiKey?: string; model?: string; timeoutMs?: number } = {},
): Promise<RemoteTurnResult> {
	const client = options.apiKey
		? { ai: new GoogleGenAI({ apiKey: options.apiKey, apiVersion: getGeminiApiVersion("developer-api") }), backend: "developer-api" as const }
		: createGeminiClient(process.env);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
	try {
		const response = await client.ai.models.generateContent({
			model: options.model || process.env.PI_SPEAK_GEMINI_TEXT_MODEL || DEFAULT_TEXT_MODEL,
			contents: prompt,
			config: {
				abortSignal: controller.signal,
			},
		});
		return {
			replyText: response.text?.trim() || "Gemini completed the turn without returning text.",
			transcript: prompt,
			providers: { agent: client.backend === "vertex" ? "vertex" : "gemini" },
		};
	} finally {
		clearTimeout(timeout);
	}
}

export type GeminiToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

const OMP_FUNCTION_DECLARATION = {
	name: "run_coding_task",
	description: "Execute a coding/system task via the oh-my-pi agent. Use for file ops, code generation, running tests, reading files, or any concrete action. Returns the agent's text output.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			task: { type: Type.STRING, description: "The task description for the coding agent." },
		},
		required: ["task"],
	},
};

export async function runGeminiLiveTurn(
	prompt: string,
	options: { apiKey?: string; model?: string; timeoutMs?: number; toolHandler?: GeminiToolHandler } = {},
): Promise<RemoteTurnResult> {
	const model = options.model || getGeminiLiveModel();
	const client = options.apiKey
		? { ai: new GoogleGenAI({ apiKey: options.apiKey, apiVersion: getGeminiApiVersion("developer-api") }), backend: "developer-api" as const }
		: createGeminiClient(process.env, { live: true });
	const ai = client.ai;
	const audioChunks: Buffer[] = [];
	let audioMimeType = "audio/pcm;rate=24000";
	let replyText = "";
	let setupComplete = false;
	let turnComplete = false;
	let session: Awaited<ReturnType<typeof ai.live.connect>> | undefined;
	const timeoutMs = options.timeoutMs || Number.parseInt(process.env.PI_SPEAK_GEMINI_LIVE_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
	const withTools = !!options.toolHandler;

	const handleToolCall = async (toolCall: LiveServerToolCall) => {
		if (!session || !options.toolHandler) return;
		const functionResponses: Array<{ id: string; name: string; response: { output: string } }> = [];
		for (const fc of toolCall.functionCalls || []) {
			if (!fc.id || !fc.name) continue;
			let output: string;
			try {
				output = await options.toolHandler(fc.name, (fc.args || {}) as Record<string, unknown>);
			} catch (err) {
				output = `Error: ${err instanceof Error ? err.message : String(err)}`;
			}
			functionResponses.push({ id: fc.id, name: fc.name, response: { output } });
		}
		if (functionResponses.length > 0) {
			session.sendToolResponse({ functionResponses });
		}
	};

	const result = await new Promise<RemoteTurnResult>((resolve, reject) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				session?.close();
			} catch {}
			if (!setupComplete) {
				reject(new Error(`Gemini Live did not complete setup for ${model}.`));
				return;
			}
			if (!turnComplete && audioChunks.length === 0 && !replyText.trim()) {
				reject(new Error(`Gemini Live produced no content for ${model}.`));
				return;
			}
			resolve(buildGeminiLiveResult({
				model,
				replyText,
				prompt,
				audioChunks,
				audioMimeType,
				providerName: client.backend === "vertex" ? "vertex-live" : "gemini-live",
			}));
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				session?.close();
			} catch {}
			reject(error);
		};
		const timer = setTimeout(finish, timeoutMs);

		const config: Parameters<typeof ai.live.connect>[0]["config"] = {
			responseModalities: [Modality.AUDIO],
			outputAudioTranscription: {},
			systemInstruction: process.env.PI_SPEAK_GEMINI_SYSTEM_PROMPT ||
				(withTools
					? "You are a voice assistant for a coding workflow. For conversational questions, reply directly and briefly. For tasks that require file access, code execution, or system actions, call run_coding_task with the task description and narrate the result naturally."
					: "You are a concise voice coding assistant."),
			...(withTools ? { tools: [{ functionDeclarations: [OMP_FUNCTION_DECLARATION] }] } : {}),
		};

		ai.live.connect({
			model,
			config,
			callbacks: {
				onopen: () => {},
				onmessage: (message: LiveServerMessage) => {
					if (message.setupComplete) setupComplete = true;
					replyText += extractText(message);
					for (const part of message.serverContent?.modelTurn?.parts || []) {
						if (!part.inlineData?.data) continue;
						if (part.inlineData.mimeType) audioMimeType = part.inlineData.mimeType;
						audioChunks.push(Buffer.from(part.inlineData.data, "base64"));
					}
					if (message.toolCall) {
						handleToolCall(message.toolCall).catch(fail);
						return;
					}
					if (message.serverContent?.turnComplete) {
						turnComplete = true;
						finish();
					}
				},
				onerror: (event) => fail(event.error || event.message || event),
				onclose: (event) => {
					if (!settled && event.code && event.code !== 1000) {
						fail(new Error(`Gemini Live closed ${event.code}: ${event.reason || "no reason"}`));
					} else {
						finish();
					}
				},
			},
		}).then((connected) => {
			session = connected;
			session.sendClientContent({
				turns: [{ role: "user", parts: [{ text: prompt }] }],
				turnComplete: true,
			});
		}).catch(fail);
	});

	return result;
}

function buildGeminiLiveResult({
	model,
	replyText,
	prompt,
	audioChunks,
	audioMimeType,
	providerName,
}: {
	model: string;
	replyText: string;
	prompt: string;
	audioChunks: Buffer[];
	audioMimeType: string;
	providerName: "gemini-live" | "vertex-live";
}): RemoteTurnResult {
	let audioPath: string | undefined;
	let outputMimeType: string | undefined;
	if (audioChunks.length > 0) {
		const audioDir = mkdtempSync(join(tmpdir(), "pi-speak-gemini-live-"));
		try {
			const pcm = Buffer.concat(audioChunks);
			audioPath = join(audioDir, "reply.wav");
			writeFileSync(audioPath, toWav(pcm, parsePcmSampleRate(audioMimeType)));
			outputMimeType = "audio/wav";
		} catch (error) {
			try {
				rmSync(audioDir, { recursive: true, force: true });
			} catch {}
			throw error;
		}
	}
	return {
		replyText: replyText.trim() || "Gemini returned audio without a transcript.",
		transcript: prompt,
		audioPath,
		audioMimeType: outputMimeType,
		providers: { agent: providerName, tts: audioPath ? providerName : undefined },
		warnings: model.includes("3.1") ? ["gemini-3.1-live-preview is still preview; fall back if it stalls."] : undefined,
	};
}

function extractText(message: LiveServerMessage): string {
	let text = "";
	const transcript = message.serverContent?.outputTranscription?.text;
	if (typeof transcript === "string") text += transcript;
	for (const part of message.serverContent?.modelTurn?.parts || []) {
		if (typeof part.text === "string") text += part.text;
	}
	return text;
}

function parsePcmSampleRate(mimeType: string) {
	const match = /(?:^|;)rate=(\d+)(?:;|$)/i.exec(mimeType);
	return match ? Number.parseInt(match[1], 10) : 24000;
}

function toWav(pcm: Buffer, sampleRate: number) {
	const channels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * channels * bitsPerSample / 8;
	const blockAlign = channels * bitsPerSample / 8;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
