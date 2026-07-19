import { existsSync } from "node:fs";
import { join } from "node:path";

const MAX_SPOKEN_SENTENCES = "one or two natural, spoken-style sentences";

function shellQuote(value: string, platform = process.platform): string {
	if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
	return `'${value.replace(/'/g, `"'"'`)}'`;
}

/**
 * The Pi extension is loaded from either a package root or its dist directory.
 * Resolve the bundled CLI rather than assuming the desktop pk-speak package is
 * globally installed or available on the agent's PATH.
 */
export function resolveBundledPkSpeakCli(extensionDir: string, exists: (path: string) => boolean = existsSync): string | undefined {
	const candidates = [
		join(extensionDir, "dist", "pk-speak.js"),
		join(extensionDir, "pk-speak.js"),
	];
	return candidates.find((candidate) => exists(candidate));
}

export function buildAgentSpeakCommand(
	extensionDir: string,
	nodeExecutable = process.execPath,
	exists: (path: string) => boolean = existsSync,
	platform = process.platform,
): string | undefined {
	const cliPath = resolveBundledPkSpeakCli(extensionDir, exists);
	if (!cliPath) return undefined;
	return `${shellQuote(nodeExecutable, platform)} ${shellQuote(cliPath, platform)} speak`;
}

export function buildAgentSpeechPreamble(command: string): string {
	return `Spoken-reply mode is active for this session.

When something is worth hearing out loud, END your turn by running this shell command exactly once:

${command} "<${MAX_SPOKEN_SENTENCES}>"

Rules for what you pass to the speech command:
- Speak only what actually matters to the user right now. If nothing is worth saying aloud, stay silent and do NOT call it at all.
- Keep it short and conversational, like a teammate talking.
- Plain spoken English only. No markdown, code blocks, command syntax, file paths, URLs, JSON, diffs, or logs. Translate those into plain words first.
- Do not narrate routine tool calls; summarize the outcome that the user cares about.

Your normal written reply still appears in the UI as usual. The speech call is only for the tight spoken headline, so keep it consistent with the written answer.`;
}
