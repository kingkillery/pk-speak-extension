# Getting started with pk-speak

## 1. What is pk-speak?

pk-speak adds voice control to Pi and oh-my-pk: it can speak replies, listen for the `PK` wake phrase, and route spoken requests to named sessions. It also connects your phone through Telegram or a web/native remote, and can act as an agent gateway backed by Gemini Live.

## 2. Install

If you already use Pi, install the extension from inside Pi:

```text
pi npm i pi-pk-speak
```

Reload Pi after installing so it discovers the extension.

For a standalone desktop setup, install the CLI globally and start its setup flow:

```bash
npm install -g pk-speak
pi-speak-pk
```

The setup flow creates the local profile and pairing information. Reload Pi after installing the Pi extension; standalone commands do not replace that reload.

## 3. The five paths

| Path | Start it with | Use it when |
| --- | --- | --- |
| Local voice | `/voice tts` or `/speak on` | You want short spoken progress and result acknowledgements while the complete reply stays in the terminal. |
| Wake-word voice | `/voice combo` or `/mono on` | You want hands-free turn-based interaction: say `PK` instead of typing a command first. |
| Phone via Telegram | `/phone on` | You want the simplest, resilient phone path using text and voice notes. |
| Phone web/native app | `/pk-remote` | You want a QR-based Android setup with microphone input, audio replies, and a session dashboard. |
| Live voice (desktop orb / phone / web) | `/voice realtime` | You want full-duplex live conversation. Terminal users get a desktop **orb** companion; phones/web use `/app/?mode=live` or the Android Live button. |

## 4. Minimal first session

Work through these steps in the Pi session where you want voice enabled.

1. Install the extension:

   ```text
   pi npm i pi-pk-speak
   ```

   Reload Pi after the install.

2. Turn on speech and play a test reply:

   ```text
   /speak on
   /speak test
   ```

3. Check the selected provider and speech state:

   ```text
   /speak status
   ```

4. Enable the always-listening wake phrase:

   ```text
   /mono on
   ```

   Then say **PK**. Pi opens a short voice-input window for your request.

5. Check the standalone setup, backend, voice, APK, and gateway inputs:

   ```text
   pk-speak doctor
   ```

## 5. TTS Provider Ladder

With `PI_SPEAK_TTS_PROVIDER=auto` (the default), pk-speak checks providers in this order and uses the first available one. If synthesis fails, it can fall through to the next available provider.

1. **Legacy** — local `speak11`. Set `PI_SPEAK_TTS_PROVIDER=legacy` to select it explicitly. It needs the local Python dependencies; `PI_SPEAK_PYTHON` and `PI_SPEAK_SPEAK11_PATH` can point to the Python executable and `speak11` installation.
2. **Gemini** — Google Gemini/Vertex TTS. Set `PI_SPEAK_GEMINI_BACKEND=vertex`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`; authenticate with `gcloud auth application-default login`, or provide `PI_SPEAK_VERTEX_API_KEY`. For explicit Gemini TTS, also set `PI_SPEAK_TTS_PROVIDER=gemini`.
3. **ElevenLabs** — hosted speech. Set `ELEVENLABS_API_KEY`; optionally set `PI_SPEAK_ELEVENLABS_VOICE_ID` and `PI_SPEAK_ELEVENLABS_MODEL_ID`.
4. **OpenAI** — hosted speech using the dedicated audio key. Set `PI_SPEAK_OPENAI_KEY` (the legacy fallback is `VOICE_TOOLS_OPENAI_KEY`); optionally set `PI_SPEAK_OPENAI_TTS_MODEL` and `PI_SPEAK_OPENAI_VOICE`.
5. **Edge** — bundled `node-edge-tts`, with no API key or external service required. Optionally set `PI_SPEAK_EDGE_VOICE`, `PI_SPEAK_EDGE_LANG`, `PI_SPEAK_EDGE_RATE`, and `PI_SPEAK_EDGE_TIMEOUT_MS`.

To inspect or choose providers interactively, use `/speak providers` and `/speak provider edge` (replace `edge` with `gemini`, `elevenlabs`, or `openai`).

## 6. Phone Setup (quick path)

From Pi, run:

```text
/pk-remote
```

The command starts the HTTP gateway if needed and prints a QR code. Scan it with the Android phone to open the setup flow and pair the native app. The native app provides a session dashboard, routing controls, and the Agent Hub for discovering and operating oh-my-pk agent lanes; it also supports phone microphone turns, spoken replies, workspace browsing, and session events.

For a phone on the same network, the LAN URL is fine for initial testing. Tailscale is better when the phone and computer are not on the same LAN, when you need a stable address while networks change, or when browser microphone access requires HTTPS. Expose the local gateway through Tailscale Serve:

```powershell
tailscale serve --bg http://127.0.0.1:8767
```

Then use the printed Tailscale HTTPS URL. Keep the remote token private; remote clients authenticate with it.

## 7. Named sessions and voice routing

Create and select named sessions, then inspect the compact voice lanes:

```text
/sess new bugfix
/sess switch bugfix
/sess slots
```

`/sess slots` shows ownership of the compact `PK1`/`PK2` lanes. This matters when several Pi sessions are active: after assigning a session to lane 1, saying **PK one** (or **PK1**) routes the next voice turn to that lane without typing. The corresponding lane-2 forms are **PK two** and **PK2**; they remain distinct from lane 1.

## 8. Live voice quick-start

Live mode is full-duplex conversation over `/v1/live`. The default upstream is the **HF speech-to-speech** server (OpenAI-Realtime wire) whenever an S2S URL or `PI_SPEAK_LIVE_BACKEND=hf` is configured — with the URL defaulting to the local server at `ws://localhost:8765/v1/realtime`. **Gemini Live** is the fallback when nothing S2S-related is set.

### Terminal (desktop orb)

```text
/voice realtime
```

That starts the gateway if needed and opens the **orb companion** at `http://127.0.0.1:<port>/orb/` (Edge `--app` when available). Tap the orb once to grant the mic. The orb is intentionally separate from the full remote chrome so it can sit beside your terminal.

- Full remote (sessions, hub, workspace): `http://127.0.0.1:<port>/app/?mode=live`
- Orb only: `http://127.0.0.1:<port>/orb/?mode=live&autoconnect=1`

### Gemini credentials (fallback backend)

Developer API:

```powershell
$env:GOOGLE_API_KEY = "<key>"   # or GEMINI_API_KEY
```

Vertex:

```powershell
$env:PI_SPEAK_GEMINI_BACKEND = "vertex"
$env:GOOGLE_CLOUD_PROJECT = "<your-gcloud-project>"
$env:GOOGLE_CLOUD_LOCATION = "global"
gcloud auth application-default login
# Optional: $env:PI_SPEAK_VERTEX_API_KEY = "<vertex-api-key>"
```

Smoke test:

```text
pi-speak-gemini-live-smoke --modality audio
```

Keyless CI / local simulation:

```powershell
$env:PI_SPEAK_GEMINI_BACKEND = "simulated"
```

### Default OpenAI-Realtime / HF S2S backend

The HF speech-to-speech server (https://github.com/huggingface/speech-to-speech) is the default S2S upstream. Setting any S2S URL selects it automatically — no `PI_SPEAK_LIVE_BACKEND` needed — and with the backend selected but no URL set, the connect URL defaults to the local server at `ws://localhost:8765/v1/realtime` (run `speech-to-speech` locally and `/voice realtime` just works). Gemini Live remains the fallback when nothing S2S-related is configured.

```powershell
$env:PI_SPEAK_LIVE_BACKEND = "openai-realtime"   # or hf / s2s; optional when a URL below is set
$env:PI_SPEAK_OPENAI_REALTIME_URL = "wss://<host>/v1/realtime?session_token=..."  # optional; defaults to ws://localhost:8765/v1/realtime
$env:PI_SPEAK_OPENAI_REALTIME_MODEL = "gpt-realtime" # required by official api.openai.com URLs; appended as ?model=
# Client PCM is resampled from 16 kHz to the official 24 kHz input rate by default.
# Set PI_SPEAK_OPENAI_REALTIME_INPUT_RATE only for a compatible custom/HF endpoint.
# PI_SPEAK_OPENAI_REALTIME_TRANSCRIPTION_MODEL defaults to gpt-4o-mini-transcribe on api.openai.com;
# set it explicitly for a compatible custom endpoint, or to off to disable.
# aliases: SPEECH_TO_SPEECH_URL, PI_SPEAK_S2S_URL
# optional: PI_SPEAK_OPENAI_REALTIME_KEY, PI_SPEAK_OPENAI_REALTIME_VOICE
```

Clients still connect to **this** gateway's `/v1/live`; the gateway adapts upstream.

### Live tools

| Tool | Notes |
| --- | --- |
| Session / hub / workspace reads | Always available (approval not required) |
| `web_search` | Needs `SERPER_API_KEY` or `PI_SPEAK_SERPER_API_KEY` on the gateway |
| `camera_snapshot` | Client captures one JPEG frame (web orb/PWA or Android CameraX) |
| Session selection and inspection | `list_sessions`, `get_session_info`, and connection-local `switch_session` are read-only |
| OMPK control | `send_session_message`, `resume_session`, `launch_agent`, `kill_agent`, `revive_agent`, and `archive_session` require approval |
| Terminal commands | Read-only allowlist runs directly; everything else requires approval |

### Backend capability matrix

| Capability | Gemini Live | OpenAI-Realtime / HF |
| --- | --- | --- |
| Full-duplex PCM on `/v1/live` | yes | yes |
| Coding-agent tools (`dispatchRealtimeToolCall`) | yes | yes |
| NON_BLOCKING slow tools | developer-API only (Vertex stays blocking) | n/a (adapter-defined) |
| Mid-call resumption (`goAway` handle) | yes | **no** — clean upstream reconnect only |
| Approvals on desktop orb | yes (`tool_approval_*`) | yes |
| `web_search` | Serper key on gateway | Serper key on gateway |
| `camera_snapshot` | client JPEG frame | client JPEG frame |
| Input transcript role | user + assistant | endpoint-dependent; assistant final events normalized |
| Tool schema | Gemini function declarations | recursively normalized to OpenAI JSON Schema |

Useful settings: `PI_SPEAK_GEMINI_LIVE_MODEL`, `PI_SPEAK_GEMINI_LIVE_MODALITY=audio|text`. Keep provider keys server-side.

## 9. Where to go next

- [Session Operations](./SESSION_OPERATIONS.md) — named sessions, aliases, compact lanes, and the management pane.
- [Remote Operating Guide](./REMOTE_OPERATING_GUIDE.md) — Telegram, browser, Android, Bluetooth, Tailscale, and diagnostics.
- [README main commands](../README.md#main-commands) — the complete `/speak`, `/mono`, `/phone`, `/remote`, and `/sess` reference.
- [CHANGELOG](../CHANGELOG.md) — release notes and recent behavior changes.
