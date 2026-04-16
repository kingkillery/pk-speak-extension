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
| `docs/VOICE_SESSION_BRIDGE.md` | Natural-language bridge for wake phrases and session targeting |
| `docs/SESSION_OPERATIONS.md` | Focused operator guide for `/sess`, wake aliases, and the `/sess ui` management pane |
| `index.ts` | Extension entrypoint, command registration, state management |
| `voice-routing.ts` | Normalized route matching, compact numeric route families, and conflict helpers |
| `session-routing.ts` | Session naming, alias helpers, summaries, removal helpers, and the `buildSessionDashboard` selector shared with the pane |
| `session-routing-store.ts` | Durable routing persistence |
| `session-events.ts` | Append-only voice/admin event log the management pane tails for toasts |
| `ui-launcher.ts` | Spawns `/sess ui` in a separate terminal (detached from pi-coding-agent) |
| `ui/admin.tsx` | Ink-based admin entry for the `/sess ui` management pane |
| `ui/components/Dashboard.tsx` | Renders the session-manager dashboard inside the pane |
| `ui/components/Toast.tsx` | Renders the voice/admin toast band at the bottom of the pane |
| `ui/components/ActionBar.tsx` | Renders the `[r] rename [a] alias [x] remove [q] quit` keybindings |
| `ui/actions.ts` | Pane-side write helpers for rename, alias, and two-step remove |
| `ui/hooks/useSessionStore.ts` | Pane polling hook + pure `pollTick` helpers |
| `ui/selectors.ts` | Pane read-side bridge over `buildSessionDashboard` |
| `voice-session-command.ts` | Natural spoken session-command parsing |
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
- **Short numeric routes**: Keep `one/1` and `two/2` as distinct voice families. `PK one` / `PK1` should stay separate from `PK two` / `PK2`, while multi-word names like `PK to Google` must stay literal.
- **Operator UX**: `/sess` should surface the compact-lane summary inline, `/sess slots` should show the explicit PK1/PK2 lane ownership view, and `/sess ui` should launch the Ink management pane in a separate terminal so it does not steal the pi-coding-agent TTY.
- **Pane write path**: All pane-driven mutations flow through `loadPersistedSessionRouting` → pure helper in `session-routing.ts` → `persistSessionRouting` → `appendSessionEvent(kind, "admin", payload)`. The extension watches the routing store mtime and reloads in-process state on external writes.
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
