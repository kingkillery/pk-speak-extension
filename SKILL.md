---
name: pi-speak
description: "Real-time voice output for Pi assistant replies via ElevenLabs. Use when the user wants to hear Pi speak, enable voice mode, or toggle speech output. Triggers on /speak, /mono, voice output, text-to-speech, or ElevenLabs."
---

# pi-speak-pk

Real-time voice extension for pi-coding-agent. Speaks assistant replies through ElevenLabs with a speech-optimized rewrite pass.

## Commands

| Command | Purpose |
|---------|---------|
| `/speak` | Enable speech mode |
| `/speak test` | Play a test phrase |
| `/speak stop` | Interrupt current playback |
| `/speak off` | Disable speech mode |
| `/speak status` | Show current state |
| `/mono` | Start always-on voice listener (Vosk + faster-whisper) |
| `/mono on\|off\|status` | Control the listener |
| `/sess` | Manage named sessions (new, switch, list, name) |

## How It Works

1. User submits text (typed or voice)
2. Pi generates the full assistant response
3. `speak11` rewrites the response for audio clarity via OpenRouter (`openai/gpt-oss-20b:nitro`)
4. Rewritten text is voiced through ElevenLabs API (default voice: `adam`)
5. Audio plays through speakers via MediaPlayer

## Voice Listener

`/mono` starts a background Python process that listens for the wake phrase "pi mono". Once activated, spoken input is transcribed (faster-whisper) and routed to Pi as user messages. The listener stays alive across session switches.

## Dependencies

- `speak11.py` / `speak11.cmd` — rewrite + TTS pipeline
- OpenRouter API key — for audio rewrite pass
- ElevenLabs API key — for voice synthesis
- Python 3.14+ with `numpy`, `sounddevice`, `vosk`, `faster_whisper` — for `/mono` listener
