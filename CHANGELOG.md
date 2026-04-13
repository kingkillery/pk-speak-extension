# Changelog

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
