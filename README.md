# pi-speak-pk

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
4. Remote from your phone with browser mic + audio playback: use `/remote on`, then open `/app/`
5. Remote button grid on Android: use the bundled Unified Remote remote

## Install

Install the extension:

```text
pi npm i pi-speak-pk
```

Reload Pi after install.

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
/phone on
/phone code
```

Then in Telegram:

1. Open your bot
2. Send `/link <code>`
3. Send text or voice notes to Pi

This is the easiest remote path. It works well when you want reliability more than low latency.

`PI_SPEAK_TELEGRAM_BOT_TOKEN` can point to an existing bot you already control. It does not need to be a fresh bot, but using a dedicated bot keeps the Pi workflow cleaner and easier to secure.

### 4. Remote In From Your Phone With The Built-In Web App

```text
/remote on
/remote token
```

Then open one of these:

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

For real phone use, prefer an HTTPS URL through Tailscale Serve or a tunnel.

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
```

Behavior:

- starts the HTTP server
- serves the mobile app from `/app/`
- exposes remote-control endpoints
- generates a token if one is not already configured

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
```

This matters because `PK bugfix` can route voice input to that named session, while compact routes like `PK one` / `PK1` and `PK two` / `PK2` can stay stable and distinct.

`/sess` with no args shows the current session, ready sessions, aliases, store path, a compact `1` vs `2` lane summary, and inline state for known sessions.

Use `/sess slots` when you want the explicit compact-route view for `PK one` / `PK1` and `PK two` / `PK2`.

Use `/sess ui` to open the interactive session manager pane in a separate terminal. It mirrors the `/sess` dashboard, refreshes within one second of external mutations, supports focus movement with `↑` / `↓`, `tab`, or `j` / `k`, shows the compact PK1/PK2 route lanes plus a focused-session footer, and adds keybindings `[r] rename`, `[a] alias`, `[x] remove`, and `[q] quit`. Voice and pane-driven changes surface as toasts at the bottom of the pane.

For operator details, see:
- `docs/VOICE_SESSION_BRIDGE.md`
- `docs/SESSION_OPERATIONS.md`

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

GET  /v1/mono/on
GET  /v1/mono/off
GET  /v1/mono/status

GET  /v1/speak/on
GET  /v1/speak/off
GET  /v1/speak/stop
GET  /v1/speak/status
GET  /v1/speak/test
GET  /v1/speak/providers
GET  /v1/speak/provider/:provider
GET  /v1/speak/rewrite/:onOrOff

GET  /v1/phone/on
GET  /v1/phone/off
GET  /v1/phone/status
GET  /v1/phone/code
GET  /v1/phone/unpair

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
- authenticated diagnostics at `/v1/diagnostics`
- queue/backpressure for remote turns so Pi returns a deterministic busy response instead of piling up unlimited work
- synchronous remote turns fail fast when the current Pi session is already mid-turn, instead of hanging the HTTP request against the same active session

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
PI_SPEAK_TTS_PROVIDER=auto|legacy|edge|openai|elevenlabs
PI_SPEAK_REWRITE_ENABLED=true|false
PI_SPEAK_WAKE_PHRASE=PK
PI_SPEAK_MONO_ACTIVITY_TIMEOUT=15
PI_SPEAK_WAKE_SENSITIVITY=low|medium|high
PI_SPEAK_WAKE_FUZZY_ENABLED=true|false              # optional override
PI_SPEAK_WAKE_FUZZY_MAX_DISTANCE=0|1|2              # optional override
PI_SPEAK_WAKE_COMPACT_PREFIX_ENABLED=true|false     # optional override
```

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
ELEVENLABS_API_KEY_REDACTED
REDACTED_ELEVENLABS_HISTORY_LINE
REDACTED_ELEVENLABS_HISTORY_LINE
```

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

## Manual Smoke Checklist

Before treating a machine as production-ready, verify:

1. `/mono on`
2. local wake phrase: say `PK`
3. `/phone on` then `/phone code`, then complete a Telegram text turn and voice-note turn
4. `/remote on`, open `/app/`, complete a text turn and voice turn, and confirm reply audio playback
5. over Tailscale or your HTTPS tunnel, confirm non-local requests fail without the token and succeed with it

## Files You Will Care About

- [index.ts](./index.ts)
- [tts.ts](./tts.ts)
- [stt.ts](./stt.ts)
- [phone-bridge.ts](./phone-bridge.ts)
- [control-server.ts](./control-server.ts)
- [listener/listener.py](./listener/listener.py)
- [web/remote/index.html](./web/remote/index.html)

## Release Notes

See [CHANGELOG.md](./CHANGELOG.md).
