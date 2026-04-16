# CLAUDE.md - pi-speak-pk

Use this file as a quick repo-local operating guide for voice and multi-session control work.

## Start Here For Natural Voice Control Work

When the task involves spoken replies, wake-word listening, voice session routing, the `/sess` session manager, session naming, wake aliases, or ready-session checks, read these first:

1. `docs/VOICE_SESSION_BRIDGE.md`
2. `docs/SESSION_OPERATIONS.md` for `/sess`, `/attn`, and multi-session operator flows
3. `docs/SESSION_MANAGER_SPEC.qmd` for the current manager-shape design
4. `README.md`
5. the relevant source file

`SKILL.md` is intentionally a pointer file.

## What This Repo Optimizes For

- natural spoken interaction
- command-backed control surfaces
- safe multi-session routing
- one primary session-manager abstraction for normal operators
- explicit operator commands when behavior must stay deterministic

## Core Command Families

- `/speak` → spoken replies
- `/mono` → wake-word listener
- `/sess` → session manager dashboard, naming, switching, edit wrapper, aliases, removal, export
- `/attn` → advanced ready-session broker controls
- `/phone` → Telegram remote
- `/remote` → browser remote and HTTP API

## Important Source Map

- `index.ts` → command registration and runtime orchestration
- `voice-session-command.ts` → natural spoken session and attention phrases
- `voice-routing.ts` → normalized target matching
- `session-routing.ts` → naming, aliases, dashboard formatting, and removal rules
- `session-routing-store.ts` → durable routing persistence
- `attention-broker.ts` → local multi-window coordination
- `listener/listener.py` → hot audio loop, wake phrase, transcription segmentation
- `README.md` → operator commands and examples

## Rules For Changes In This Area

If you add or change voice/session behavior:
- preserve natural-language phrasing and real slash-command behavior together
- prefer `/sess` as the main user-facing abstraction unless the task is explicitly about broker internals
- prefer extending extracted pure logic instead of burying new behavior inside `index.ts`
- update tests first or alongside the change when possible
- update all of:
  - `SKILL.md`
  - `docs/VOICE_SESSION_BRIDGE.md`
  - `docs/SESSION_OPERATIONS.md`
  - `AGENTS.md`
  - `CLAUDE.md`
  - `README.md` if user-visible behavior changed

## Validation

Run:

```bash
npm test
```

Prefer coverage in:
- `tests/voice-session-command.test.mjs`
- `tests/session-routing.test.mjs`
- `tests/session-routing-store.test.mjs`
- `tests/voice-routing.test.mjs`
- `tests/session-command-integration.test.mjs`
- `tests/attention-broker.test.mjs`
