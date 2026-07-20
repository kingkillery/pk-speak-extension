/**
 * Unified voice-layer mode for pk-speak.
 *
 * One operator-facing toggle over the three real switches:
 *   - TTS  (spoken replies, `speakState`)
 *   - STT  (always-on PK wake listener, `monoActive`)
 *   - realtime (Gemini Live conversational agent, served via `/v1/live`)
 *
 * Turn-based "combo" (TTS + STT) is deliberately distinct from realtime:
 * combo is a half-duplex speak/transcribe loop, while realtime is the
 * full-duplex emotive live agent (Gemini Live / GPT-realtime class).
 */

export type VoiceMode = "off" | "tts" | "stt" | "combo" | "realtime";

export type VoiceModeState = {
	speakEnabled: boolean;
	sttEnabled: boolean;
	realtime: boolean;
};

export const VOICE_MODES: readonly VoiceMode[] = ["off", "tts", "stt", "combo", "realtime"];

const KNOWN_MODES: Record<VoiceMode, true> = {
	off: true,
	tts: true,
	stt: true,
	combo: true,
	realtime: true,
};

/** The concrete switch positions each mode implies. */
export function voiceModeTargets(mode: VoiceMode): VoiceModeState {
	switch (mode) {
		case "tts":
			return { speakEnabled: true, sttEnabled: false, realtime: false };
		case "stt":
			return { speakEnabled: false, sttEnabled: true, realtime: false };
		case "combo":
			return { speakEnabled: true, sttEnabled: true, realtime: false };
		case "realtime":
			// The live client owns mic + playback; the local turn-based loop
			// stands down so the two audio paths never fight.
			return { speakEnabled: false, sttEnabled: false, realtime: true };
		default:
			return { speakEnabled: false, sttEnabled: false, realtime: false };
	}
}

/** Derives the display mode from the actual switch positions. */
export function resolveVoiceMode(state: VoiceModeState): VoiceMode {
	if (state.realtime) return "realtime";
	if (state.speakEnabled && state.sttEnabled) return "combo";
	if (state.speakEnabled) return "tts";
	if (state.sttEnabled) return "stt";
	return "off";
}

/** Restores persisted entries while keeping "off" the safe default. */
export function normalizeVoiceMode(raw: unknown): VoiceMode {
	return typeof raw === "string" && Object.hasOwn(KNOWN_MODES, raw) ? (raw as VoiceMode) : "off";
}

/** Bare `/voice` cycles through every mode — the single "easy toggle". */
export function nextVoiceMode(mode: VoiceMode): VoiceMode {
	const index = VOICE_MODES.indexOf(mode);
	return VOICE_MODES[(index + 1) % VOICE_MODES.length];
}

export function describeVoiceMode(mode: VoiceMode): string {
	switch (mode) {
		case "tts":
			return "spoken replies only (TTS on, listener off)";
		case "stt":
			return "listening only (PK wake on, no spoken replies)";
		case "combo":
			return "turn-based voice loop (listen + speak, not realtime)";
		case "realtime":
			return "realtime live conversation (Gemini Live agent via /v1/live)";
		default:
			return "voice layer off";
	}
}

/** Compact status-bar label; empty string hides the indicator. */
export function voiceModeStatusLabel(mode: VoiceMode, realtimeReady = true): string {
	if (mode === "off") return "";
	if (mode === "realtime") return realtimeReady ? "voice:realtime" : "voice:realtime (setup needed)";
	return `voice:${mode}`;
}
