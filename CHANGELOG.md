# Changelog

## Unreleased

Ongoing listener and remote-UX work.

## 0.2.1

Listener reliability and activation-cue release.

Added:

- authenticated `/v1/diagnostics`
- in-memory remote turn queue with deterministic busy/backpressure behavior
- warm local STT worker process for remote voice uploads
- Telegram polling diagnostics and error tracking
- automated tests for HTTP auth/limits, queue behavior, Telegram link flow, and PWA token persistence
- Android native companion app scaffold with secure settings storage, route control, text turns, voice turns, and reply audio playback
- local mono activation cues with stronger `mono:listening` status output

Improved:

- remote auth now prefers header-based tokens for control and turn routes
- reply-audio fetch path now uses auth headers instead of query-token fallback by default
- PWA token handling now defaults to session-only storage with an explicit remember-device option
- remote request limits, rate limits, content-type validation, and timeout handling
- background cleanup for reply-audio artifacts
- listener child-process env scoping and listener event validation
- listener Vosk model resolution and cache fallback on Windows
- listener overflow handling now degrades gracefully with bounded queues and higher-latency capture defaults
- operator documentation for production remote use

## 0.2.0

Major upgrade from the original single-path speech extension to a broader voice and remote-control package.

Added:

- multi-provider TTS with `legacy`, `edge`, `openai`, `elevenlabs`, and `auto`
- optional rewrite-for-speech before synthesis
- Telegram phone bridge for text and voice-note turns
- remote STT with local `faster-whisper` or OpenAI
- built-in HTTP control server
- built-in mobile web app at `/app/`
- Unified Remote custom remote bundle
- better persisted runtime state for speak, mono, phone, and remote modes
- configurable `pi mono` keep-alive timeout

Improved:

- local and remote documentation
- security behavior for HTTP auth bypass
- audio artifact handling for remote replies

## 0.1.0

Initial published package.
