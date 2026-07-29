/**
 * OpenAI-Realtime-compatible Live backend (HF speech-to-speech /v1/realtime).
 * Maps the shared LiveBackendSession contract onto the OpenAI Realtime GA wire.
 */

import { WebSocket as WsSocket } from "ws";
import type {
	LiveAudioInput,
	LiveBackendConnectOptions,
	LiveBackendHandlers,
	LiveBackendSession,
	LiveImageInput,
} from "./live-backend.js";
import { buildOpenAiTurnDetection, type RealtimeTurnDetectionProfile } from "./realtime-turn-detection.js";

// tsconfig includes DOM, so the bare `WebSocket` name is the browser type
// (1-arg ctor). The `ws` package accepts Node client options as a 2nd arg —
// cast only the constructor, keep the instance typed loosely via the package export.
type NodeWsConstructor = new (
	address: string,
	options?: { headers?: Record<string, string>; handshakeTimeout?: number },
) => InstanceType<typeof WsSocket>;
const NodeWebSocket = WsSocket as unknown as NodeWsConstructor;

export type OpenAiRealtimeLiveConfig = {
	/** Full wss://…/v1/realtime?session_token=… URL, or base that we append /v1/realtime to. */
	connectUrl: string;
	/** Optional bearer for non-HF OpenAI Realtime endpoints. */
	apiKey?: string;
	voice?: string;
	instructions?: string;
	outputSampleRate?: number;
	inputSampleRate?: number;
	/** null disables transcription; undefined enables the official default only on api.openai.com. */
	inputTranscriptionModel?: string | null;
	/** Explicit model request; included in session.update only when set. */
	model?: string;
	/** Turn-detection profile; default preserves the bare server_vad behavior. */
	turnDetection?: RealtimeTurnDetectionProfile;
	connectTimeoutMs?: number;
};

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

export function resolveOpenAiRealtimeConnectUrl(env: NodeJS.ProcessEnv = process.env): string {
	const direct =
		env.PI_SPEAK_HF_REALTIME_URL?.trim() ||
		env.HF_REALTIME_URL?.trim() ||
		env.PI_SPEAK_OPENAI_REALTIME_URL?.trim() ||
		env.PI_SPEAK_S2S_URL?.trim() ||
		env.SPEECH_TO_SPEECH_URL?.trim() ||
		"";
	if (!direct) return "";
	let resolved: string;
	if (/\/v1\/realtime(\?|$)/i.test(direct)) {
		resolved = direct;
	} else if (direct.startsWith("ws://") || direct.startsWith("wss://") || direct.startsWith("http://") || direct.startsWith("https://")) {
		resolved = `${trimSlash(direct.replace(/^http/i, "ws"))}/v1/realtime`;
	} else {
		resolved = `wss://${trimSlash(direct)}/v1/realtime`;
	}
	try {
		const url = new URL(resolved);
		if (url.hostname.toLowerCase() === "api.openai.com" && !url.searchParams.has("model")) {
			url.searchParams.set("model", env.PI_SPEAK_OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime");
			return url.toString();
		}
	} catch {}
	return resolved;
}

export function isOpenAiRealtimeLiveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveOpenAiRealtimeConnectUrl(env).length > 0;
}

export function resolveOpenAiRealtimeApiKey(
	env: NodeJS.ProcessEnv = process.env,
	connectUrl = resolveOpenAiRealtimeConnectUrl(env),
): string | undefined {
	const hfEndpoint = env.PI_SPEAK_HF_REALTIME_URL?.trim() || env.HF_REALTIME_URL?.trim();
	if (hfEndpoint) {
		return env.PI_SPEAK_HF_TOKEN?.trim() || env.HF_TOKEN?.trim() || undefined;
	}
	try {
		if (new URL(connectUrl).hostname.toLowerCase() === "api.openai.com") {
			return env.PI_SPEAK_OPENAI_REALTIME_KEY?.trim() || env.OPENAI_API_KEY?.trim() || undefined;
		}
	} catch {}
	// A custom OpenAI-compatible endpoint may use a dedicated bearer token, but
	// must never receive a global OpenAI or Hugging Face provider credential.
	return env.PI_SPEAK_OPENAI_REALTIME_KEY?.trim() || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function base64ToBuffer(b64: string): Buffer {
	return Buffer.from(b64, "base64");
}

function bufferToBase64(buf: Buffer): string {
	return buf.toString("base64");
}

export function resamplePcm16Mono(pcm: Buffer, inputRate: number, outputRate: number): Buffer {
	if (inputRate === outputRate || pcm.length < 4) return pcm;
	const inputSamples = Math.floor(pcm.length / 2);
	const outputSamples = Math.max(1, Math.round(inputSamples * outputRate / inputRate));
	const output = Buffer.allocUnsafe(outputSamples * 2);
	for (let index = 0; index < outputSamples; index += 1) {
		const source = index * (inputSamples - 1) / Math.max(1, outputSamples - 1);
		const leftIndex = Math.floor(source);
		const rightIndex = Math.min(inputSamples - 1, leftIndex + 1);
		const fraction = source - leftIndex;
		const left = pcm.readInt16LE(leftIndex * 2);
		const right = pcm.readInt16LE(rightIndex * 2);
		output.writeInt16LE(Math.round(left + (right - left) * fraction), index * 2);
	}
	return output;
}

function normalizeJsonSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJsonSchema);
	const record = asRecord(value);
	if (!record) return value;
	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		if (key === "type" && typeof child === "string") {
			normalized[key] = child.toLowerCase();
		} else if (key === "type" && Array.isArray(child)) {
			normalized[key] = child.map((entry) => typeof entry === "string" ? entry.toLowerCase() : entry);
		} else {
			normalized[key] = normalizeJsonSchema(child);
		}
	}
	return normalized;
}

/**
 * Convert Gemini-style functionDeclarations into OpenAI Realtime session.tools.
 * Accepts the array shape produced by buildRealtimeTools().
 */
export function mapRealtimeToolsToOpenAi(tools: unknown): unknown[] {
	if (!Array.isArray(tools)) return [];
	const out: unknown[] = [];
	for (const group of tools) {
		const g = asRecord(group);
		const decls = g && Array.isArray(g.functionDeclarations) ? g.functionDeclarations : [];
		for (const decl of decls) {
			const d = asRecord(decl);
			if (!d || typeof d.name !== "string") continue;
			out.push({
				type: "function",
				name: d.name,
				description: typeof d.description === "string" ? d.description : "",
				parameters: normalizeJsonSchema(d.parameters ?? { type: "object", properties: {} }),
			});
		}
	}
	return out;
}

export async function connectOpenAiRealtimeLive(
	config: OpenAiRealtimeLiveConfig,
	options: LiveBackendConnectOptions,
	handlers: LiveBackendHandlers,
): Promise<LiveBackendSession> {
	const outputRate = config.outputSampleRate ?? 24_000;
	const configuredInputRate = config.inputSampleRate ?? 24_000;
	const inputRate = Number.isFinite(configuredInputRate) && configuredInputRate > 0 ? configuredInputRate : 24_000;
	let inputTranscriptionModel = config.inputTranscriptionModel ?? undefined;
	if (config.inputTranscriptionModel === undefined) {
		try {
			if (new URL(config.connectUrl).hostname.toLowerCase() === "api.openai.com") {
				inputTranscriptionModel = "gpt-4o-mini-transcribe";
			}
		} catch {}
	}
	const headers: Record<string, string> = {};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
		headers["OpenAI-Beta"] = "realtime=v1";
	}

	const connectTimeoutMs = config.connectTimeoutMs ?? 20_000;
	const ws = new NodeWebSocket(config.connectUrl, { headers, handshakeTimeout: connectTimeoutMs });
	let closed = false;
	let sessionUpdateSent = false;
	let readySent = false;
	let assistantTranscriptOpen = false;
	let activeResponseId = "";
	// Last assistant audio item, for conversation.item.truncate on barge-in.
	// Wall-clock since the first delta approximates what the client has played
	// (generation outpaces playback); min() with sent-ms keeps the estimate
	// within the item's real duration so the server never rejects it.
	let audioItemId = "";
	let audioItemMsSent = 0;
	let audioItemFirstDeltaAt = 0;
	let audioItemTruncated = false;
	const send = (payload: Record<string, unknown>) => {
		// readyState 1 === OPEN for both DOM and ws package enums.
		if (closed || ws.readyState !== 1) return false;
		ws.send(JSON.stringify(payload));
		return true;
	};
	const sessionUpdate = () => {
		const tools = mapRealtimeToolsToOpenAi(options.tools);
		const turnDetection = buildOpenAiTurnDetection(config.turnDetection ?? { kind: "server_vad" });
		send({
			type: "session.update",
			session: {
				type: "realtime",
				...(config.model ? { model: config.model } : {}),
				instructions: options.systemInstruction || config.instructions || "",
				output_modalities: ["audio"],
				audio: {
					input: {
						format: { type: "audio/pcm", rate: inputRate },
						...(inputTranscriptionModel ? { transcription: { model: inputTranscriptionModel } } : {}),
						turn_detection: turnDetection,
					},
					output: {
						format: { type: "audio/pcm", rate: outputRate },
						voice: config.voice || "alloy",
					},
				},
				tools,
				tool_choice: tools.length ? "auto" : "none",
			},
		});
	};

	// Trim the conversation's view of the last assistant reply down to what the
	// user actually heard. Without this an interrupted assistant "remembers"
	// saying everything it generated, and follow-ups refer to content that was
	// never spoken.
	const truncatePlayedAudio = () => {
		if (!audioItemId || audioItemTruncated) return;
		const elapsedMs = Math.max(0, Date.now() - audioItemFirstDeltaAt);
		const audioEndMs = Math.max(0, Math.min(Math.round(audioItemMsSent), elapsedMs));
		audioItemTruncated = true;
		send({
			type: "conversation.item.truncate",
			item_id: audioItemId,
			content_index: 0,
			audio_end_ms: audioEndMs,
		});
	};

	ws.on("message", (raw) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(String(raw)) as Record<string, unknown>;
		} catch {
			return;
		}
		const type = asString(msg.type);

		if (type === "session.created") {
			if (!sessionUpdateSent) {
				sessionUpdateSent = true;
				sessionUpdate();
			}
			return;
		}
		if (type === "session.updated") {
			if (!readySent) {
				readySent = true;
				handlers.onOutbound({ kind: "status", status: "ready", detail: type });
			}
			return;
		}

		if (type === "input_audio_buffer.speech_started") {
			// Server VAD barge-in: cancel the in-flight response, trim the
			// conversation to what was heard, and tell the client to clear.
			if (activeResponseId) send({ type: "response.cancel" });
			truncatePlayedAudio();
			handlers.onOutbound({ kind: "interrupt" });
			return;
		}

		if (type === "response.created") {
			const response = asRecord(msg.response);
			activeResponseId = asString(response?.id);
			audioItemId = "";
			audioItemMsSent = 0;
			audioItemTruncated = false;
			return;
		}

		if (type === "response.done") {
			activeResponseId = "";
			if (assistantTranscriptOpen) {
				assistantTranscriptOpen = false;
				handlers.onOutbound({ kind: "transcript", text: "", role: "assistant", final: true });
			}
			return;
		}
		if (type === "response.cancelled") {
			activeResponseId = "";
			assistantTranscriptOpen = false;
			return;
		}

		if (type === "response.output_audio.delta" || type === "response.audio.delta") {
			const delta = asString(msg.delta);
			if (!delta) return;
			const pcm = base64ToBuffer(delta);
			const itemId = asString(msg.item_id);
			if (itemId && itemId !== audioItemId) {
				audioItemId = itemId;
				audioItemMsSent = 0;
				audioItemFirstDeltaAt = Date.now();
				audioItemTruncated = false;
			}
			if (audioItemId) audioItemMsSent += (pcm.length / 2 / outputRate) * 1000;
			handlers.onOutbound({
				kind: "audio",
				pcm,
				sampleRate: outputRate,
			});
			return;
		}

		if (
			type === "response.output_audio_transcript.delta" ||
			type === "response.audio_transcript.delta"
		) {
			const delta = asString(msg.delta);
			if (delta) {
				assistantTranscriptOpen = true;
				handlers.onOutbound({ kind: "transcript", text: delta, role: "assistant" });
			}
			return;
		}
		if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
			const transcript = asString(msg.transcript);
			if (transcript && !assistantTranscriptOpen) {
				handlers.onOutbound({ kind: "transcript", text: transcript, role: "assistant" });
			}
			assistantTranscriptOpen = false;
			handlers.onOutbound({ kind: "transcript", text: "", role: "assistant", final: true });
			return;
		}

		if (
			type === "conversation.item.input_audio_transcription.completed"
		) {
			const transcript = asString(msg.transcript);
			if (transcript) handlers.onOutbound({ kind: "transcript", text: transcript, role: "user", final: true });
			return;
		}

		if (type === "response.function_call_arguments.done") {
			const callId = asString(msg.call_id) || asString(msg.id);
			const name = asString(msg.name);
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(asString(msg.arguments) || "{}") as Record<string, unknown>;
			} catch {
				args = {};
			}
			if (callId && name) {
				handlers.onOutbound({ kind: "tool_call", id: callId, name, args });
			}
			return;
		}

		if (type === "error") {
			const err = asRecord(msg.error);
			handlers.onOutbound({
				kind: "error",
				message: asString(err?.message) || asString(msg.message) || "OpenAI Realtime error",
			});
		}
	});

	ws.on("close", () => {
		closed = true;
		handlers.onOutbound({ kind: "status", status: "closed" });
	});


	await new Promise<void>((resolve, reject) => {
		const onConnectError = (err: unknown) => {
			clearTimeout(timer);
			reject(err instanceof Error ? err : new Error(String(err)));
		};
		const timer = setTimeout(() => {
			ws.off("error", onConnectError);
			ws.once("error", () => {});
			try {
				const pending = ws as unknown as { _req?: { destroy(): void }; close(): void };
				pending._req?.destroy();
				pending.close();
			} catch {}
			reject(new Error("OpenAI Realtime connect timed out"));
		}, connectTimeoutMs + 100);
		ws.once("open", () => {
			clearTimeout(timer);
			ws.off("error", onConnectError);
			resolve();
		});
		ws.once("error", onConnectError);
	});
	ws.on("error", (err) => {
		handlers.onOutbound({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	});

	const session: LiveBackendSession = {
		kind: "openai-realtime",
		sendAudio(input: LiveAudioInput) {
			const pcm = resamplePcm16Mono(input.pcm, input.sampleRate, inputRate);
			send({ type: "input_audio_buffer.append", audio: bufferToBase64(pcm) });
		},
		sendText(text: string) {
			send({
				type: "conversation.item.create",
				item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
			});
			send({ type: "response.create" });
		},
		sendImage(input: LiveImageInput) {
			const delivered = send({
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "user",
					content: [{ type: "input_image", image_url: `data:${input.mimeType};base64,${input.data}` }],
				},
			});
			if (delivered && !input.deferResponse) send({ type: "response.create" });
			return delivered;
		},
		interrupt() {
			// Client-initiated barge-in. Never clear the input buffer here: with a
			// voice-triggered interrupt the user's opening words are already in the
			// buffer, and clearing them would eat the start of the interjection.
			if (activeResponseId) send({ type: "response.cancel" });
			truncatePlayedAudio();
			handlers.onOutbound({ kind: "interrupt" });
		},
		sendToolResult(callId: string, name: string, output: string) {
			const delivered = send({
				type: "conversation.item.create",
				item: { type: "function_call_output", call_id: callId, output },
			});
			void name;
			if (delivered) send({ type: "response.create" });
			return delivered;
		},
		close() {
			closed = true;
			try { ws.close(); } catch {}
		},
	};

	return session;
}
