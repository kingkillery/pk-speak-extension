# AGENTS.md - pi-speak-pk Extension

Extension development context for `pi-speak-pk` — voice, wake-word, and remote-control extension for pi-coding-agent.

## Build

```bash
npm run build    # Compile TypeScript
npm test         # Run tests
```

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entrypoint, command registration, state management |
| `tts.ts` | Multi-provider TTS (edge, openai, elevenlabs, legacy) |
| `stt.ts` | Remote voice transcription |
| `phone-bridge.ts` | Telegram transport |
| `control-server.ts` | HTTP API + mobile web app server |
| `listener/listener.py` | Always-on wake-word listener (faster-whisper wake detection + transcription) |
| `web/remote/index.html` | Mobile web app |

## TTS Provider Logic

Auto-resolution order:
1. `legacy` — local speak11 (requires Python deps)
2. `elevenlabs` — requires `ELEVENLABS_API_KEY`
3. `openai` — requires `PI_SPEAK_OPENAI_KEY` (dedicated, not general LLM key)
4. `edge` — works immediately (bundled `node-edge-tts`)

## Important Patterns

- **API keys for audio**: Use dedicated keys (`PI_SPEAK_OPENAI_KEY`, `ELEVENLABS_API_KEY`) not the general LLM keys
- **Edge TTS**: Bundled via `node-edge-tts`, no external deps needed
- **Local voice (`/mono`)**: Requires Python stack with `faster-whisper`, `sounddevice`, `numpy`
- **Wake sensitivity**: Use `PI_SPEAK_WAKE_SENSITIVITY=low|medium|high` as the main operator control for how forgiving `PK` activation should be; use the lower-level fuzzy and compact env vars only as overrides
- **Remote audio**: Browser mic requires HTTPS origin (use Tailscale Serve or tunnel)

## Testing

```bash
npm test   # Non-local auth, rate limiting, body size, audio expiry, etc.
```

## Release

```bash
npm run prepublishOnly   # Builds before publish
npm publish              # Publishes to npm
```
