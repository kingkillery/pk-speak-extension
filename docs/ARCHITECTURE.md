# Architecture

## 1. Overview

Pi Speak is a voice- and phone-controlled gateway around coding-agent sessions. Its client-facing binaries are `pk-speak`, `pi-speak-pk`, `pi-speak-gateway`, and `pi-speak-tray`; clients include the desktop Pi extension, browser/PWA, Android, Telegram, and local wake-word audio. The extension entrypoint is `index.ts`, which runs inside Pi and coordinates commands, routing, agents, and audio; the standalone gateway entrypoint is `headless-gateway.ts`, used by the daemon behind `pk-speak gateway`.

## 2. Core subsystems

### `index.ts`

- **Purpose:** Pi extension entrypoint and runtime coordinator.
- **Key exports/symbols:** Extension registration and command handlers (including `/speak`, `/mono`, `/phone`, `/remote`, and `/sess`), wake routing, provider selection, and remote-turn orchestration.
- **Driven by:** Pi extension lifecycle and commands, local listener events, HTTP/Telegram requests, and persisted session-routing state. It coordinates TTS, STT, Telegram, session selection, and the active agent provider.

### `tts.ts`

- **Purpose:** Speech synthesis behind a common audio result interface.
- **Key exports/symbols:** TTS provider resolution and synthesis helpers, including the provider implementations for `legacy`, `gemini`, `elevenlabs`, `openai`, and `edge`.
- **Driven by:** A requested reply and `PI_SPEAK_TTS_PROVIDER`. When no provider is explicitly selected, auto-resolution checks `legacy`, then `gemini`, `elevenlabs`, `openai`, and finally `edge`.

### `stt.ts`, `moonshine-stt.ts`, and listener workers

- **Purpose:** Convert completed uploaded utterances to text while preserving the existing provider chain as the default and optionally using Moonshine as an on-device backend or safe fallback.
- **Key exports/symbols:** `transcribeAudioBuffer`, `resolveSttBackendMode`, the existing warm `faster-whisper` worker, and a separate persistent Moonshine JSONL worker. Both return the established final `SttResult`; Moonshine native/model objects remain isolated in its process.
- **Selection:** `PI_SPEAK_REMOTE_STT_BACKEND=existing|moonshine|auto`. `auto` switches only after a classified rate-limit, upstream/transport, timeout, worker, or dependency failure, once, at the completed-utterance boundary. Empty text, invalid audio, authentication/configuration errors, and unknown failures do not trigger fallback. `/v1/live` remains the separate full-duplex Gemini/OpenAI-Realtime path.
- **Driven by:** `/v1/turn/voice`, Telegram/CLI uploaded audio, or local microphone audio. The always-on listener keeps its two-tier faster-whisper pipeline unchanged; `PI_SPEAK_WAKE_SENSITIVITY` controls wake-word tolerance.

### `control-server.ts`

- **Purpose:** Authenticated HTTP API and mobile/desktop web-app host.
- **Key exports/symbols:** Gateway server creation and handlers for `/v1/*`, static hosting for `/app/` (full remote) and `/orb/` (desktop Live companion), status/diagnostics, turn submission, routing, sessions, workspace, events, Agent Hub, live config, and web-search proxy.
- **Driven by:** Browser/PWA, desktop orb, Android, Telegram bridge, and other HTTP clients. It validates/authenticates requests, routes turns into the extension runtime, and exposes the gateway API.

### `headless-gateway.ts`

- **Purpose:** Standalone gateway process; the long-running daemon behind `pk-speak gateway`.
- **Key exports/symbols:** Headless gateway startup and shutdown wiring, control-server startup, and standalone provider/runtime initialization.
- **Driven by:** The CLI/service lifecycle rather than Pi's extension host. It lets phone, browser, and Android clients reach the same HTTP turn and control surface without an interactive Pi terminal.

### `gemini-live-turn.ts`

- **Purpose:** Execute Gemini text turns and Gemini Live bidirectional audio turns.
- **Key exports/symbols:** `GEMINI_LIVE_MODEL_OPTIONS`, `GEMINI_TEXT_MODEL_OPTIONS`, `GEMINI_TTS_MODEL_OPTIONS`, `getGeminiBackend`, `getGeminiLiveModel`, `createGeminiClient`, and turn helpers. `GEMINI_TEXT_MODEL_OPTIONS` includes `9router/ag/gemini-3-5-flash-high`.
- **Driven by:** Gemini provider requests and environment configuration. Backend selection switches between the developer API and Vertex AI (`PI_SPEAK_GEMINI_BACKEND`, with credential/project inference); API version and Live location are resolved per backend.

### `realtime-gateway.ts`, `live-backend.ts`, `openai-realtime-live.ts`

- **Purpose:** Full-duplex Live conversational assistant on `/v1/live`.
- **Key exports/symbols:** `handleRealtimeGateway`, `buildRealtimeTools`, `dispatchRealtimeToolCall`, `REALTIME_SYSTEM_PROMPT`; backend selection via `resolveLiveBackendKind` (`gemini` default, `openai-realtime`/`hf` optional).
- **Driven by:** WebSocket clients (desktop orb, `/app/?mode=live`, Android Live). Upstream is Gemini Live by default, or an OpenAI-Realtime-compatible S2S URL (`PI_SPEAK_OPENAI_REALTIME_URL` / `SPEECH_TO_SPEECH_URL`). Tool surface includes session/hub/workspace reads, `web_search`, `camera_snapshot`, and approval-gated mutations.
- **OMPK bridge:** `realtime-session-target.ts` merges dashboard, attention-heartbeat, and Agent Hub identities. Resolution prefers exact agent/session IDs, canonical paths, names, and aliases; ambiguous fragments fail explicitly. The chosen target is stored on the individual live connection, never in the global routing target. `ControlServer.realtimeBridge` exposes trusted in-process actions, but realtime dispatch invokes mutations only after command approval.

### `desktop-live-client.ts` and `web/remote/orb.*`

- **Purpose:** Terminal-adjacent Live companion. `/voice realtime` opens Edge `--app=http://127.0.0.1:<port>/orb/` by default (not the full remote chrome).
- **Key exports/symbols:** `openDesktopLiveClient`, `buildDesktopLiveClientUrl(port, cwd?, surface?: "orb"|"app")`.
- **Driven by:** Local operator on the same machine as the gateway; uses HF-style capture/playback worklets against `/v1/live`.


### `agent-provider-registry.ts`

- **Purpose:** Static provider metadata and normalization map.
- **Key exports/symbols:** `AGENT_PROVIDER_SPECS`, provider-name normalization, capability metadata, executable names, aliases, and resume rules for `pi`, `codex`, `claude`, `oh-my-pk`, `gemini`, `gemini-live`, `elevenlabs`, and `9router`.
- **Driven by:** Provider names from configuration and runtime capability/session queries.

### `agent-provider-factory.ts`

- **Purpose:** Instantiate the correct provider class for initial runtime state or an individual turn.
- **Key exports/symbols:** `createInitialAgentProviders`, `createTurnAgentProvider`, `resolveAgentWorkspace`, `createOmpAgentProvider`, and `createOmpResumeProvider`.
- **Driven by:** Resolved `AGENT_PROVIDER`, backend overrides, workspace configuration, and optional target/session IDs. It chooses Pi, Codex, Claude, Oh-my-pk, or Gemini implementations and creates resume providers when a resumable target is selected.

### `session-routing.ts` and `session-routing-store.ts`

- **Purpose:** Named session targeting, aliases, compact PK1/PK2 lanes, and durable routing state.
- **Key exports/symbols:** Pure naming/alias/dashboard/removal helpers in `session-routing.ts`; load/persist helpers in `session-routing-store.ts`.
- **Driven by:** Spoken wake targets, `/sess` commands, HTTP route/session mutations, and the `/sess` management pane. The store persists mappings while runtime snapshots distinguish busy, idle, and saved sessions.

### `phone-bridge.ts`

- **Purpose:** Telegram transport for text and voice-note control.
- **Key exports/symbols:** Telegram polling/setup, chat linking, and turn forwarding helpers.
- **Driven by:** Telegram updates and linked-chat commands. It converts incoming text/voice notes into gateway turns and sends text plus generated audio replies back to Telegram.

## 3. Data flow: a turn

1. The user says “PK”; the wake detector in `listener.py` tier 1 fires.
2. Tier 2 performs full STT transcription of the utterance.
3. Wake routing resolves the target named session or compact PK1/PK2 lane.
4. `index.ts` routes the turn to the active agent provider.
5. The provider (`codex`, `claude`, `pi`, `gemini`, or another configured backend) runs the turn.
6. Reply text is returned through the turn pipeline.
7. The selected TTS provider synthesizes audio.
8. The audio is played on the local output or returned to the requesting client for playback.

## 4. Provider model

`AgentProviderName` is the union type:

```ts
type AgentProviderName =
  | "pi" | "codex" | "claude" | "oh-my-pk"
  | "gemini" | "gemini-live" | "elevenlabs" | "9router";
```

`AGENT_PROVIDER` selects the server-side backend (defaulting to `pi` when unset). `pi`, `codex`, `claude`, and `oh-my-pk` are routing/coding-agent providers: they run an external or embedded coding agent and can target workspaces and, where supported, resumable sessions. `gemini`, `gemini-live`, `elevenlabs`, and `9router` are voice-native or direct model providers in the registry; Gemini Live is the bidirectional audio path, while Gemini is the text/model path. Provider capabilities differ: for example Gemini and Gemini Live do not provide session routing, and 9router disables routing, steering, and resumable sessions.

`9router/ag/gemini-3-5-flash-high` is a text model option, not a separate `AgentProviderName`. It appears in `GEMINI_TEXT_MODEL_OPTIONS` and can therefore be selected as the model used by the `gemini` text provider.

## 5. Socket / HTTP API surface

The gateway is HTTP-based; clients use the following high-frequency routes:

| Endpoint | Description |
|---|---|
| `/v1/turn/text` | Submit a text turn, optionally selecting a session/workspace and requesting audio. |
| `/v1/turn/voice` | Upload recorded audio for STT, agent execution, and optional spoken reply. |
| `/v1/live` | Full-duplex Live WebSocket (seq-framed PCM + JSON control). |
| `/v1/live/config` | Live client bootstrap: web-search availability, camera, backends. |
| `/v1/search` | Authenticated Serper web-search proxy for Live tools (key stays server-side). |
| `/v1/agents` | Discover configured/available agent providers and capabilities. |
| `/v1/sessions/*` | List, inspect, rename, alias, archive, remove, launch, or inspect compact session lanes. |
| `/v1/route` | Read or change the active named-session route. |
| `/v1/herdr/agents` | List the Agent Hub/Herdr agent tree and lane state. |
| `/v1/herdr/agent/:id/chat` | Send a chat turn to a selected Herdr agent lane. |
| `/v1/workspace` | Browse the configured workspace root (with file reads exposed by the workspace file variant). |
| `/v1/events` | Tail the server-sent event stream for session and administrative updates. |

Requests are authenticated with `PI_SPEAK_HTTP_TOKEN` where required. The same gateway surface serves the browser, desktop orb, Android, Telegram bridge, and standalone daemon clients.

## 6. Android, PWA, and desktop orb clients

The full web remote is hosted at `/app/`: text/voice turns, target selection, setup, reply audio, session management, events, workspace browsing, and Live mode (`?mode=live`). The **desktop orb** is hosted at `/orb/`: a minimal HF-style Live companion (orb states, mic gate, camera PIP) for terminal operators; `/voice realtime` opens it in Edge app mode by default. The native APK is downloadable at `/download/pi-speak.apk`; it stores machine profiles and connection/auth settings locally, offers native text/voice controls, Live duplex (including `camera_snapshot` via CameraX and `audio_format` sample-rate switching), and mirrors session routing, events, workspace, and Agent Hub operations. The Boox variant is an e-ink-oriented native surface with the same Live tool hooks. Unified Remote is a lightweight remote-control surface for quick machine/control actions rather than the full session and Agent Hub management experience. All clients call the same gateway; the differences are local device capabilities and UI density.

## 7. Key environment variables

| Name | Purpose | Values / format | Required by |
|---|---|---|---|
| `AGENT_PROVIDER` | Select the active agent backend. | `pi`, `codex`, `claude`, `oh-my-pk`, `gemini`, `gemini-live`, `elevenlabs`, `9router`; defaults to `pi`. | Provider config/factory, `index.ts`, gateway |
| `PI_SPEAK_TTS_PROVIDER` | Explicitly select speech synthesis instead of auto-resolution. | `legacy`, `gemini`, `elevenlabs`, `openai`, or `edge`. | `tts.ts` |
| `PI_SPEAK_GEMINI_BACKEND` | Choose Gemini API backend. | `developer-api`/`developer`/`api`, `vertex`/`vertexai`/`gcloud`, or `simulated`/`sim`. | `gemini-live-turn.ts` |
| `PI_SPEAK_GEMINI_TEXT_MODEL` | Override the Gemini text model. | Model ID, including `9router/ag/gemini-3-5-flash-high`. | Gemini text turns |
| `PI_SPEAK_GEMINI_LIVE_MODEL` | Override the Gemini Live model. | Live model ID, such as `gemini-3.1-flash-live-preview`. | Gemini Live turns |
| `PI_SPEAK_LIVE_BACKEND` | Select Live upstream adapter. | `gemini` (default), `openai-realtime`, `hf`, `s2s`. | `live-backend.ts`, `realtime-gateway.ts` |
| `PI_SPEAK_OPENAI_REALTIME_MODEL` | Select the official OpenAI Realtime model; appended to `api.openai.com` URLs. | Defaults to `gpt-realtime`. | `openai-realtime-live.ts` |
| `PI_SPEAK_OPENAI_REALTIME_INPUT_RATE` | Override upstream PCM input rate for compatible custom/HF endpoints. | Defaults to `24000`; gateway client PCM is resampled. | `openai-realtime-live.ts` |
| `PI_SPEAK_OPENAI_REALTIME_TRANSCRIPTION_MODEL` | Enable input transcription on OpenAI-compatible endpoints. | Official default `gpt-4o-mini-transcribe`; set `off` to disable. | `openai-realtime-live.ts` |
| `PI_SPEAK_OPENAI_REALTIME_URL` | OpenAI-Realtime / HF S2S WebSocket URL. | `wss://…/v1/realtime…` (aliases: `SPEECH_TO_SPEECH_URL`, `PI_SPEAK_S2S_URL`). | `openai-realtime-live.ts` |
| `SERPER_API_KEY` | Enable Live `web_search` tool. | Serper.dev key (alias `PI_SPEAK_SERPER_API_KEY`). | `web-search.ts`, `/v1/search` |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI project identifier. | GCP project ID. | Gemini Vertex client |
| `PI_SPEAK_HTTP_TOKEN` | Authenticate HTTP gateway requests. | Shared bearer/token string. | `control-server.ts`, clients |
| `PI_SPEAK_BASE_URL` | Advertise or use the gateway base URL for remote clients. | Reachable HTTP(S) base URL. | Pairing/setup and clients |
| `PI_SPEAK_WORKSPACE_ROOT` | Constrain workspace browsing and file reads. | Directory path; defaults to the agent working directory. | `control-server.ts` workspace API |
| `PI_SPEAK_WAKE_SENSITIVITY` | Set wake-word matching tolerance. | `low`, `medium`, or `high`. | `listener.py` / wake routing |

## 8. Live backend capability matrix

| Capability | Gemini (`PI_SPEAK_LIVE_BACKEND=gemini`) | OpenAI-Realtime / HF |
| --- | --- | --- |
| Client wire | `/v1/live` seq PCM + JSON | same |
| Upstream | `@google/genai` live.connect | `openai-realtime-live.ts` → `wss://…/v1/realtime` |
| Session resumption | `sessionResumption` handle + `goAway` reconnect | **not supported** — `reconnectLiveSession` clears handle and clean-reconnects |
| Tool dispatch | `dispatchRealtimeToolCall` | same |
| NON_BLOCKING tools | developer-API only | n/a |
| Desktop orb approvals | `tool_approval_required` → approve/reject | same |
