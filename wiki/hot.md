---
type: meta
title: "Hot Cache"
updated: 2026-07-20T14:30:00-06:00
---

# Recent Context

## Last Updated 2026-07-20

## Key Recent Facts
- [[Realtime Live HF Parity + Desktop Orb — 2026-07-20]] documents the Live stack: desktop `/orb/`, HF worklets, OpenAI-Realtime adapter, web_search/camera tools, Android CameraX snapshot.
- [[Realtime Platform Update — 2026-07-20]] remains the prior platform baseline through `8c0c38c` (simulator, `/voice`, speech-brief, omp bundle).

## Recent Changes
- Terminal Live opens Edge `--app=/orb/` by default; full remote stays `/app/?mode=live`.
- `PI_SPEAK_LIVE_BACKEND=gemini|openai-realtime|hf` selects upstream; clients always use `/v1/live`.
- Live tools: `web_search` (Serper), `camera_snapshot` (client JPEG), shared `dispatchRealtimeToolCall`.

## Active Threads
- Docs: `docs/GETTING_STARTED.md` §8, `docs/ARCHITECTURE.md` Live subsystems, `AGENTS.md` key files, `CHANGELOG.md` Unreleased.
