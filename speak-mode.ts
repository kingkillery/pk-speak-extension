// Pure speak-mode logic extracted from index.ts so it can be unit-tested in
// isolation (see repo CLAUDE.md: prefer extracting pure logic over burying new
// behavior inside index.ts). This module is also the back-compat home for
// normalizing older mode-less persisted state.

export type SpeakMode = "off" | "on" | "agent";

const SPEAK_MODES: readonly SpeakMode[] = ["off", "on", "agent"];

/**
 * Normalize a persisted (possibly partial / legacy) speak state into a concrete
 * SpeakMode.
 *
 * - If `saved.mode` is a known mode (off|on|agent), it wins.
 * - Otherwise fall back to the legacy `enabled` boolean: enabled -> "on",
 *   else "off".
 * - Undefined input -> "off".
 */
export function normalizeSpeakMode(
	saved: { mode?: SpeakMode; enabled?: boolean } | undefined,
): SpeakMode {
	const mode = saved?.mode;
	if (mode && SPEAK_MODES.includes(mode)) {
		return mode;
	}
	return saved?.enabled ? "on" : "off";
}

/**
 * Legacy `enabled` gate: speech is enabled whenever the mode is not "off"
 * (i.e. "on" or "agent").
 */
export function isSpeakEnabled(mode: SpeakMode): boolean {
	return mode !== "off";
}
