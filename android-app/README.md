# Pi Speak Android App

This app is a remote client for a Pi Speak tray/gateway host. It should not hold Gemini, Vertex AI, or ElevenLabs credentials.

## Run Locally

Prerequisite: Android Studio or the checked-in Gradle wrapper.

```powershell
.\gradlew.bat assembleDebug
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

The app connects by scanning the `/setup` QR served by `pi-speak-tray` or `/pk-remote`. The host machine owns all provider credentials and can use Codex, ElevenLabs, or Vertex AI server-side.

## Control Surface (parity with the web remote)

- **Studio** — text turns, push-to-talk / toggle voice turns, live realtime voice (`/v1/live` with barge-in and terminal-approval cards), turn cancel, quick slash-command chips.
- **Agent Hub → HUB** — gateway session dashboard (`/v1/sessions`) with launch OMPK hub / Colab / join collab, per-lane route-turns-here, resume, focus/target, rename, wake alias, archive, and remove. A header toggle switches between OMPK lanes only (default) and all gateway sessions.
- **Agent Hub → Tasks** — the hierarchical Agent Hub portal (`/v1/herdr/agent*`): a lane → subagent tree with a per-lane chat composer, a live transcript stream (SSE `/v1/herdr/stream/:id`), a two-step archive control, and a general task launcher (`/v1/sessions/launch` with a free-form prompt/model/provider/cwd, not just the Hub/Colab presets). The e-ink (Boox) build offers the same launcher and per-lane chat/archive controls inline in its Hub peek, without the live stream (EPD refresh cost).
- **Agent Hub → OPS** — routing target picker (`/v1/route`), compact `PK1`/`PK2` route slots (`/v1/sessions/slots`), discovered running/recent agents (`/v1/agents`), and a live session-event feed (SSE `/v1/events`).
- **Agent Hub → HISTORY** — locally recorded turns with replay.
- **Commands** — gateway slash commands (`/v1/commands`) with one-tap example runs.
- **Discover** — mDNS/UDP gateway discovery plus the Warp / psmux control card (`/v1/warp*`).
- **Configure** — connection test, agent/model/workspace profile, workspace folder browser with read-only file viewer (`/v1/workspace`, `/v1/workspace/file`), audio/VAD hardware strategy.
