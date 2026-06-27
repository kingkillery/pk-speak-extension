# Voice Computer-Use Research (for pi-speak-pk voice session control)

Produced 2026-06-27 by the `VoiceControlResearch` agent (deep web research). This is the source material for Phase 3 of `SESSION_NAVIGATION_VOICE_PLAN.md`.

## TL;DR recommendation

**Boox/Android client (primary voice input device):** use **Gemini Live** (already wired in this repo) with `FunctionDeclarations` for the session-management actions. Near-zero dev effort, native Android mic (no HTTPS getUserMedia issue), built-in semantic VAD + barge-in. Model: `gemini-2.5-flash-native-audio-preview-12-2025` (verify GA name before production).

**Windows host (optional fast path):** **Vosk Grammar Mode** (Apache-2.0, 100% local, ~100-200ms) for the 6 discrete commands when a local/headset mic is attached. Always include `"[unk]"` in the grammar to drain noise.

**Open-ended prompt dictation (`send turn <text>`):** existing **faster-whisper** transcript -> a single **Gemini Flash function-call** (`temperature=0`, `max_tokens~60`, all schema fields `required`).

## Why this fits

- We already have Gemini Live, faster-whisper STT, wake word ("PK"), and the gateway HTTP surface. The recommendation reuses all of it.
- Two-tier: closed-vocab fast path (Vosk) for discrete ops; LLM function-calling for natural phrasing and arbitrary prompt content.

## FunctionDeclaration schema (maps to gateway endpoints)

- `list_sessions` -> `GET /v1/sessions`
- `switch_session { session_name }` -> set routing target (fuzzy match name -> id)
- `send_turn { content, session_name? }` -> `POST /v1/turn/text`
- `launch_agent { agent_type: omp|codex|claude, session_name? }` -> `POST /v1/sessions/launch`
- `archive_session { session_name, action: archive|recover }` -> `POST /v1/sessions/archive|recover` (Phase 2 endpoints)

Pass the current session list into the system prompt so the model matches real names instead of hallucinating.

## Key risks / gotchas (Boox e-ink + Tailscale)

- **HTTPS origin**: `getUserMedia` needs a secure context. Tailscale `*.ts.net` HTTPS works; plain HTTP -> `navigator.mediaDevices` undefined. Native Android `RECORD_AUDIO` bypasses this entirely (Gemini Live SDK path).
- **E-ink redraw stalls** the main thread 100-300ms; use `AudioWorklet` (not `ScriptProcessorNode`) for browser PCM capture, or the native SDK.
- **CPU throttling** when screen static can stall WebSocket audio; acquire `PARTIAL_WAKE_LOCK` + `WifiLock` in a native wrapper.
- **Echo**: TTS playback into an open mic; force `echoCancellation: true`, or gate mic during TTS.
- **"PK" false activations** (rhymes with speak/peak/pack); mute wake listener during TTS, require 2 consecutive high-confidence frames.
- **VAD premature fire**: with eagerness "low", an 800ms `silence_duration_ms` or push-to-talk avoids cutting off mid-command.

## Candidate ranking (summary)

1. faster-whisper -> LLM function-call (bespoke; most direct, hybrid local/cloud)
2. Gemini Live (already wired; best for Android client)
3. OpenAI Realtime (MCP passthrough option; cloud only)
4. Vosk Grammar (Apache-2.0; fastest local closed-vocab)
5. Talon Voice (Windows power-user overlay; no Android)
6. Dragonfly2 SAPI5 (Windows programmatic; mediocre accuracy)
7. Home Assistant Assist / Wyoming + Hassil (instructive pattern; Speech-to-Phrase <150ms)
8. VoiceMode / HumeAI voice-computer-use (reference CUA architectures)

Status flags: Serenade DISCONTINUED (community fork only); Willow founder deceased, self-host only; Gemini Live model name still `-preview-`.

Full report (with all source URLs) retained at the agent transcript and folded here. See `SESSION_NAVIGATION_VOICE_PLAN.md` Phase 3 for the integration scope.
