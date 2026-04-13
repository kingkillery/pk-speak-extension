---
name: pi-speak
description: "Voice, wake-word, and remote-control extension for Pi. Use when the user wants spoken replies, the always-listening `pi mono` flow, Telegram phone access, the built-in mobile web app, or HTTP/Unified Remote control. Triggers on /speak, /mono, /phone, /remote, text-to-speech, voice input, or remote voice access."
---

# pi-speak-pk

Voice extension for `pi-coding-agent` with local wake-word input, multi-provider TTS, remote STT, Telegram transport, and a built-in mobile web app.

## Commands

- `/speak` - enable or configure spoken replies
- `/mono` - control the always-listening wake phrase flow
- `/phone` - run the Telegram bridge
- `/remote` - run the HTTP API and built-in web app
- `/sess` - manage named sessions for voice routing

## How It Works

1. User submits text or speech
2. Pi generates the full assistant response
3. Optional rewrite-for-speech makes the reply easier to hear
4. A TTS backend synthesizes the spoken version
5. Audio plays locally or is returned to a remote client

## TTS Providers

- `legacy` via `speak11`
- `edge` via `node-edge-tts`
- `openai`
- `elevenlabs`
- `auto`

Auto mode resolves in this order:

1. `legacy`
2. `elevenlabs`
3. `openai`
4. `edge`

## Voice Listener

`/mono` runs a background Python listener:

- Vosk handles the low-cost wake phrase detection
- `faster-whisper` handles actual utterance transcription
- the wake phrase is still `pi mono`
- the keep-alive timeout defaults to 15 seconds
- `pi mono <session-name>` can target a named session

## Remote Paths

### Telegram

`/phone` gives you remote text and voice-note turns through a Telegram bot.

### Mobile web app

`/remote` serves the built-in phone web app from `/app/`. Use this when you want browser mic capture plus browser audio playback.

### Unified Remote

The bundled Unified Remote remote is a control surface, not the main audio path.

## Important Files

- `index.ts`
- `tts.ts`
- `stt.ts`
- `phone-bridge.ts`
- `control-server.ts`
- `listener/listener.py`
- `web/remote/index.html`

## Setup Notes

- OpenRouter is only needed for rewrite-for-speech
- OpenAI is optional for TTS and optional for remote STT
- ElevenLabs is optional
- local `/mono` requires Python plus the listener dependencies
