# pk-speak

Voice, wake-word, and remote-control extensions for Pi / `pi-mono`.

This package turns Pi into a usable voice workstation, not just a text assistant with TTS bolted on. It gives you:

- spoken assistant replies with multiple TTS backends
- the always-listening `PK` wake phrase flow
- Telegram text and voice turns from your phone
- a local HTTP control API
- a built-in mobile web app at `/app/`
- a Unified Remote control surface

## What To Use

If you just want the shortest path:

1. Local desktop voice: use `/speak on`
2. Hands-free on the same machine: use `/mono on`
3. Remote from your phone with the least friction: use `/phone on`
4. Remote from your phone with QR setup: use `/pk-remote`, then scan the QR from the Android phone
5. Remote button grid on Android: use the bundled Unified Remote remote

## Install

Install the Pi extension package inside Pi:

```text
pi npm i pi-pk-speak
```

Reload Pi after install.

For the standalone desktop/phone bootstrap package, install or run `pk-speak` from npm, then run:

```text
pi-speak-pk
```

That opens the first-time setup CLI. It chooses the coding backend (`codex`, `claude`, or `pi`), configures the voice/TTS provider, creates the gateway pairing token, and asks whether to include Android setup. After that, use:

```text
pk-speak doctor
pk-speak speak "Build finished"
pk-speak wrap -- codex
pk-speak tray
pk-speak mobile
```

`pk-speak speak` is the direct sag-like TTS command for hooks and CLI agents. `pk-speak wrap` runs any CLI command and speaks start/finish notices without requiring the phone gateway. `pk-speak tray` starts the Windows tray plus gateway. `pk-speak gateway` starts the headless gateway directly. `pk-speak mobile` prints the Android download/setup QR.

Package split details are in [docs/PACKAGE_SPLIT.md](./docs/PACKAGE_SPLIT.md).

## Quick Start

### 1. Make Pi Speak Locally

```text
/speak on
/speak test
/speak status
```

If you do nothing else, `auto` provider selection will try available backends in this order:

1. `legacy` via `speak11`
2. `elevenlabs`
3. `openai`
4. `edge`

If an earlier auto-selected backend fails at synthesis time, Pi now falls through to the next available provider instead of stopping on the first failure.

### 2. Enable The Always-Listening Wake Phrase

```text
/mono on
```

Say:

```text
PK
```

Pi will open a short voice-input window, play a short listening cue, and update the mono status so you can tell it is actively listening. Say `PK` again within the timeout to keep it alive. Default keep-alive is 15 seconds.

Wake matching now has a sensitivity preset. Use `PI_SPEAK_WAKE_SENSITIVITY=low|medium|high` to make activation stricter or more forgiving. `medium` is the default.

### 3. Remote In From Your Phone With Telegram

```text
/phone setup
/phone token <bot-token>
/phone on
/phone code
```

Then in Telegram:

1. Open your bot
2. Send `/link <code>`
3. Send text or voice notes to Pi

This is the easiest remote path. It works well when you want reliability more than low latency.

`/phone setup` prints the running-session setup steps. If the token is not already in the environment, paste it with `/phone token <bot-token>`; the extension saves it, starts the bridge, and prints the `/link` code. `PI_SPEAK_TELEGRAM_BOT_TOKEN` can still point to an existing bot you already control.

### 4. Remote In From Your Phone With The Built-In Web App

```text
/pk-remote
/remote setup
/remote setup bluetooth
```

`/pk-remote` is the shortest path. It starts the remote API if needed, chooses a setup URL in this order, and prints a QR code for the phone setup page:

1. `PI_SPEAK_PUBLIC_BASE_URL`
2. detected Tailscale IPv4 address
3. detected local LAN IPv4 address
4. configured fallback

Scan the QR from the Android phone to open the setup page. From there you can download the bundled APK, open the native `pi-speak://setup` link, and save the machine URL, token, profile name, connection mode, and Codex route metadata. If you want the browser app instead, open one of the printed browser URLs:

```text
http://localhost:8767/app/
https://<tailnet-host>/app/
https://<tunnel-domain>/app/
```

The web app:

- records your microphone in the browser
- sends audio to `/v1/turn/voice`
- shows the transcript
- plays the returned reply audio
- stores the remote token in the current browser session by default
- can explicitly remember the token on that device if you enable it in Settings

The web app also has a **Workspace** tab for reviewing files and choosing where the agent runs:

- browse the directory tree from the workspace root, stepping into folders and back up to the parent
- tap a file to view its contents in a read-only viewer (preview is capped at the first 512 KB of large files, and binary files show a notice instead of bytes)
- tap **Use this folder** to set the agent working directory, which becomes the launch path / `cwd` sent with text and voice turns

By default the Workspace tab is rooted at the agent working directory (so the file viewer can't read files elsewhere on the machine). Set `PI_SPEAK_WORKSPACE_ROOT` on the gateway to widen or relocate that root — point it at a specific directory, or set it to `fs` to browse the whole drive/filesystem. The browser is confined to that root; paths outside it (and symlinks resolving outside it) are rejected.

`/remote setup` prints the same QR and links as `/pk-remote`. Use `/remote setup bluetooth` or `/pk-remote bluetooth` when the phone is paired over Bluetooth networking/PAN.

For real phone use, prefer an HTTPS URL through Tailscale Serve or a tunnel. If the phone is paired over Bluetooth networking/PAN instead, use `/remote setup bluetooth`; the Android app treats that as a Bluetooth local-link profile and does not require Tailscale.

When the active gateway is reachable over Tailscale, Android prefers advertised `100.64.0.0/10` base URLs and exposes a Warp / psmux control card in Discovery. That card calls `/v1/warp` to list open psmux sessions, tabs, and panes, `/v1/warp/tab` to open a native Warp tab via `warp://action/new_tab?path=...`, `/v1/warp/tab-config` to open a saved Warp Tab Config via `warp://tab_config/<name>`, and can create a detached psmux session or tab from the phone. Set `PI_SPEAK_WARP_REMOTE_BASE_URL` on the gateway to show the deployed Warp remote-control relay URL in the Android card.

Optional Windows tray:

```text
/remote tray on
```

Right-click the tray icon and choose `Show setup QR code`. Scanning the QR opens the Android app with this computer's Tailscale endpoint, token, and saved machine profile metadata. Set `PI_SPEAK_TRAY=1` to start the tray automatically with `/remote on`.

NPM-installed tray/service path:

```text
npx -p pk-speak pi-speak-tray
```

Or, after global install:

```text
pi-speak-tray --install-startup
```

The tray keeps the headless gateway running in the background, restarts it if it exits, and exposes setup, APK download, status, settings, restart, and web remote actions from the tray menu.

### Speak From Any CLI

Use `pk-speak speak` when you want any command, hook, or coding agent to talk without starting the full phone gateway:

```text
pk-speak speak "Tests passed"
git status --short | pk-speak speak --provider edge
pk-speak speak --provider sag "I need approval on this command."
pk-speak speak --no-play --output reply.mp3 "Saved an audio artifact."
```

It reads text from arguments or stdin, uses the saved setup profile, and supports `auto`, `edge`, `elevenlabs`, `openai`, `sag`, and `legacy` providers. Use `--dry-run` to inspect what would be spoken without synthesizing audio.

### Wrap Any CLI Agent

Use `pk-speak wrap` when you want lifecycle voice notices around an arbitrary coding-agent CLI:

```text
pk-speak wrap -- codex
pk-speak wrap --label "Claude Code" -- claude
pk-speak wrap --provider sag -- npm test
pk-speak wrap --capture -- npm test
pk-speak wrap --no-speak -- node -e "console.log('ok')"
```

The wrapper preserves the child command's terminal and exit code. It speaks the start and finish/failure notices around the command instead of capturing and parsing all output, so interactive CLIs keep their normal TTY behavior. Use `--shell` only when you intentionally need shell syntax or shell built-ins.

Use `--capture` for non-interactive commands when you want `pk-speak` to mirror output and classify important events. Capture mode prints and speaks compact notices for patterns such as approval prompts, input prompts, test failures, and errors. Keep capture off for fully interactive CLIs unless you are comfortable with stdout/stderr being piped instead of attached directly to the terminal.

### Gemini Live Smoke Test

Use this before wiring a real-time session into the phone UI:

```text
set PI_SPEAK_GEMINI_BACKEND=vertex
set PI_SPEAK_VERTEX_API_KEY=<optional-vertex-api-key>
set GOOGLE_CLOUD_PROJECT=<your-gcloud-project>
set GOOGLE_CLOUD_LOCATION=us-central1
gcloud auth application-default login
pi-speak-gemini-live-smoke --model gemini-2.5-flash-native-audio-preview-12-2025 --modality audio
```

To run the tray/headless gateway through ElevenLabs voice, backed by Vertex AI Gemini text reasoning:

```text
REM Set ELEVENLABS_API_KEY in your shell before launch
set PI_SPEAK_GEMINI_BACKEND=vertex
set PI_SPEAK_VERTEX_API_KEY=<optional-vertex-api-key>
set GOOGLE_CLOUD_PROJECT=<your-gcloud-project>
set GOOGLE_CLOUD_LOCATION=us-central1
gcloud auth application-default login
set AGENT_PROVIDER=elevenlabs
pi-speak-gateway
```

This is the recommended high-quality voice stack. It uses ElevenLabs for reply audio and Vertex AI for Gemini reasoning so Google Cloud billing/credits apply through your Cloud project. Set `REDACTED_ELEVENLABS_HISTORY_LINE` when quality matters more than credit use.

To run the tray/headless gateway through Gemini Live instead:

```text
set AGENT_PROVIDER=gemini-live
set PI_SPEAK_GEMINI_BACKEND=vertex
set GOOGLE_CLOUD_PROJECT=<your-gcloud-project>
set GOOGLE_CLOUD_LOCATION=us-central1
set PI_SPEAK_GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
pi-speak-gateway
```

Optional environment:

- `PI_SPEAK_GEMINI_BACKEND=vertex|developer-api` selects Vertex AI or direct Gemini Developer API
- `PI_SPEAK_VERTEX_API_KEY` uses a Vertex AI API key instead of Application Default Credentials
- `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` configure Vertex AI
- `PI_SPEAK_GEMINI_LIVE_MODEL` selects the Live model
- `PI_SPEAK_GEMINI_LIVE_MODALITY=audio|text` selects response mode
- `PI_SPEAK_GEMINI_API_VERSION=v1beta|v1alpha` selects the Gemini API version
- `PI_SPEAK_ELEVENLABS_MODEL_ID` selects the ElevenLabs speech model
- `PI_SPEAK_ELEVENLABS_VOICE_ID` selects the ElevenLabs voice

Keep Gemini, Vertex, and ElevenLabs credentials server-side. Do not put them in the Android app or browser app.

## Main Commands

### `/speak`

Turns spoken replies on, off, or changes the backend.

Common examples:

```text
/speak on
/speak off
/speak stop
/speak status
/speak test
/speak providers
/speak provider edge
/speak provider openai
/speak provider elevenlabs
/speak rewrite on
/speak rewrite off
```

Behavior:

- Pi still keeps the full on-screen response
- the spoken version can optionally be rewritten for audio clarity
- `/speak stop` interrupts playback without disabling speech mode

### `/mono`

Controls the wake-word listener.

```text
/mono on
/mono off
/mono status
```

Behavior:

- waits for the wake phrase `PK` by default
- activates voice input for a short window
- keeps the existing `/mono` flow intact with a faster-whisper wake detector
- supports `PK <session-name>` to route into a named session when the target name is spoken clearly
- keeps short numeric routes deterministic:
  - `PK one`, `PK 1`, and `PK1` belong to the same `1` family
  - `PK two`, `PK 2`, and `PK2` belong to the same `2` family
  - `1` stays distinct from `2`
  - multi-word names like `PK to Google` stay literal and are not coerced into `2`

### `/phone`

Controls the Telegram bridge.

```text
/phone on
/phone off
/phone status
/phone setup
/phone token <bot-token>
/phone code
/phone unpair
```

Behavior:

- text messages become Pi turns
- voice notes are transcribed, then sent to Pi
- replies can be delivered as text plus generated audio

### `/remote`

Controls the HTTP API and mobile web app.

```text
/remote on
/remote off
/remote status
/remote token
/remote setup
/remote setup bluetooth
/remote tray on
/remote tray off
/remote tray status
```

Behavior:

- starts the HTTP server
- serves the mobile app from `/app/`
- serves the phone setup page from `/setup`
- serves the bundled Android APK from `/download/pi-speak.apk`
- exposes remote-control endpoints
- generates a token if one is not already configured
- prints one-step setup URLs for the browser app and native Android app

### `/sess`

Named sessions, wake aliases, and routing summaries for voice control.

```text
/sess
/sess new bugfix
/sess switch bugfix
/sess name active-work
/sess rename bugfix voice-bugfix
/sess wake one
/sess wake clear one
/sess alias add bugfix one
/sess alias remove one
/sess edit bugfix
/sess remove bugfix
/sess confirm remove bugfix
/sess slots
/sess export
/sess ui
/sess ui open
```

This matters because `PK bugfix` can route voice input to that named session, while compact routes like `PK one` / `PK1` and `PK two` / `PK2` can stay stable and distinct.

`/sess` with no args shows the current session, ready sessions, aliases, store path, a compact `1` vs `2` lane summary, and inline state for known sessions.

Use `/sess slots` when you want the explicit compact-route view for `PK one` / `PK1` and `PK two` / `PK2`.

Use `/sess ui` for inline guidance without opening another terminal. Use `/sess ui open` only when you explicitly want the older terminal pane; repeat launches reuse the existing pane instead of creating more terminal windows. The pane mirrors the `/sess` dashboard, refreshes within one second of external mutations, supports focus movement with arrow keys, `tab`, or `j` / `k`, shows the compact PK1/PK2 route lanes plus a focused-session footer, and adds keybindings `[r] rename`, `[a] alias`, `[x] remove`, and `[q] quit`.

For operator details, see:
- `docs/VOICE_SESSION_BRIDGE.md`
- `docs/SESSION_OPERATIONS.md`
- `docs/CODEBASE_MAP.md`

## Architecture

There are six main subsystems:

1. `index.ts`
   The extension entrypoint. Registers commands, persists state, owns wake-word routing, and coordinates TTS, STT, Telegram, and HTTP control.

2. `tts.ts`
   Multi-provider speech synthesis. Supports `legacy`, `edge`, `openai`, `elevenlabs`, and `auto`.

3. `stt.ts` and `listener/stt_worker.py`
   Remote voice transcription for uploaded audio. `auto` prefers OpenAI when an API key is present, otherwise a warm local `faster-whisper` worker process.

4. `listener/listener.py`
   The always-on two-tier listener:
   - Tier 1: `faster-whisper` tiny for wake-phrase detection
   - Tier 2: `faster-whisper` for actual speech transcription

5. `phone-bridge.ts`
   Telegram transport for remote text and voice notes.

6. `control-server.ts`
   Local HTTP API, audio artifact serving, and the built-in mobile app host.

## Remote Paths

### Best Overall: Built-In Mobile Web App

Use this when you want:

- browser mic capture
- browser audio playback
- one-tap remote use from Android
- compatibility with Tailscale or an HTTPS tunnel

Start it:

```text
/remote on
```

Open:

```text
https://<your-url>/app/
```

### Best Zero-Friction Fallback: Telegram

Use this when you want:

- the least setup
- reliable remote turns
- simple text plus voice note interaction

Start it:

```text
/phone on
```

### Best Button Grid: Unified Remote

Use this when you want:

- fast buttons for `mono`, `speak`, provider changes, and phone pairing
- a control surface on the phone

Do not use this as your main audio path. It is a controller, not a real voice transport.

## Mobile Web App

The mobile app is built into the extension and served from:

```text
/app/
```

Capabilities:

- record a voice turn with the browser microphone
- send typed fallback text
- request spoken replies on each turn
- autoplay returned audio when the browser allows it
- keep the token in session storage by default
- optionally remember the token on that device
- install as a PWA on Android

Token onboarding options:

1. Paste the token in the Settings panel
2. Open the app once with:

```text
/app/?token=YOUR_TOKEN
```

The app will save the token into the current browser session and clean the URL immediately.

Secure-origin rules:

- `localhost` works
- HTTPS works
- random plain HTTP hostnames usually will not allow browser microphone access

That is why Tailscale Serve or an HTTPS tunnel is the right remote path.

Native Android can also use Bluetooth networking/PAN. Pair the phone with the desktop, start `/remote on`, run `/remote setup bluetooth`, then open the native setup link or select the built-in `Bluetooth / local link` profile and adjust the base URL to the desktop Bluetooth adapter IP if needed. Set `PI_SPEAK_BLUETOOTH_BASE_URL` before launching Pi Speak if you want `/remote setup bluetooth` to print a known adapter URL instead of the default `http://192.168.44.1:8767/`.

## HTTP API

Start it with:

```text
/remote on
```

Default bind:

```text
host: 0.0.0.0
port: 8767
```

### Public Routes

These are available before auth because they serve the built-in app:

```text
GET /
GET /app/
GET /app/index.html
GET /app/app.webmanifest
GET /app/sw.js
GET /app/icon.svg
```

### Control Routes

```text
GET  /v1/health
GET  /v1/status
GET  /v1/diagnostics
GET  /v1/route
POST /v1/route

GET  /v1/workspace?path=<absolute-path>
GET  /v1/workspace/file?path=<absolute-path>

GET  /v1/mono/status
POST /v1/mono/on
POST /v1/mono/off

GET  /v1/speak/status
GET  /v1/speak/providers
POST /v1/speak/on
POST /v1/speak/off
POST /v1/speak/stop
POST /v1/speak/test
POST /v1/speak/provider/:provider
POST /v1/speak/rewrite/:onOrOff

GET  /v1/phone/status
POST /v1/phone/on
POST /v1/phone/off
POST /v1/phone/code
POST /v1/phone/unpair

GET  /v1/turn/text?text=hello&audio=1
POST /v1/turn/text
POST /v1/turn/voice

GET  /v1/audio/:id
```

### Auth

Local bypass applies only to true localhost requests:

- `localhost`
- `127.0.0.1`
- `::1`

Remote clients must send one of:

- `Authorization: Bearer <token>`
- `X-Pi-Speak-Token: <token>`

Query-string token auth is reserved for:

- `/app/?token=...` bootstrap onboarding
- `/v1/audio/:id?token=...` reply-audio playback in the browser

Remote control and turn endpoints should use headers, not query-string auth.

### Hardening Defaults

The production-oriented defaults are:

- same-origin CORS unless `PI_SPEAK_HTTP_ALLOWED_ORIGINS` is set
- request body limit for text turns: `64 KB`
- request body limit for voice turns: `25 MB`
- lightweight in-memory rate limits for non-local traffic
- background cleanup of expired reply-audio artifacts
- authenticated diagnostics at `/v1/diagnostics`, including a compact summary block for queue state, phone linkage, mono state, current session/target, and active error sources
- queue/backpressure for remote turns so Pi returns a deterministic busy response instead of piling up unlimited work
- synchronous remote turns fail fast when the current Pi session is already mid-turn, instead of hanging the HTTP request against the same active session
- mutating control routes require `POST`, leaving `GET` read-only for fetch-safe status endpoints
- outbound provider calls share a default `30s` timeout via `PI_SPEAK_OUTBOUND_TIMEOUT_MS`

Inspect the active token with:

```text
/remote token
```

### Example Requests

Text turn:

```bash
curl -X POST http://127.0.0.1:8767/v1/turn/text ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"Summarize the repo\",\"audio\":true}"
```

Voice turn:

```bash
curl -X POST "https://<your-host>/v1/turn/voice?audio=1" ^
  -H "Authorization: Bearer <token>" ^
  -H "Content-Type: audio/webm" ^
  --data-binary "@voice.webm"
```

## Unified Remote

Bundled remote source:

```text
unified-remote/Pi Speak
```

Install path:

```text
C:\ProgramData\Unified Remote\Remotes\Custom\Pi Speak
```

What it is good at:

- toggling `mono`
- toggling `speak`
- switching providers
- requesting the Telegram pair code
- sending short text turns

What it is not good at:

- full remote voice capture
- browser-style audio playback
- low-latency conversational audio

## Environment Variables

### Core

```text
AGENT_PROVIDER=pi|codex|claude|elevenlabs|gemini|gemini-live
CODEX_BIN=codex
CLAUDE_BIN=claude
PI_BIN=pi
AGENT_MODEL=
PI_SPEAK_EXECUTION_ROUTER_MODE=auto|pi|codex|claude
AGENT_CWD=
AGENT_WORKSPACE=
PI_SPEAK_TTS_PROVIDER=auto|legacy|edge|openai|elevenlabs
PI_SPEAK_REWRITE_ENABLED=true|false
PI_SPEAK_WAKE_PHRASE=PK
PI_SPEAK_MONO_ACTIVITY_TIMEOUT=15
PI_SPEAK_WAKE_SENSITIVITY=low|medium|high
PI_SPEAK_WAKE_FUZZY_ENABLED=true|false              # optional override
PI_SPEAK_WAKE_FUZZY_MAX_DISTANCE=0|1|2              # optional override
PI_SPEAK_WAKE_COMPACT_PREFIX_ENABLED=true|false     # optional override
```

If `PI_SPEAK_EXECUTION_ROUTER_MODE` is unset, explicit `AGENT_PROVIDER=pi`, `AGENT_PROVIDER=codex`, or `AGENT_PROVIDER=claude` controls which backend remote turns dispatch to. Set the router mode to `auto` when you want the conversation router to choose from the reduced task, while phone/app-selected provider overrides still win for that turn.

The gateway provider contract currently treats `codex` and `claude` as resumable CLI session providers. Recent Codex and Claude sessions can show resume commands in the mobile/session dashboard, while `pi` remains a direct turn provider without stored-session resume support.

### Rewrite

```text
OPENROUTER_API_KEY=...
PI_SPEAK_REWRITE_MODEL=openai/gpt-oss-20b:nitro
PI_SPEAK_OPENROUTER_URL=https://openrouter.ai/api/v1/chat/completions
```

### OpenAI

```text
# Dedicated key for audio TTS (avoids consuming the general LLM key)
PI_SPEAK_OPENAI_KEY=...
# Legacy fallback
VOICE_TOOLS_OPENAI_KEY=...
PI_SPEAK_OPENAI_TTS_MODEL=gpt-4o-mini-tts
PI_SPEAK_OPENAI_VOICE=alloy
PI_SPEAK_REMOTE_OPENAI_STT_MODEL=whisper-1
PI_SPEAK_OPENAI_BASE_URL=https://api.openai.com/v1
```

### ElevenLabs

```text
# ELEVENLABS_API_KEY is read from your environment
PI_SPEAK_ELEVENLABS_VOICE_ID=<voice-id>
PI_SPEAK_ELEVENLABS_MODEL_ID=eleven_flash_v2_5
```

### Vertex AI Gemini

```text
PI_SPEAK_GEMINI_BACKEND=vertex
PI_SPEAK_VERTEX_API_KEY=<optional-vertex-api-key>
GOOGLE_CLOUD_PROJECT=<your-gcloud-project>
GOOGLE_CLOUD_LOCATION=us-central1
PI_SPEAK_GEMINI_TEXT_MODEL=gemini-2.5-flash
PI_SPEAK_GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
```

Run `gcloud auth application-default login` on the machine hosting the tray/gateway, or set `PI_SPEAK_VERTEX_API_KEY` to a Vertex AI API key. Enable the Vertex AI API on the Cloud project.

### Edge TTS

```text
PI_SPEAK_EDGE_VOICE=en-US-AriaNeural
PI_SPEAK_EDGE_LANG=en-US
PI_SPEAK_EDGE_RATE=1
PI_SPEAK_EDGE_TIMEOUT_MS=15000
```

### Legacy / Local Python

```text
PI_SPEAK_SPEAK11_PATH=...
PI_SPEAK_PYTHON=...
WHISPER_MODEL=tiny
WHISPER_DEVICE=cpu
WHISPER_COMPUTE=int8
PI_SPEAK_REMOTE_WHISPER_MODEL=base
PI_SPEAK_REMOTE_STT_PROVIDER=auto|local|openai
```

`PI_SPEAK_PYTHON` and `PI_SPEAK_SPEAK11_PATH` are now the first-class override path for local Python audio setups. When they are unset, Pi scans the normal Windows user-site `Python*/Scripts` locations before falling back to PATH resolution.

### Telegram

```text
PI_SPEAK_TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_TOKEN=...
PI_SPEAK_PHONE_WAIT_TIMEOUT_MS=180000
```

### HTTP Remote

```text
PI_SPEAK_HTTP_HOST=0.0.0.0
PI_SPEAK_HTTP_PORT=8767
PI_SPEAK_HTTP_TOKEN=...
PI_SPEAK_HTTP_AUDIO_TTL_MS=600000
PI_SPEAK_HTTP_AUDIO_CLEANUP_MS=30000
PI_SPEAK_HTTP_ALLOWED_ORIGINS=https://your-tailnet-host,https://your-tunnel-host
PI_SPEAK_HTTP_TIMEOUT_MS=180000
PI_SPEAK_HTTP_TEXT_BODY_LIMIT_BYTES=65536
PI_SPEAK_HTTP_VOICE_BODY_LIMIT_BYTES=26214400
PI_SPEAK_HTTP_RATE_LIMIT_WINDOW_MS=60000
PI_SPEAK_HTTP_RATE_LIMIT_CONTROL=20
PI_SPEAK_HTTP_RATE_LIMIT_VOICE=6
PI_SPEAK_OUTBOUND_TIMEOUT_MS=30000
```

## Troubleshooting

### The phone web app opens, but the mic does not work

You are probably not on a secure origin.

Use one of:

- `http://localhost:8767/app/`
- Tailscale Serve over HTTPS
- Cloudflare Tunnel over HTTPS

### `/mono on` starts, but voice transcription fails

You likely do not have the Python audio stack installed. The local listener depends on:

- `numpy`
- `sounddevice`
- `faster_whisper`

### Remote voice turns fail

Check these in order:

1. `/remote status`
2. `/v1/diagnostics`
2. `/remote token`
3. `PI_SPEAK_REMOTE_STT_PROVIDER`
4. OpenAI key or local whisper setup

### Speech is using the wrong provider

Check:

```text
/speak status
/speak providers
/speak provider edge
```

### Telegram pairing is stuck

Use:

```text
/phone code
/phone unpair
```

Then link again with the fresh code.

## Testing

Run the automated production-readiness checks with:

```text
npm test
```

Current automated coverage includes:

- non-local auth enforcement
- localhost auth bypass
- body-size rejection
- voice content-type rejection
- rate limiting
- audio artifact expiry
- Telegram link + text-turn handling
- PWA token persistence rules
- remote queue backpressure behavior
- runtime path resolution for local Python / speak11
- explicit listener shutdown signaling with force-kill fallback

## Manual Smoke Checklist

Before treating a machine as production-ready, verify:

1. `/mono on`
2. local wake phrase: say `PK`
3. `/phone on` then `/phone code`, then complete a Telegram text turn and voice-note turn
4. `/remote on`, open `/app/`, complete a text turn and voice turn, and confirm reply audio playback
5. over Tailscale or your HTTPS tunnel, confirm non-local requests fail without the token and succeed with it

For a full phone-focused run sheet with pass/fail capture fields, use `docs/REMOTE_VALIDATION_CHECKLIST.md`.
For a compact operator worksheet, use `docs/REMOTE_VALIDATION_RUN_SHEET.md`.

## Files You Will Care About

- [index.ts](./index.ts)
- [tts.ts](./tts.ts)
- [stt.ts](./stt.ts)
- [phone-bridge.ts](./phone-bridge.ts)
- [control-server.ts](./control-server.ts)
- [listener/listener.py](./listener/listener.py)
- [web/remote/index.html](./web/remote/index.html)
- [docs/CODEBASE_MAP.md](./docs/CODEBASE_MAP.md)

## Release Notes

See [CHANGELOG.md](./CHANGELOG.md).
