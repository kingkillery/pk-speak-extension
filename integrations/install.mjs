#!/usr/bin/env node
// install.mjs — guided, non-destructive pk-speak integration printer
//
// Detects the repo root from this script's own location, then prints the exact
// snippets and paths you should add for each runtime.
// Does NOT auto-edit any global user config file.
//
// Usage:
//   node integrations/install.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// This script lives at <repo>/integrations/install.mjs, so repo root is one up.
const repoRoot = resolve(__dirname, "..");
const distMcp = join(repoRoot, "dist", "pk-speak-mcp.js");
const hookScript = join(repoRoot, "integrations", "claude-code", "print-preamble.mjs");

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
const HR = "─".repeat(72);

function section(title) {
	process.stdout.write(`\n${HR}\n${title}\n${HR}\n`);
}

function note(text) {
	process.stdout.write(`\n  NOTE: ${text}\n`);
}

process.stdout.write(`
pk-speak integration guide
Detected repo root: ${repoRoot}

This script only PRINTS what to add. Nothing is edited automatically.
`);

// ---------------------------------------------------------------------------
// Warn if dist hasn't been built
// ---------------------------------------------------------------------------
if (!existsSync(distMcp)) {
	process.stdout.write(`
  WARNING: ${distMcp} does not exist.
  Run "npm run build" in the repo root before using the MCP server.
`);
}

// ---------------------------------------------------------------------------
// 1. Claude Code — static preamble (CLAUDE.md paste)
// ---------------------------------------------------------------------------
section("1. Claude Code — static preamble (paste into CLAUDE.md)");
process.stdout.write(`
Paste the following block into your project CLAUDE.md or ~/.claude/CLAUDE.md.
No tools, no hooks — always loaded.

--- BEGIN PASTE ---
Spoken-reply mode is active for this session.

When something is worth hearing out loud, END your turn by running this shell command exactly once:

pk-speak "<one or two natural, spoken-style sentences>"

Rules for what you pass to pk-speak:
- Speak only what actually matters to the user right now. If nothing is worth saying aloud, stay silent and do NOT call pk-speak at all.
- Keep it short and conversational, like a teammate talking — one or two sentences.
- Plain spoken English only. No markdown, no code blocks, no command syntax, and do not read file paths, URLs, JSON, diffs, or logs aloud. Translate those into plain words first.
- Do not narrate routine tool calls; summarize the outcome that the user cares about.
- Use --voice <name> only if the user explicitly asked for a specific voice; otherwise omit it and use the default.

Your normal written reply still appears in the UI as usual. The pk-speak call is only for the spoken version, so keep the two consistent but let the spoken line be the tight, headline version.
--- END PASTE ---
`);

// ---------------------------------------------------------------------------
// 2. Claude Code — SessionStart hook (optional, dynamic injection)
// ---------------------------------------------------------------------------
section("2. Claude Code — SessionStart hook (optional)");
process.stdout.write(`
Instead of a static CLAUDE.md paste, you can inject the preamble dynamically
at session start. Add the following to your ~/.claude/settings.json under "hooks":

--- BEGIN settings.json FRAGMENT ---
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${hookScript}"
          }
        ]
      }
    ]
  }
}
--- END FRAGMENT ---
`);
note("Merge this into your existing settings.json — do not replace the whole file.");

// ---------------------------------------------------------------------------
// 3. Claude Code — MCP server registration
// ---------------------------------------------------------------------------
section("3. Claude Code — MCP server (.mcp.json)");
process.stdout.write(`
Add the following to your project .mcp.json or ~/.claude/mcp.json:

--- BEGIN .mcp.json FRAGMENT ---
{
  "mcpServers": {
    "pk-speak": {
      "command": "node",
      "args": ["${distMcp}"]
    }
  }
}
--- END FRAGMENT ---
`);
note('The MCP server exposes a "speak" tool. Claude Code can call it in tool-use mode.');

// ---------------------------------------------------------------------------
// 4. Codex / oh-my-pi — AGENTS.md paste
// ---------------------------------------------------------------------------
section("4. Codex / oh-my-pi — static preamble (paste into AGENTS.md)");
process.stdout.write(`
Paste the following block into your project AGENTS.md or ~/.codex/AGENTS.md.
oh-my-pi uses the same path.

--- BEGIN PASTE ---
Spoken-reply mode is active for this session.

When something is worth hearing out loud, END your turn by running this shell command exactly once:

pk-speak "<one or two natural, spoken-style sentences>"

Rules for what you pass to pk-speak:
- Speak only what actually matters to the user right now. If nothing is worth saying aloud, stay silent and do NOT call pk-speak at all.
- Keep it short and conversational, like a teammate talking — one or two sentences.
- Plain spoken English only. No markdown, no code blocks, no command syntax, and do not read file paths, URLs, JSON, diffs, or logs aloud. Translate those into plain words first.
- Do not narrate routine tool calls; summarize the outcome that the user cares about.
- Use --voice <name> only if the user explicitly asked for a specific voice; otherwise omit it and use the default.

Your normal written reply still appears in the UI as usual. The pk-speak call is only for the spoken version, so keep the two consistent but let the spoken line be the tight, headline version.
--- END PASTE ---
`);

// ---------------------------------------------------------------------------
// 5. Codex — config.toml MCP registration
// ---------------------------------------------------------------------------
section("5. Codex — MCP server (config.toml)");
process.stdout.write(`
Add the following table to ~/.codex/config.toml:

--- BEGIN config.toml FRAGMENT ---
[mcp_servers.pk-speak]
command = "node"
args = ["${distMcp}"]
--- END FRAGMENT ---
`);
note("Merge this into your existing config.toml — do not replace the whole file.");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
section("Done");
process.stdout.write(`
Files referenced above:
  MCP server:   ${distMcp}
  Hook script:  ${hookScript}
  Snippet dir:  ${join(repoRoot, "integrations")}

Pi users: Pi already has /speak agent mode — you do not need the MCP server.
The preamble snippets (steps 1 and 4) are still useful for spoken-reply behavior
outside of Pi.

Nothing was written. Apply the snippets above manually.
`);
