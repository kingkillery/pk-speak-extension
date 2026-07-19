---
name: pk-speak
description: Use when a CLI agent should speak naturally with pk-speak, wrap a command with spoken lifecycle notices, start the phone gateway/tray, print Android setup QR codes, or explain the current realtime voice options. Keep normal replies concise and speak only useful status, questions, approvals, and completion summaries.
---

# pk-speak

Use `pk-speak` as the local voice layer for CLI agents.

## Fast Path

- Check setup: `pk-speak doctor`
- Speak a short status: `pk-speak speak "Build finished"`
- Speak piped text: `git status --short | pk-speak speak --provider edge`
- Generate audio without playback: `pk-speak speak --no-play --output reply.mp3 "Tests passed"`
- Wrap an agent or command: `pk-speak wrap -- codex`
- Wrap with a friendly label: `pk-speak wrap --label "Claude Code" -- claude`
- Start desktop tray and gateway: `pk-speak tray`
- Start headless gateway only: `pk-speak gateway`
- Print Android setup/download QR: `pk-speak mobile`
- Open session admin pane: `pk-speak admin`

Prefer `pk-speak speak` for one-off voice notices and `pk-speak wrap` when launching another CLI.

## Speak Naturally

Speak only what helps the user stay oriented:

- start/finish/failure notices
- approval requests
- short blockers
- concise summaries of completed work
- one clarifying question when needed

Do not read long logs, diffs, stack traces, or full command output aloud. Summarize them first, then speak the summary.

Good spoken style:

```text
Tests failed in the session routing suite. I found one assertion drift and I am fixing it now.
```

Bad spoken style:

```text
Reading the entire error output line by line...
```

## Providers

`pk-speak speak` supports the saved setup profile and provider overrides such as:

- `auto`
- `edge`
- `elevenlabs`
- `openai`
- `sag`
- `legacy`

Use `--dry-run` before speaking if you need to inspect the selected provider and text.

## Realtime Voice

This repo has Gemini Live realtime pieces, but use the turn-based path unless the user explicitly asks for realtime testing:

- Smoke test: `pi-speak-gemini-live-smoke`
- Gateway realtime path: `pk-speak gateway` with `AGENT_PROVIDER=gemini-live`
- WebSocket route: `/v1/live` in the local gateway

Realtime provider keys must stay server-side. Do not put Gemini, Vertex, OpenAI, or ElevenLabs keys in the Android/browser client.

## When More Context Is Needed

Read only the relevant reference:

- Old-agent bootstrap prompt: `references/bootstrap-prompt.md`
- Realtime notes and commands: `references/realtime.md`
- Full command docs: `README.md`
- Root extension pointer: `SKILL.md`
- Gateway source: `pk-speak.ts`, `headless-gateway.ts`, `realtime-gateway.ts`, `gemini-live-turn.ts`
