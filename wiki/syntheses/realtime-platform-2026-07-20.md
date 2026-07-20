---
type: synthesis
title: "Realtime Platform Update — 2026-07-20"
description: "Committed July changes that establish the conversational realtime assistant, voice-mode controls, desktop client, compiled-OMPK bundle, and deterministic Gemini Live simulator."
resource: "git history 62dd2bd..8c0c38c"
tags: [realtime, voice, gemini-live, ompk, history]
timestamp: 2026-07-20
---

# Realtime Platform Update — 2026-07-20

## Scope

This update records committed work after the prior worktree verification (`62dd2bd`) through `8c0c38c`. It excludes the current uncommitted web-live/OpenAI-realtime worktree changes.

## Conversational-assistant boundary

The Gemini Live gateway was reframed as a conversational assistant that can inspect sessions, Agent Hub state, and workspace files, but stages mutations for explicit approval (`8f7bfe3`, `0075e7a`, `36c6d4c`, `444da10`).

- `launch_agent` and `archive_session` use the command-approval flow; ordinary read-only tools remain immediate.
- Workspace-file reads reject secret-shaped requested and resolved paths. The externally exposed Agent Hub facade is runtime-narrowed to read-only snapshot/detail methods.
- Opt-in `npm run test:realtime-live` drives the actual WebSocket tool-call dispatch and approval wiring, complementing pure-helper tests.

## Realtime experience

- `realtime-speech-brief.ts` shapes model-facing tool responses into bounded summaries and speech hints while preserving full raw payloads for the client (`c845f4e`).
- `/voice` now owns the mutually exclusive operator modes `off`, `tts`, `stt`, `combo`, and `realtime`; `combo` remains turn-based whereas `realtime` is full duplex (`e699650`).
- `desktop-live-client.ts` adds a local desktop Live client and updated PWA capture wiring (`ebee612`).
- `gemini-live-simulated.ts` supplies an explicit, deterministic, keyless Gemini Live simulator selected only by `PI_SPEAK_GEMINI_BACKEND=simulated`. It exercises echo/scenario replies, synthetic 24 kHz PCM, approvals, barge-in, and resumption in unit and integration coverage (`8c0c38c`).

## Distribution compatibility

The compiled Bun OMPK binary does not resolve an extension's external dependencies. `build:omp-bundle` therefore produces `dist/omp-index.js` with no bare runtime imports for OMPK, while upstream Pi continues to load `dist/index.js` (`22255aa`). The synced `pi-pk-speak` package declares compatible Pi/OMP extension manifests.

## Validation evidence

- `c845f4e`: full suite reported 424 passing tests.
- `8c0c38c`: simulator has both unit and no-module-mock gateway integration tests.
- Follow-on Live/orb/OpenAI-Realtime work is documented in [[Realtime Live HF Parity + Desktop Orb — 2026-07-20]].

## Source evidence

- `8f7bfe3` — conversational assistant and approval-gated mutations
- `0075e7a`, `36c6d4c`, `444da10` — approval/security hardening and end-to-end dispatch coverage
- `c845f4e` — speech result shaping
- `e699650` — unified voice mode
- `22255aa` — compiled-OMPK bundle
- `ebee612` — desktop Live client
- `8c0c38c` — simulated Gemini Live backend

## Related

- [[Realtime Live HF Parity + Desktop Orb — 2026-07-20]]
- [[wt-001 Conversational Assistant Pivot Assist (2026-07-14)]]
- [[pk-speak-extension Overview]]
