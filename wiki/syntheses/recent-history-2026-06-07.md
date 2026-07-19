---
type: synthesis
title: "pi-speak extension recent history — 2026-06 through 2026-07"
description: "Complete recent arc from realtime voice foundations through OMP session routing, Android parity, Agent Hub, benchmarks, and Boox cockpit work."
resource: "pi-speak-extension git history 81f2c88..5199341"
timestamp: 2026-07-13T00:17:07-06:00
tags: [pi-speak, history, voice, android, realtime, agent-hub]
status: current
---

# pi-speak extension recent history

Existing concept/session pages cover focused slices. This synthesis fills the June gap and connects the July pages to the committed source history.

## June 1–6: voice, packaging, and realtime foundations

- Gateway sessions, stored resume, execution-router voice turns, optional S.A.G. TTS, deterministic speech sanitization, and Vertex Gemini Live ADC/backend fixes landed (`81f2c88`, `0731f36`, `8450c45`, `e9cc01d`, `c94cd8f`, `c645ec2`).
- The provider surface expanded with Claude routing, installed-package setup, package splitting/redacted docs, pk-speak CLI commands (`speak`, `wrap`, capture mode), provider registry/factory, and 0.2.7/0.2.10/0.2.11 releases (`fa82400`, `b373e18`, `68c5ba0`, `d7286af`, `0024907`, `c348efd`, `611a354`, `6b149c4`, `9999d66`, `7f6c98f`).
- The dependency audit removed the recorded protobufjs/ws vulnerabilities (`a7ae5ae`), while runtime test state was ignored (`0219c9e`) and the repository rebrand moved to pk-speak (`a3c1ea4`).
- Android connection reliability and ADB reverse recovery were hardened. The realtime stack was then built in four lanes: shared types/upgrader, Android streaming client/audio playback, server Gemini Live gateway, and integration evidence (`5d682de`, `21bcc84`, `0c088fa`, `5169f1a`, `5551a41`, `5c3843c`, `3652477`).
- Gradio audio TTS and realtime terminal approvals were added on desktop and Android (`824f8bd`, `04117df`, `3d4b4e4`).

## June 26–27: Boox, OMP resume routing, and live voice

- Boox gateway launch work added Tailscale reachability fixes, OMP session selection, project/recent-session pickers, QR setup scanning, per-client selection, path validation, explicit failure clearing, and consistent extension flags (`bd81e42`, `73f0991`, `811ffad`, `1f2f9f7`, `ed4afd1`, `4a0ec32`, `9f20a4e`, `24dd748`, `e9fb470`).
- Collab relay, supervisor scripts, realtime turn handling, Agent Hub/discovery, session navigation, voice-command extensions, setup QR, and remote web updates landed in the same integration wave (`ed4afd1`).
- Gemini Live tool calls became non-blocking for long-running terminal/agent work, with progress narration, session resumption, reconnect handling, and queued responses (`c8ca8eb`).
- Gated playback and doctor precedence were added, CI verification was made deterministic, and speech sanitization stopped mangling snake_case identifiers (`453bbf5`, `c177d99`, `0b9da1e`, `026045b`, `c5088ce`).
- Session-event tails switched from trim-invalid line cursors to monotonic sequence cursors, and weak-defer routing now preserves real confidence (`8ed7a06`).
- Gemini Live became the voice bridge for oh-my-pi, with tool dispatch and Boox UX/permission/timeout fixes; true realtime Boox PCM streaming followed (`3fbf997`, `1ba994d`, `89ea789`, `4d2d927`).

## June 28–July 2: product surfaces and Android parity

- Brainstorm mode and on-demand WhisperX GPU transcription were added (`49381ad`).
- Android gateway controls reached web-remote parity: Agent Hub OPS, route/slot selection, agent discovery, session rename/alias/archive, SSE event tailing, workspace file review, pure parsers, and tests (`26f4073`, `4f1f84a`, `4c45771`, `35fed0a`).
- The Android app adopted the oh-my-pk harness naming and Gemini 3-series defaults (`0d23c18`, `8b135fd`). Herdr gateway controls and the actionable Agent Hub portal then landed (`6aae1ed`, `034680b`, `218ed8a`).
- Android composables were split and the idle state simplified into the quieter connected-to-computer design documented in the existing pages (`4bbb3ea`, `42e6d8e`, `fa9bc3c`).

## July 7–13: safety, CLI, benchmarks, and e-ink cockpit

- The config-driven wiki vault resolver, `--summarize`, audio-input transcription, and Minimax TTS were added (`6884b9f`, `52852ba`).
- Command injection, Telegram pairing brute force, gateway turn concurrency, fire-and-forget rejection handling, and traversal errors were fixed; a follow-up closed remaining shell-spawn sites and lockout-reset bugs (`b33a203`).
- `/pk-speak stop`, CLI `--dry-run`/`--version`, reference docs, strict TTS/STT benchmark harnesses, Google Cloud STT, and persistent voice hard-stop aliases landed (`d445655`, `07cc4f5`, `8d5193f`, `69c729f`, `af71e41`, `c5bb93a`).
- The Agent Hub portal became actionable for both standard and e-ink Android, with per-lane chat/archive and a general task launcher; revive remains intentionally absent from the UI (`819f6a2`).
- The Boox cockpit was redesigned, live transcript deltas were coalesced to avoid excessive EPD redraws, and realtime approvals were rejected on the live channel (`90fc9d3`, `65ada83`). Local agent artifacts were then ignored (`5199341`).

## Current state

- Latest committed state: `5199341`.
- The existing focused pages are [voice benchmarks](../concepts/pk-speak-voice-benchmarks.md), [Agent Hub](../concepts/herdr-agent-hub-module.md), and [Android parity](../sessions/2026-07-02-pr13-android-gateway-parity.md).
- This history describes committed changes only; the checkout also has wiki/script edits from the current maintenance work, which remain visible in `git status` and are not silently folded into the source history.
