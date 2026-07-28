/**
 * Live speech-to-speech backend adapter.
 *
 * Client methodology follows Hugging Face realtime voice (WebSocket PCM,
 * worklet capture/playback, barge-in clear). Upstream backends stay pluggable:
 * Gemini Live today, OpenAI-Realtime-compatible (HF speech-to-speech) later.
 *
 * The gateway owns one adapter per client WS. Clients never talk to provider
 * APIs directly — they speak the pi-speak `/v1/live` wire protocol.
 */

export type LiveBackendKind = "gemini" | "openai-realtime";

export type LiveAudioInput = {
	/** Raw PCM16 LE mono bytes (no sequence header). */
	pcm: Buffer;
	/** Sample rate of pcm (gateway normalizes to 16 kHz for Gemini). */
	sampleRate: number;
};

export type LiveImageInput = {
	/** Base64-encoded image bytes (no data: prefix). */
	data: string;
	mimeType: string;
	/** Attach image without starting a response; used while completing a camera tool call. */
	deferResponse?: boolean;
};

export type LiveBackendOutbound =
	| { kind: "audio"; pcm: Buffer; sampleRate: number }
	| { kind: "transcript"; text: string; role: "user" | "assistant"; final?: boolean }
	| { kind: "interrupt" }
	| { kind: "tool_call"; id: string; name: string; args: Record<string, unknown> }
	| { kind: "status"; status: string; detail?: string }
	| { kind: "error"; message: string };

export type LiveBackendHandlers = {
	onOutbound: (event: LiveBackendOutbound) => void;
};

export type LiveBackendConnectOptions = {
	systemInstruction?: string;
	/** Provider-native tool declarations (shape depends on backend). */
	tools?: unknown;
	resumptionHandle?: string;
};

/**
 * Minimal surface every Live backend must implement so the gateway can
 * multiplex Gemini Live and OpenAI-Realtime-compatible S2S without forking
 * the client wire protocol.
 */
export type LiveBackendSession = {
	readonly kind: LiveBackendKind;
	sendAudio(input: LiveAudioInput): void;
	sendText(text: string): void;
	sendImage?(input: LiveImageInput): boolean;
	interrupt(): void;
	/** Deliver a tool result; false means the caller must queue it for reconnect. */
	sendToolResult?(callId: string, name: string, output: string): boolean;
	close(): void;
};

export type LiveBackendFactory = {
	kind: LiveBackendKind;
	connect(options: LiveBackendConnectOptions, handlers: LiveBackendHandlers): Promise<LiveBackendSession>;
};

/** True when an S2S / OpenAI-Realtime WebSocket URL is explicitly configured. */
export function hasConfiguredS2sUrl(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(
		env.PI_SPEAK_OPENAI_REALTIME_URL?.trim() ||
		env.PI_SPEAK_S2S_URL?.trim() ||
		env.SPEECH_TO_SPEECH_URL?.trim(),
	);
}

/**
 * Resolve which Live backend the gateway should use.
 *
 * The HF speech-to-speech server (https://github.com/huggingface/speech-to-speech)
 * is the default S2S upstream: any configured S2S URL selects `openai-realtime`
 * without needing PI_SPEAK_LIVE_BACKEND. Gemini remains the fallback when
 * nothing S2S-related is configured, and an explicit `gemini` always wins.
 */
export function resolveLiveBackendKind(env: NodeJS.ProcessEnv = process.env): LiveBackendKind {
	const raw = (env.PI_SPEAK_LIVE_BACKEND || env.PI_SPEAK_S2S_BACKEND || "").trim().toLowerCase();
	if (raw === "openai" || raw === "openai-realtime" || raw === "s2s" || raw === "hf" || raw === "huggingface") {
		return "openai-realtime";
	}
	if (raw === "gemini" || raw === "google") {
		return "gemini";
	}
	if (!raw && hasConfiguredS2sUrl(env)) {
		return "openai-realtime";
	}
	return "gemini";
}

/**
 * OpenAI Realtime GA event names we map at the edge when an S2S backend is
 * wired. Kept here (not only in docs) so client/gateway stay aligned.
 */
export const OPENAI_REALTIME_CLIENT_EVENTS = [
	"session.update",
	"input_audio_buffer.append",
	"input_audio_buffer.commit",
	"input_audio_buffer.clear",
	"conversation.item.create",
	"response.create",
	"response.cancel",
] as const;

export const OPENAI_REALTIME_SERVER_EVENTS = [
	"session.created",
	"session.updated",
	"input_audio_buffer.speech_started",
	"input_audio_buffer.speech_stopped",
	"conversation.item.input_audio_transcription.completed",
	"response.created",
	"response.output_audio.delta",
	"response.audio.delta",
	"response.output_audio_transcript.delta",
	"response.audio_transcript.delta",
	"response.output_audio_transcript.done",
	"response.audio_transcript.done",
	"response.function_call_arguments.done",
	"response.done",
	"response.cancelled",
	"error",
] as const;


/** Gemini Live supports session resumption handles; OpenAI-Realtime/HF does not. */
export function liveBackendSupportsResumption(kind: LiveBackendKind): boolean {
	return kind === "gemini";
}
