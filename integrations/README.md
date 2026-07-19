# pk-speak Integrations

This directory contains ready-to-use integration snippets for wiring `pk-speak` into three agent runtimes. Copy the relevant files into your config — nothing here auto-modifies anything.

## What this is

`pk-speak` is a CLI that speaks text aloud via the configured TTS provider:

```
pk-speak "build is green, all tests pass"
pk-speak --voice nova "deploy finished"
```

The MCP server (`dist/pk-speak-mcp.js`) wraps the CLI as an MCP tool so any MCP-compatible agent runtime can call it without shell access.

> **Pi users**: Pi already has `/speak` agent mode — you do not need the MCP server. The preamble snippets are still useful if you want the same spoken-reply behavior in a project CLAUDE.md or AGENTS.md file.

---

## Three runtimes

### 1. Claude Code (`integrations/claude-code/`)

| File | Purpose |
|------|---------|
| `CLAUDE.snippet.md` | Paste this block into a project `CLAUDE.md` or `~/.claude/CLAUDE.md` to always load the spoken-reply rules. |
| `print-preamble.mjs` | Optional SessionStart hook script — prints the preamble as a JSON hook payload so Claude Code injects it dynamically at session start. |
| `settings.hook.json` | Example `settings.json` fragment registering the SessionStart hook. **Adjust the absolute path before use.** |
| `mcp.json` | Example `.mcp.json` fragment registering the `pk-speak` MCP server. **Adjust the absolute path before use.** |

**Quickstart (static preamble, no hook):**
Paste the contents of `CLAUDE.snippet.md` directly into your `CLAUDE.md`.

**Quickstart (dynamic hook):**
1. Edit `settings.hook.json` so the `command` path matches your install.
2. Merge the fragment into your `~/.claude/settings.json` under `hooks`.
3. Edit `mcp.json` so the path in `args` matches your install.
4. Merge the fragment into your project `.mcp.json` or `~/.claude/mcp.json`.

---

### 2. Codex / oh-my-pi (`integrations/codex/`)

oh-my-pi uses the same `AGENTS.md` / markdown-config path as Codex.

| File | Purpose |
|------|---------|
| `AGENTS.snippet.md` | Paste this block into a project `AGENTS.md` or `~/.codex/AGENTS.md`. |
| `config.toml.snippet` | Add this TOML table to `~/.codex/config.toml` to register the MCP server. **Adjust the absolute path before use.** |

---

### 3. Guided installer (`integrations/install.mjs`)

```
node integrations/install.mjs
```

Prints the exact snippets and paths you need for each runtime based on the detected repo location. Does **not** edit any file automatically.

---

## Absolute paths

Every snippet that references a file path uses `<abs path>` as a placeholder. Run `node integrations/install.mjs` to get the correct paths printed for your machine, or substitute the repo root manually.

The compiled MCP server is always at `<repo root>/dist/pk-speak-mcp.js`.
The preamble hook script is at `<repo root>/integrations/claude-code/print-preamble.mjs`.
