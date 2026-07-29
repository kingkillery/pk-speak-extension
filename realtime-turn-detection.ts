/**
 * Turn-detection / VAD profile for the realtime voice stack.
 *
 * One operator-facing profile (env-driven), translated per backend:
 *  - OpenAI-Realtime GA: `session.audio.input.turn_detection`
 *    (`server_vad` with tunables, `semantic_vad` with eagerness, or null).
 *  - Gemini Live: `realtimeInputConfig.automaticActivityDetection`
 *    (prefix/silence ms + end-of-speech sensitivity mapped from eagerness).
 *
 * Semantics of the knobs, in user terms:
 *  - `semantic_vad` — the model waits through mid-thought pauses ("um…",
 *    trailing commas in speech) instead of replying the instant you go quiet.
 *  - `silenceMs` — how long a pause must be before it counts as end-of-turn.
 *  - `eagerness` — low = patient (lets you think), high = snappy replies.
 *
 * Defaults are wire-identical to the historical behavior: bare
 * `{ type: "server_vad" }` on OpenAI and no `realtimeInputConfig` on Gemini.
 */

export type RealtimeTurnDetectionKind = "server_vad" | "semantic_vad" | "none";

export type RealtimeVadEagerness = "low" | "medium" | "high" | "auto";

export type RealtimeTurnDetectionProfile = {
	kind: RealtimeTurnDetectionKind;
	/** semantic_vad only on OpenAI; maps to end-of-speech sensitivity on Gemini. */
	eagerness?: RealtimeVadEagerness;
	/** server_vad activation threshold 0..1 (OpenAI only). */
	threshold?: number;
	/** Audio kept before detected speech start, ms (OpenAI server_vad + Gemini). */
	prefixPaddingMs?: number;
	/** Silence required to declare end-of-turn, ms (OpenAI server_vad + Gemini). */
	silenceDurationMs?: number;
};

function parseBoundedInt(raw: string | undefined, min: number, max: number): number | undefined {
	if (!raw?.trim()) return undefined;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) return undefined;
	return Math.min(max, Math.max(min, value));
}

function parseThreshold(raw: string | undefined): number | undefined {
	if (!raw?.trim()) return undefined;
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value)) return undefined;
	return Math.min(1, Math.max(0, value));
}

function parseEagerness(raw: string | undefined): RealtimeVadEagerness | undefined {
	const value = raw?.trim().toLowerCase();
	if (value === "low" || value === "medium" || value === "high" || value === "auto") return value;
	return undefined;
}

export function resolveRealtimeTurnDetection(env: NodeJS.ProcessEnv = process.env): RealtimeTurnDetectionProfile {
	const raw = (env.PI_SPEAK_REALTIME_TURN_DETECTION || "").trim().toLowerCase();
	let kind: RealtimeTurnDetectionKind = "server_vad";
	if (raw === "semantic_vad" || raw === "semantic") kind = "semantic_vad";
	else if (raw === "none" || raw === "off" || raw === "disabled" || raw === "manual") kind = "none";

	return {
		kind,
		eagerness: parseEagerness(env.PI_SPEAK_REALTIME_VAD_EAGERNESS),
		threshold: parseThreshold(env.PI_SPEAK_REALTIME_VAD_THRESHOLD),
		prefixPaddingMs: parseBoundedInt(env.PI_SPEAK_REALTIME_VAD_PREFIX_MS, 0, 5_000),
		silenceDurationMs: parseBoundedInt(env.PI_SPEAK_REALTIME_VAD_SILENCE_MS, 0, 10_000),
	};
}

/**
 * OpenAI Realtime GA `turn_detection` payload. `null` disables server turn
 * detection entirely (push-to-talk clients drive commits manually).
 */
export function buildOpenAiTurnDetection(
	profile: RealtimeTurnDetectionProfile,
): Record<string, unknown> | null {
	if (profile.kind === "none") return null;
	if (profile.kind === "semantic_vad") {
		return {
			type: "semantic_vad",
			...(profile.eagerness ? { eagerness: profile.eagerness } : {}),
		};
	}
	return {
		type: "server_vad",
		...(profile.threshold !== undefined ? { threshold: profile.threshold } : {}),
		...(profile.prefixPaddingMs !== undefined ? { prefix_padding_ms: profile.prefixPaddingMs } : {}),
		...(profile.silenceDurationMs !== undefined ? { silence_duration_ms: profile.silenceDurationMs } : {}),
	};
}

/**
 * Gemini Live `realtimeInputConfig`. Returns undefined when the profile adds
 * nothing beyond Gemini's defaults so the historical connect config is
 * preserved byte-for-byte.
 *
 * `kind: "none"` intentionally falls back to automatic detection: with manual
 * activity detection Gemini requires activityStart/activityEnd markers that no
 * pi-speak client sends, so disabling VAD would deadlock every turn.
 */
export function buildGeminiRealtimeInputConfig(
	profile: RealtimeTurnDetectionProfile,
): Record<string, unknown> | undefined {
	const detection: Record<string, unknown> = {};
	if (profile.prefixPaddingMs !== undefined) detection.prefixPaddingMs = profile.prefixPaddingMs;
	if (profile.silenceDurationMs !== undefined) detection.silenceDurationMs = profile.silenceDurationMs;
	if (profile.eagerness === "low") detection.endOfSpeechSensitivity = "END_SENSITIVITY_LOW";
	else if (profile.eagerness === "high") detection.endOfSpeechSensitivity = "END_SENSITIVITY_HIGH";
	if (Object.keys(detection).length === 0) return undefined;
	return { automaticActivityDetection: detection };
}
