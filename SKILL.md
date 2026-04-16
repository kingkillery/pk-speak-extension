---
name: pi-speak
description: "Pointer skill for pi-speak-pk. Use when the user wants spoken replies, wake-word listening, session-manager control, deterministic short voice routes like `PK one` / `PK1` vs `PK two` / `PK2`, Telegram control, or the browser remote. Start from the bridge doc and then jump to README and source as needed."
---

# pi-speak-pk

This is a pointer skill.

Start here when the user wants to talk naturally about:
- spoken replies
- the `PK` wake phrase
- the `/sess` session manager
- voice-driven session creation, switching, naming, aliasing, or removal
- deterministic short voice routes like `PK one` / `PK1` and `PK two` / `PK2`
- Telegram remote control
- the browser remote app

## First reads

Read these in order:
1. `docs/VOICE_SESSION_BRIDGE.md`
2. `docs/SESSION_OPERATIONS.md` when the task is mostly about `/sess`, wake aliases, or multi-session control
3. `README.md`
4. the relevant source file for the command family you need

## Use this skill as a bridge

The goal is to let the user speak naturally while grounding actions in real commands.

Examples of natural requests this skill should map cleanly:
- "make Pi speak"
- "start listening for PK"
- "show sessions"
- "create a bugfix session"
- "switch to research"
- "name this session active work"
- "make PK one and PK1 mean the same lane"
- "keep PK two distinct from PK to Google"
- "show me which session owns PK1 and PK2"
- "set wake alias one"
- "remove session bugfix"
- "which sessions are ready"
- "open the session manager pane"
- "turn on the browser remote"

## Main command families

- `/speak` → spoken replies and TTS settings
- `/mono` → local wake-word listener
- `/sess` → session manager dashboard, session naming, switching, edit wrapper, aliases, removal, export, and `/sess ui` to open the interactive Ink pane in a new terminal
- `/attn` → advanced multi-session ready-state broker controls
- `/phone` → Telegram bridge
- `/remote` → HTTP API and built-in mobile web app

## Deep references

Use the bridge doc to find the right source quickly:
- `docs/VOICE_SESSION_BRIDGE.md`
- `docs/SESSION_OPERATIONS.md`
- `docs/SESSION_MANAGER_SPEC.qmd`
- `README.md`
- `index.ts`
- `voice-session-command.ts`
- `voice-routing.ts`
- `session-routing.ts`
- `session-routing-store.ts`
- `attention-broker.ts`
- `listener/listener.py`

## Maintenance rule

If you add or change voice/session control behavior, update:
- `SKILL.md`
- `docs/VOICE_SESSION_BRIDGE.md`
- `docs/SESSION_OPERATIONS.md`
- `AGENTS.md`
- `CLAUDE.md`
- `README.md` when operator behavior changes
