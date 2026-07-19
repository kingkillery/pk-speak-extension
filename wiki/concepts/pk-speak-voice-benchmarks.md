---
type: concept
title: "pk-speak Voice Pipeline Benchmarks and Boox Transcripts"
created: 2026-07-13
updated: 2026-07-13
tags: []
status: developing
related: []
sources:
  - pi-speak-extension commits 8d5193f..65ada83
---

# pk-speak voice pipeline: benchmarks, Google STT, hard-stop, Boox transcripts

Recent (2026-07-10..13) voice-pipeline work in pi-speak-extension.

## TTS/STT benchmark harness (`8d5193f`, `69c729f`)
- `scripts/benchmark-tts.ts` — provider latency measurement (`--text, --providers, --iterations, --output, --language-code, --dry-run`).
- `scripts/benchmark-stt.ts` — same for STT (`--audio-file, ...`).
- `stt.ts` `transcribeAudioBuffer` gained per-call fallback control so benchmarks can pin a single provider without silent fallbacks; provider timings kept strict.
- Tests: `tests/benchmark-cli.test.mjs`, `tests/stt-fallback.test.mjs`, `tests/tts-provider.test.mjs`. Docs: `docs/PK_SPEAK_CLI.md` benchmark section.

## Google Cloud STT provider (`af71e41`)
- Added in `stt.ts` (+271 lines) with extensive tests (`tests/google-stt.test.mjs`, 608 lines). Participates in the benchmark harness.

## Persistent voice hard-stop aliases (`c5bb93a`)
- `index.ts` / `pairing.ts`: persistent aliases to hard-stop voice sessions; covered by `tests/session-command-integration.test.mjs`.

## Boox e-ink cockpit + realtime transcripts (`90fc9d3`, `65ada83`)
- `BooxMainActivity.kt` redesigned as an e-ink cockpit (full rewrite of layout logic, ~370 lines changed).
- New `RealtimeTranscript.kt`: coalesces live transcript deltas (avoids per-token EPD redraws); `RealtimeVoiceSession.kt` rejects approvals over the realtime channel. Gateway side: `realtime-gateway.ts` / `realtime-types.ts` tweaks. Tests: `RealtimeTranscriptTest.kt`.

## Related
- [herdr-agent-hub-* Module](herdr-agent-hub-module.md) — the Agent Hub portal landed in the same window (PR #19).
