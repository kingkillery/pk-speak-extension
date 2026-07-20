---
type: synthesis
title: "Realtime Live HF Parity + Desktop Orb — 2026-07-20"
description: "HF realtime methodology on the Live client path, desktop orb outside the browser remote, OpenAI-Realtime/HF S2S upstream adapter, web_search/camera tools, and Android Live parity."
resource: "pi-speak-extension working tree 2026-07-20"
tags: [realtime, voice, gemini-live, openai-realtime, orb, android, hf]
timestamp: 2026-07-20
---

# Realtime Live HF Parity + Desktop Orb — 2026-07-20

## Intent

Bring [smolagents/hf-realtime-voice](https://huggingface.co/spaces/smolagents/hf-realtime-voice) methodology (worklets, barge-in clear, tools, camera) onto pi-speak's Live path **without** replacing the coding-agent control plane. Keep Gemini Live as the default upstream; allow OpenAI-Realtime-compatible S2S as a pluggable backend. Terminal operators get a **desktop orb** outside the full browser remote.

## Surfaces

| Surface | Path | Audience |
| --- | --- | --- |
| Desktop orb | `/orb/` | Terminal users (`/voice realtime` → Edge `--app`) |
| Full remote Live | `/app/?mode=live` | Phone browser / full ops |
| Android Live | native Live button | Standard + Boox APKs |
| Wire | `WS /v1/live` | All of the above |

## Client methodology (HF-style)

- `web/remote/live-capture-worklet.js` — ~40 ms Int16 @ 16 kHz, noise gate (dBFS), mute without teardown, level events
- `web/remote/live-playback-worklet.js` — ring buffer, `{kind:"clear"}` barge-in wipe, linear upsample
- Web remote + orb: client barge-in interrupt, camera frame on `camera_capture`, Settings noise-gate controls
- Orb UI: monochrome chrome + state-colored orb (listening / user-speaking / processing / ai-speaking)

## Gateway / tools

- `web_search` — Serper proxy (`SERPER_API_KEY` / `PI_SPEAK_SERPER_API_KEY`); `POST /v1/search`, `GET /v1/live/config`
- `camera_snapshot` — server asks client for one JPEG (`camera_capture` → `camera_frame`); Gemini gets media; OpenAI-Realtime gets `input_image`
- Shared `dispatchRealtimeToolCall` for Gemini and OpenAI-Realtime so coding-agent tools stay on both backends
- `audio_format` start announcement (24 kHz default)

## Upstream backends

| Env | Meaning |
| --- | --- |
| `PI_SPEAK_LIVE_BACKEND=gemini` (default) | Gemini Live (`@google/genai` live.connect) |
| `PI_SPEAK_LIVE_BACKEND=openai-realtime` / `hf` / `s2s` | OpenAI-Realtime GA wire via `openai-realtime-live.ts` |
| `PI_SPEAK_OPENAI_REALTIME_URL` or `SPEECH_TO_SPEECH_URL` | Upstream `wss://…/v1/realtime…` |
| `PI_SPEAK_GEMINI_BACKEND=simulated` | Keyless deterministic Gemini Live for CI |

Clients never talk to provider APIs directly — only `/v1/live`.

## Android

- `RealtimeVoiceSession`: `camera_capture`, `audio_format`, `sendCameraFrame`
- `CameraSnapshot.kt` — CameraX one-shot front JPEG
- `StreamingPcmPlayer.setSampleRate` for format announcements
- Standard + Boox listeners wired

## Operator cheatsheet

```text
/voice realtime          # orb + /v1/live
# optional search
SERPER_API_KEY=...
# optional HF/OpenAI upstream
PI_SPEAK_LIVE_BACKEND=hf
PI_SPEAK_OPENAI_REALTIME_URL=wss://...
```

## Related

- [[Realtime Platform Update — 2026-07-20]] — prior committed platform (simulator, `/voice`, speech-brief, omp bundle)
- Project docs: `docs/GETTING_STARTED.md` §8, `docs/ARCHITECTURE.md` Live subsystems, `CHANGELOG.md` Unreleased
