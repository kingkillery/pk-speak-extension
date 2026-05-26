# Codebase Map

This map is for quick orientation before changing `pi-speak-pk`. It reflects the current remote-control architecture, including Pi/Codex provider parity, Telegram setup, Android machine profiles, and Bluetooth local-link support.

## Purpose

`pi-speak-pk` turns a Pi coding session into a voice and phone-controllable workstation. It provides local wake-word control, spoken replies, Telegram text/voice-note control, an HTTP remote API, a mobile web app, and a native Android companion app.

## Main Surfaces

### Desktop Extension Runtime

- `index.ts` is the extension entrypoint. It registers `/speak`, `/mono`, `/phone`, `/remote`, and `/sess`, owns persisted runtime state, chooses the active agent provider, starts the remote API, and routes phone/web turns.
- `control-server.ts` hosts `/app/`, exposes `/v1/status`, `/v1/diagnostics`, `/v1/route`, `/v1/turn/text`, `/v1/turn/voice`, and the `/v1/speak`, `/v1/mono`, and `/v1/phone` control routes.
- `remote-turn-manager.ts` serializes remote turns and returns deterministic busy/backpressure behavior.
- `agent-provider.ts`, `pi-agent-provider.ts`, and `codex-agent-provider.ts` abstract the active backend behind `AGENT_PROVIDER=pi|codex`.

### Phone And Remote Inputs

- `phone-bridge.ts` runs the Telegram polling bridge. Runtime setup can now be done with `/phone setup` and `/phone token <bot-token>`, while `PI_SPEAK_TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_TOKEN` still work as environment overrides.
- `web/remote/index.html` and `web/remote/app.js` implement the browser remote UI for text turns, voice uploads, token onboarding, target selection, and reply audio playback.
- `android-app/` contains the native Kotlin app. It stores machine profiles, remote tokens, optional launch paths, selected connection mode, target routing, and audio preferences.

### Voice And Session Routing

- `listener/listener.py` is the local always-on wake listener.
- `stt.ts` handles uploaded voice transcription and the warm local STT worker path.
- `tts.ts` resolves and runs TTS providers.
- `voice-routing.ts`, `voice-session-command.ts`, `session-routing.ts`, `session-routing-store.ts`, and `session-events.ts` implement spoken session targeting, aliases, compact PK1/PK2 routes, durable session state, and admin/pane event notifications.

### Admin UI

- `/sess ui` launches the Ink pane through `ui-launcher.ts`.
- `ui/admin.tsx`, `ui/components/`, `ui/actions.ts`, `ui/hooks/useSessionStore.ts`, and `ui/selectors.ts` render and mutate the session-management dashboard.

## Runtime Flow

### Remote Text Turn

1. Android, the browser app, Telegram, or another HTTP client sends text.
2. `control-server.ts` authenticates the request and parses `target`, `audio`, and optional `cwd`.
3. `index.ts` enqueues the turn through `remote-turn-manager.ts`.
4. `index.ts` optionally switches/routs to the requested named session.
5. The active provider handles the prompt:
   - Pi provider calls `pi.sendUserMessage()`.
   - Codex provider uses `codex app-server` with `codex exec --json` fallback.
6. The reply is returned as text and optionally rendered to audio through `tts.ts`.

### Remote Voice Turn

1. Android or the browser app uploads audio to `/v1/turn/voice`.
2. `control-server.ts` validates the content type and body size.
3. `stt.ts` transcribes the uploaded audio.
4. The transcript follows the same remote text-turn path.
5. The response can include `transcript`, `replyText`, `audioUrl`, timings, warnings, and provider metadata.

### Telegram Turn

1. `/phone setup` explains token setup; `/phone token <bot-token>` stores a bot token in persisted phone state and starts the bridge.
2. The operator pairs a chat with `/phone code` and `/link <code>`.
3. `phone-bridge.ts` polls Telegram updates and turns text or voice notes into remote turns.
4. Results are returned to the linked chat as text and, when available, generated audio.

## Agent Provider Parity

The phone, browser, and Android clients all talk to the same remote gateway. The provider is selected server-side:

```text
AGENT_PROVIDER=pi
AGENT_PROVIDER=codex
```

`/v1/status` now includes an `agent` block so clients can display the active provider. Codex turns default to approval policy `never` and sandbox `danger-full-access`, with `AGENT_APPROVAL_POLICY`, `CODEX_APPROVAL_POLICY`, `AGENT_SANDBOX`, and `CODEX_SANDBOX` available as overrides.
Remote-turn planning treats `PI_SPEAK_EXECUTION_ROUTER_MODE=auto|pi|codex` as the explicit router override. If that variable is unset, `AGENT_PROVIDER=pi|codex` selects the execution backend for Android, browser, and Telegram turns.

## Remote Auth And Setup

The shared HTTP gateway uses one token regardless of provider. The temporary default token is:

```text
P-K-Haxx1!
```

`PI_SPEAK_HTTP_TOKEN` overrides that default. The extension also normalizes old persisted generated tokens back to the default unless the environment override is set.

Setup helpers:

```text
/pk-remote
/remote setup
/remote setup bluetooth
/remote token
/remote tray on
```

`/pk-remote` is the shortest setup path: it starts the HTTP gateway if needed, detects the best reachable base URL (`PI_SPEAK_PUBLIC_BASE_URL`, Tailscale IPv4, then LAN IPv4), and prints a terminal QR for `/setup`. That setup page serves the Android APK download and the native `pi-speak://setup` connection link. `/remote setup` prints the same QR plus native/browser fallback URLs. `/remote setup bluetooth` and `/pk-remote bluetooth` print a Bluetooth local-link Android setup URL and mark the native profile with `connection_mode=bluetooth`. The npm-installed `pi-speak-tray` path runs the gateway as a tray-owned background service and exposes setup, status, settings, restart, and web remote actions from the tray menu.

## Android Connection Modes

The native app models connection mode explicitly:

- `Tailscale`: built-in Mac and MSI/appserver profiles.
- `Bluetooth`: paired Bluetooth networking/PAN local-link profile.
- `Manual`: custom URL; HTTPS is required outside debug loopback.

Important Android files:

- `android-app/app/src/main/java/com/pkkidking/pispeak/domain/model/Models.kt`: settings, machine profile, connection mode, validation.
- `android-app/app/src/main/java/com/pkkidking/pispeak/data/storage/SecureSettingsStore.kt`: encrypted settings and profile persistence.
- `android-app/app/src/main/java/com/pkkidking/pispeak/presentation/main/MainViewModel.kt`: setup-link handling, profile switching, validation, text/voice turns.
- `android-app/app/src/main/java/com/pkkidking/pispeak/presentation/settings/SettingsScreen.kt`: connection type selector and machine profile editor.
- `android-app/app/src/main/java/com/pkkidking/pispeak/presentation/main/MainScreen.kt`: conversation controls, machine selector, and connection status labels.

## Configuration

Common runtime variables:

```text
AGENT_PROVIDER=pi|codex|elevenlabs|gemini|gemini-live
CODEX_BIN=codex
AGENT_MODEL=<optional model>
PI_SPEAK_EXECUTION_ROUTER_MODE=auto|pi|codex
AGENT_CWD=<default launch directory>
PI_SPEAK_HTTP_TOKEN=<remote token override>
PI_SPEAK_PUBLIC_BASE_URL=<HTTPS/Tailscale/tunnel base URL>
PI_SPEAK_BLUETOOTH_BASE_URL=<Bluetooth adapter base URL>
PI_SPEAK_TELEGRAM_BOT_TOKEN=<Telegram bot token>
PI_SPEAK_GEMINI_BACKEND=vertex
PI_SPEAK_VERTEX_API_KEY=<optional Vertex AI API key>
GOOGLE_CLOUD_PROJECT=<Vertex AI project>
GOOGLE_CLOUD_LOCATION=<Vertex AI location>
ELEVENLABS_API_KEY=<server-side ElevenLabs key>
```

Android clients should not call AI Studio or hold Gemini API keys. They send text/voice turns to the tray/gateway, which can use ElevenLabs and Vertex AI server-side.

## Validation Commands

```text
npm test
cd android-app
.\gradlew.bat testDebugUnitTest
```

Remote validation runbooks:

- `docs/REMOTE_OPERATING_GUIDE.md`
- `docs/REMOTE_VALIDATION_CHECKLIST.md`
- `docs/REMOTE_VALIDATION_RUN_SHEET.md`

## Open Questions

- [VERIFY] Confirm the actual Bluetooth PAN IP assigned by the Windows host and Boox Palma. The default generated URL is `http://192.168.44.1:8767/`, but `PI_SPEAK_BLUETOOTH_BASE_URL` should be set if the adapter uses another address.
