#!/usr/bin/env node
// print-preamble.mjs
//
// Optional Claude Code SessionStart hook.
// Imports PK_SPEAK_PREAMBLE from the built speech-preamble module and prints
// the JSON hook payload that Claude Code expects for a SessionStart hook:
//
//   { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": <preamble> } }
//
// Usage (from repo root):
//   node integrations/claude-code/print-preamble.mjs
//
// Or register it in settings.json as a SessionStart hook (see settings.hook.json).
// The script is dependency-free beyond the built dist/ output of this repo.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the built speech-preamble module relative to this script:
//   integrations/claude-code/ -> ../.. -> repo root -> dist/speech-preamble.js
const preambleModulePath = resolve(__dirname, "../../dist/speech-preamble.js");

let PK_SPEAK_PREAMBLE;
try {
	// Dynamic import so we get a clear error if dist/ hasn't been built yet.
	// Convert the absolute path to a file:// URL — Node's dynamic import()
	// rejects raw Windows paths (e.g. C:\...) with ERR_UNSUPPORTED_ESM_URL_SCHEME.
	const mod = await import(pathToFileURL(preambleModulePath).href);
	PK_SPEAK_PREAMBLE = mod.PK_SPEAK_PREAMBLE;
} catch (err) {
	process.stderr.write(
		`print-preamble: could not import ${preambleModulePath}\n` +
		`  Run "npm run build" in the pi-speak-extension repo first.\n` +
		`  Error: ${err.message}\n`
	);
	process.exit(1);
}

const payload = {
	hookSpecificOutput: {
		hookEventName: "SessionStart",
		additionalContext: PK_SPEAK_PREAMBLE,
	},
};

process.stdout.write(JSON.stringify(payload) + "\n");
