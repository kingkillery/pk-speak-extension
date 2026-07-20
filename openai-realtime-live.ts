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

// tsconfig includes DOM, so the bare `WebSocket` name is the browser type
// (1-arg ctor). The `ws` package accepts Node client options as a 2nd arg —
// cast only the constructor, keep the instance typed loosely via the package export.
type NodeWsConstructor = new (
	address: string,
	options?: { headers?: Record<string, string> },
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
};

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

export function resolveOpenAiRealtimeConnectUrl(env: NodeJS.ProcessEnv = process.env): string {
	const direct =
		env.PI_SPEAK_OPENAI_REALTIME_URL?.trim() ||
		env.PI_SPEAK_S2S_URL?.trim() ||
		env.SPEECH_TO_SPEECH_URL?.trim() ||
		"";
	if (!direct) return "";
	if (/\/v1\/realtime(\?|$)/i.test(direct)) return direct;
	// Bare host or LB-less server root → append path.
	if (direct.startsWith("ws://") || direct.startsWith("wss://") || direct.startsWith("http://") || direct.startsWith("https://")) {
		const asWs = direct.replace(/^http/i, "ws");
		return `${trimSlash(asWs)}/v1/realtime`;
	}
	return `wss://${trimSlash(direct)}/v1/realtime`;
}

export function isOpenAiRealtimeLiveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveOpenAiRealtimeConnectUrl(env).length > 0;
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
				parameters: d.parameters ?? { type: "object", properties: {} },
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
	const headers: Record<string, string> = {};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
		headers["OpenAI-Beta"] = "realtime=v1";
	}

	const ws = new NodeWebSocket(config.connectUrl, { headers });
	let closed = false;
	let configured = false;
	/** response_id currently speaking (for barge-in cancel). */
	let activeResponseId = "";

	const send = (payload: Record<string, unknown>) => {
		// readyState 1 === OPEN for both DOM and ws package enums.
		if (closed || ws.readyState !== 1) return;
		ws.send(JSON.stringify(payload));
	};
	const sessionUpdate = () => {
		const tools = mapRealtimeToolsToOpenAi(options.tools);
		send({
			type: "session.update",
			session: {
				type: "realtime",
				instructions: options.systemInstruction || config.instructions || "",
				output_modalities: ["audio"],
				audio: {
					input: {
						format: { type: "audio/pcm", rate: 16_000 },
						turn_detection: { type: "server_vad" },
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

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("OpenAI Realtime connect timed out")), 20_000);
		ws.once("open", () => {
			clearTimeout(timer);
			resolve();
		});
		ws.once("error", (err) => {
			clearTimeout(timer);
			reject(err instanceof Error ? err : new Error(String(err)));
		});
	});

	ws.on("message", (raw) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(String(raw)) as Record<string, unknown>;
		} catch {
			return;
		}
		const type = asString(msg.type);

		if (type === "session.created" || type === "session.updated") {
			if (!configured) {
				configured = true;
				sessionUpdate();
			}
			handlers.onOutbound({ kind: "status", status: "ready", detail: type });
			return;
		}

		if (type === "input_audio_buffer.speech_started") {
			// Server VAD barge-in: cancel in-flight response and tell client to clear.
			if (activeResponseId) send({ type: "response.cancel" });
			handlers.onOutbound({ kind: "interrupt" });
			return;
		}

		if (type === "response.created") {
			const response = asRecord(msg.response);
			activeResponseId = asString(response?.id);
			return;
		}

		if (type === "response.done" || type === "response.cancelled") {
			activeResponseId = "";
			return;
		}

		if (type === "response.output_audio.delta" || type === "response.audio.delta") {
			const delta = asString(msg.delta);
			if (!delta) return;
			handlers.onOutbound({
				kind: "audio",
				pcm: base64ToBuffer(delta),
				sampleRate: outputRate,
			});
			return;
		}

		if (
			type === "response.output_audio_transcript.delta" ||
			type === "response.audio_transcript.delta"
		) {
			const delta = asString(msg.delta);
			if (delta) handlers.onOutbound({ kind: "transcript", text: delta, role: "assistant" });
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

	const session: LiveBackendSession = {
		kind: "openai-realtime",
		sendAudio(input: LiveAudioInput) {
			// Expect 16 kHz PCM16 from the gateway client path.
			void input.sampleRate;
			send({
				type: "input_audio_buffer.append",
				audio: bufferToBase64(input.pcm),
			});
		},
		sendText(text: string) {
			send({
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text }],
				},
			});
			send({ type: "response.create" });
		},
		sendImage(input: LiveImageInput) {
			send({
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "user",
					content: [{
						type: "input_image",
						image_url: `data:${input.mimeType};base64,${input.data}`,
					}],
				},
			});
			send({ type: "response.create" });
		},
		interrupt() {
			send({ type: "response.cancel" });
			send({ type: "input_audio_buffer.clear" });
			handlers.onOutbound({ kind: "interrupt" });
		},
		sendToolResult(callId: string, name: string, output: string) {
			send({
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id: callId,
					output,
				},
			});
			// Keep name available for logs; OpenAI wire keys on call_id.
			void name;
			send({ type: "response.create" });
		},
		close() {
			closed = true;
			try { ws.close(); } catch { /* ignore */ }
		},
	};

	return session;
}
