# AGENT_SPEAK.md - Agent-Driven Speech with `pk-speak`

## Rationale

The classic `/speak on` mode works as an **outside watcher**: when an agent turn ends, the extension grabs the full assistant reply, optionally fires a second LLM call (`rewriteForSpeech`) to summarize it for audio, and then synthesizes the result. This is a good fit for remote and phone paths (Telegram, browser app, HTTP API) where the reply text is captured server-side and there is no shell available for the agent to invoke directly.

The **agent mode** (`/speak agent`) works differently: the agent itself decides what to say. When the agent wants the user to hear something, it ends its turn by running:

```
pk-speak "one or two natural, spoken-style sentences"
```

No second LLM pass. No watcher collecting the full reply. The agent writes speech-ready text already, so the sanitizer runs but the rewrite is off by default (lower latency, predictable output). If the agent says nothing worth hearing, it stays silent — no audio fires at all.

This model is **runtime-agnostic**. Pi, codex, and Claude Code all have a shell. The same `pk-speak` CLI command works in all three. The same preamble constant drives all three. A thin MCP server is a deferred fast-follow for runtimes that prefer tool-call integration over shell invocation.

**Classic `/speak on` is unchanged.** It remains the correct path for remote/phone turns where the reply text is captured outside the agent shell.

---

## PK_SPEAK_PREAMBLE

The constant exported from `speech-preamble.ts` is:

```
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
```

> **Important:** never pass raw user input or file contents as the pk-speak argument — write your own short summary in plain spoken English instead.

This text is self-contained. Codex, oh-my-pi, and Claude Code operators can paste it verbatim into their own config as described below. Pi injects it automatically when `/speak agent` is active.

Ready-to-paste integration snippets and MCP configs also live in `integrations/` in this repo.

---

## Wiring Instructions by Runtime

### Pi (automatic via `/speak agent`)

In a Pi session, enable agent-driven speech with:

```text
/speak agent
```

Pi injects `PK_SPEAK_PREAMBLE` into the system prompt automatically at `before_agent_start`. The `agent_end` auto-speak watcher is suppressed (the agent handles its own audio via the CLI). Classic `/speak on` continues to work for remote and phone turns.

Confirm the mode is active:

```text
/speak status
```

To return to classic watcher mode:

```text
/speak on
```

To turn speech off entirely:

```text
/speak off
```

### Codex

Paste the preamble into your project's `AGENTS.md` or into the Codex system config that is injected before agent turns. A minimal addition looks like:

```markdown
## Speech Output

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
```

Make sure `pk-speak` is installed and on the PATH in the environment where Codex runs (`npm i -g pi-speak-pk` or add the `dist/` bin path explicitly).

The exact text is available from the package constant:

```ts
import { PK_SPEAK_PREAMBLE } from "pi-speak-pk/dist/speech-preamble.js";
```

Or copy it directly from `speech-preamble.ts` in this repo. A ready-to-paste snippet is also in `integrations/codex/`.

For runtimes that prefer MCP tool-call integration over shell invocation, the optional `pk-speak-mcp` server can be wired via `~/.codex/config.toml`. See the "MCP Server (Optional)" section below.

### oh-my-pi

oh-my-pi reads `AGENTS.md` for context, so the wiring path is identical to Codex. Paste the preamble block into your project `AGENTS.md` under a `## Speech Output` heading. A ready-to-paste snippet is in `integrations/oh-my-pi/`.

For the MCP path, add the same `[mcp_servers.pk-speak]` stanza to `~/.codex/config.toml` that Codex uses — oh-my-pi shares that config.

Make sure `pk-speak` is on the PATH in the environment where oh-my-pi runs.

### Claude Code

Paste the preamble into either your project's `CLAUDE.md` or into a project skill. A minimal `CLAUDE.md` addition looks like:

```markdown
## Speech Output

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
```

Alternatively, create a Claude Code skill in `~/.claude/skills/<your-skill>/` that includes the preamble, so it can be activated on demand instead of being always-on.

A ready-to-paste snippet is also in `integrations/claude-code/`.

For the MCP path (clients where the Bash tool is restricted), wire `pk-speak-mcp` via `.mcp.json` or a SessionStart hook. See the "MCP Server (Optional)" section below and `integrations/claude-code/` for the exact config.

As with Codex, ensure `pk-speak` is on the PATH.

---

## `pk-speak` CLI Reference

The `pk-speak` CLI wraps the existing TTS pipeline (`synthesizeToFile`, which already runs the offline sanitizer) and plays via the shared `audio-playback` module.

### Usage

```
pk-speak [options] "text to speak"
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--voice <name>` | provider default | Override TTS voice. Sets the appropriate voice env var before loading the TTS module. |
| `--no-play` | — | Synthesize to file only; do not play audio. |
| `--no-wait` | — | Start playback and return immediately without waiting for the audio to finish. |
| `--output <path>` | temp `.mp3` in `os.tmpdir()` | Write synthesized audio to this path. |
| `--rewrite` | off | Enable the optional LLM rewrite-for-speech pass before synthesizing. Off by default because agent-generated text is already speech-ready. |
| `--help`, `-h` | — | Print usage and exit 0. |
| `--version`, `-v` | — | Print the package version and exit 0. |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Synthesis or playback error (one clean line printed to stderr) |
| `2` | Missing required text argument |

### Examples

```bash
# Speak immediately, block until done
pk-speak "Build complete. Three tests failed."

# Speak with a specific voice
pk-speak --voice en-US-GuyNeural "Done. Check the output."

# Generate file only, do not play
pk-speak --no-play --output /tmp/reply.mp3 "File saved."

# Start playback and return (non-blocking)
pk-speak --no-wait "Starting the build now."

# Force an LLM rewrite pass first
pk-speak --rewrite "$(cat long-summary.txt)"
```

### Voice Resolution

The `--voice` flag sets the appropriate provider environment variable before the TTS module loads, so it works regardless of which provider is active:

- `PI_SPEAK_SAG_VOICE`
- `PI_SPEAK_ELEVENLABS_VOICE_ID`
- `PI_SPEAK_OPENAI_VOICE`
- `PI_SPEAK_EDGE_VOICE`

Unknown voice names fall back to the provider default with a note on stderr.

---

## Source Map

| File | Purpose |
|------|---------|
| `speech-preamble.ts` | Exports `PK_SPEAK_PREAMBLE` — the shared instruction string injected into pi and pasted into codex/claude-code config |
| `pk-speak.ts` | CLI entry point; exports `parseArgs` (pure, tested) and `PkSpeakArgs` type |
| `audio-playback.ts` | Exports `getPlayerInvocation` (pure) and `playAudio` (cross-platform: PowerShell on win32, afplay on darwin, ffplay on linux) |
| `tts.ts` | Multi-provider synthesis; `synthesizeToFile` is the shared chokepoint used by both the extension and the CLI |
| `index.ts` | Extension wiring: `/speak agent` injects preamble at `before_agent_start`, suppresses `agent_end` auto-speak |

---

## MCP Server (Optional)

`pk-speak-mcp` is a thin stdio MCP server that shells out to the `pk-speak` CLI. It is for runtimes and clients that prefer tool-call integration over direct shell invocation — for example, a Claude Code session where Bash tool permission has not been granted, or a remote codex environment where spawning a shell is inconvenient.

### Why it shells out instead of re-implementing TTS

The CLI already handles voice-before-import env ordering, the offline sanitizer, temp-file cleanup, and cross-platform playback. Per-call voice override only works by spawning a fresh CLI process (because `DEFAULT_*` TTS constants are evaluated at module load). A thin adapter avoids duplicating all of that logic.

### What it exposes

One tool: `speak`

Input:

```json
{ "text": "string (required)", "voice": "string (optional)" }
```

On success it returns:

```json
{ "content": [{ "type": "text", "text": "Spoke." }] }
```

On non-zero exit from the CLI it returns an MCP error result. All diagnostics go to stderr; nothing is written to stdout except JSON-RPC.

### Install

After installing `pi-speak-pk` globally the `pk-speak-mcp` binary is available:

```bash
npm i -g pi-speak-pk
pk-speak-mcp   # starts the stdio server; wire it into an MCP client config
```

### Integration files

Ready-to-use integration configs live in `integrations/`. See that directory for:

- `claude-code/` — `CLAUDE.md` paste snippet and optional `.mcp.json` + SessionStart hook
- `codex/` — `AGENTS.md` paste snippet and `~/.codex/config.toml` `[mcp_servers.pk-speak]` stanza
- `oh-my-pi/` — `AGENTS.md` paste snippet (same path as codex; `oh-my-pi` reads `AGENTS.md` the same way)

Pi users do not need the MCP server. Use `/speak agent` in a Pi session instead.

### Wiring for Claude Code (MCP path)

Add the server to `.mcp.json` in your project root (or `~/.claude/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "pk-speak": {
      "command": "pk-speak-mcp",
      "args": []
    }
  }
}
```

Alternatively, add it as a SessionStart hook in `.claude/settings.json` so it starts automatically with every session.

Or skip the MCP server entirely and paste `PK_SPEAK_PREAMBLE` into `CLAUDE.md` — the shell-based path described above works whenever the Bash tool is available.

### Wiring for Codex and oh-my-pi (MCP path)

Both runtimes read `AGENTS.md` for context. Add the preamble paste from `integrations/codex/` or `integrations/oh-my-pi/` to your project `AGENTS.md`. Then wire the MCP server in `~/.codex/config.toml`:

```toml
[mcp_servers.pk-speak]
command = "pk-speak-mcp"
args = []
```

`oh-my-pi` uses the same `AGENTS.md` path and the same `config.toml` stanza as codex.

The shell-based path (`pk-speak "..."` inline) still works for both runtimes when the MCP tool-call path is not needed.
