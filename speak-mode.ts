export type SpeakMode = "off" | "on" | "agent";

const KNOWN_MODES: Record<SpeakMode, true> = {
	off: true,
	on: true,
	agent: true,
};

/** Restores old persisted entries while making mode the canonical state. */
export function normalizeSpeakMode(saved: { mode?: unknown; enabled?: unknown } | undefined): SpeakMode {
	if (typeof saved?.mode === "string" && Object.hasOwn(KNOWN_MODES, saved.mode)) return saved.mode as SpeakMode;
	return saved?.enabled === true ? "on" : "off";
}

export function isSpeakEnabled(mode: SpeakMode): boolean {
	return mode !== "off";
}
