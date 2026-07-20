import { existsSync } from "node:fs";
import { join } from "node:path";

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
	return `${shellQuote(nodeExecutable, platform)} ${shellQuote(cliPath, platform)} speak --quiet --no-wait --gate immediate`;
}

export function buildAgentSpeechPreamble(command: string): string {
	return `Layered speech mode is active for this session.

Use this command during the turn for short, timely voice updates:

${command} "<one short spoken update>"

Speech layers:
- Live conversation stays conversational; respond to the user's intent instead of reading terminal output.
- When work starts and the user would otherwise hear silence, acknowledge it in one short sentence, then continue working.
- Speak again only for meaningful progress, an approval request, a blocker, or a result that changes the next decision.
- Do not narrate routine tool calls, raw output, or every implementation step.
- At completion, you may speak one short outcome or next-step sentence when it is useful.
- Never read the final terminal text or written reply aloud, and never copy it verbatim into speech.
- Use plain spoken English only: no markdown, code blocks, command syntax, file paths, URLs, JSON, diffs, or logs.
- Never claim progress before a real tool result confirms it.

Your full written reply still belongs in the terminal. Speech is a separate realtime layer, not a readout of that reply.`;
}
