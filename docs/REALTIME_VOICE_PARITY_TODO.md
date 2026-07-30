# Realtime Voice Parity — Audit TODO

**Read this first: the realtime voice stack already exists.** This is not a build plan.
Full-duplex `/v1/live`, HF-style worklets, the desktop orb, Gemini Live and
OpenAI-Realtime backends, `buildRealtimeTools` / `dispatchRealtimeToolCall`, the
OMPK bridge in `realtime-session-target.ts`, and approval-gated mutations are all
implemented (`docs/ARCHITECTURE.md` §`realtime-gateway.ts`).

What is **not** yet on record is whether it clears the bar people mean when they say
"like ChatGPT desktop voice": sub-second feel, and the ability to actually drive a
coding session by talking. `docs/realtime-readiness-evidence.md` covers reconnection,
buffering, AEC/NS, VAD, barge-in and TTS fallback — but it contains **no latency
numbers** and **no spoken-request-to-OMPK-tool-call round trip**.

This file lists what to look for and, only where a gap is confirmed, what to implement.
Work it top-down: A (measure) before C (change), because most "it feels laggy" bugs
turn out to be one identifiable stage.

---

## Run metadata

```text
Date:           2026-07-29
Operator:       OMPK automated operator
Backend:        Gemini Live / gemini-live-2.5-flash
Surface:        /orb/; authenticated /v1/live client; Android Standard and Boox installation checks
Audio device:   Chromium media stream with an injected spoken TTS prompt; physical devices were keyguard-locked
Network path:   local loopback; USB/ADB for Android installation
Commit:         working tree under test (commit not queried)
```

---

## A — Measure the feel (do this first, change nothing)

The defining metric is **time to first audio out** after the user stops speaking.
ChatGPT desktop lands ~300–800 ms. Anything over ~1.5 s reads as walkie-talkie.

### Instrumentation status (2026-07-29)

The A1/A2 capture path now exists, but **the live acceptance run is still
unmeasured**. Do not read unit/simulator tests as evidence of ChatGPT-like feel.

Set `PI_SPEAK_REALTIME_METRICS=1`, restart the gateway, open `/orb/` or Live mode
in `/app/`, and collect browser-console lines prefixed
`[pi-speak-voice-metric]`. A `kind:"turn"` line contains all five timestamps,
backend/model identity, `timeToFirstAudioMs`, `upstreamInferenceMs`, and
`localBufferMs`; its rolling summary contains p50/p95. The first-render timestamp
comes from the AudioWorklet audio clock and is mapped with
`AudioContext.getOutputTimestamp()`; `renderTimestampSource:
"main-thread-fallback"` must be called out if the browser lacks that API.
`kind:"barge_in"` records speech onset through audio-thread clear/fade completion
and marks the `<200 ms` threshold.

Run at least 20 spoken turns and several barge-ins for **each actual
backend/model/configuration**. Preserve the final line for each run in the parity
table below. Current code-level evidence proves event wiring and cancellation
semantics only; it does not supply real microphone, device, network, or provider
latency.

### A1 — Instrument the turn pipeline

Capture per-turn timestamps at these five points and log them as one structured line:

1. VAD speech-end detected (client)
2. Last PCM frame sent upstream
3. First upstream token/audio event received
4. First PCM sample enqueued into `live-playback-worklet.js`
5. First sample actually rendered

Pass: p50 and p95 recorded for ≥20 turns per backend.
Look for: whether the gap lives in upstream inference (3−2) or local buffering (5−4).
The second is ours to fix; the first is a backend/model choice.

### A2 — Barge-in latency

Measure from user speech onset to playback silence. `{kind:"clear"}` wipes the ring
buffer, so this should be near-instant; if it is not, suspect the noise gate's dBFS
threshold delaying onset detection rather than the clear itself.

Pass: < 200 ms, no audible tail.

### A3 — Backend parity table

Run A1/A2 for `gemini` and for `openai-realtime`/`hf`. Record both.
Note: OpenAI-Realtime has **no** Gemini `resumptionHandle` — reconnect is a clean
upstream re-dial, so its post-drop latency is expected to be worse. Quantify it.

| Backend / model / VAD profile | Turns | p50 first audio | p95 first audio | p95 upstream | p95 local buffer | Barge-in p95 / audible tail | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| Gemini Live / gemini-2.0-flash-exp / server_vad | 0 | — | — | — | — | — | **UNMEASURED** |
| OpenAI-Realtime / gpt-4o-realtime-preview-2024-12-17 / server_vad (default) | 0 | — | — | — | — | — | **UNMEASURED** |
| OpenAI-Realtime / gpt-4o-realtime-preview-2024-12-17 / semantic_vad (low eagerness) | 0 | — | — | — | — | — | **UNMEASURED** |
| OpenAI-Realtime / gpt-4o-realtime-preview-2024-12-17 / semantic_vad (high eagerness) | 0 | — | — | — | — | — | **UNMEASURED** |

### Capability review: interruption and pauses

- **Client-detected barge-in:** `/app/` and `/orb/` clear the playback worklet
  immediately when speech energy crosses the interruption threshold. The
  audio-thread completion metric now measures the tail after queue clear and its
  32-frame click-suppression fade, rather than main-thread message latency.
- **OpenAI-Realtime/HF cancellation:** speech-start and explicit interrupt both
  issue `response.cancel`; the last assistant audio item is truncated to the
  estimated amount actually heard. The user's input buffer is deliberately not
  cleared, so the opening word of the interjection is retained. Compatible
  third-party endpoints must support the GA truncate event to provide identical
  conversation-memory behavior.
- **Gemini cancellation:** client barge-in suppresses remaining stale assistant
  audio at the gateway. Gemini's automatic activity detection supplies the
  canonical upstream `interrupted` event when speech arrives. The gateway no
  longer sends `activityStart` while automatic VAD is active (an invalid protocol
  combination).
- **Mid-thought pauses:** this is upstream turn detection, not a client pause
  stitcher. Operators can choose OpenAI-compatible `semantic_vad` and tune
  eagerness, or use silence-duration/eagerness controls translated into each
  defaults remain the historical provider defaults, and real live pause-tolerance quality remains **UNMEASURED** until live browser audio campaigns are completed.
- **Model/configuration breadth:** the shared profile is backend-neutral.
  `PI_SPEAK_GEMINI_LIVE_MODEL`, `PI_SPEAK_GEMINI_LIVE_VOICE`,
  `PI_SPEAK_OPENAI_REALTIME_MODEL`, `PI_SPEAK_OPENAI_REALTIME_VOICE`, and custom
  compatible WebSocket URLs select distinct models/voices without changing the
  client protocol. This is not an OpenAI-only implementation.

---

## B — Prove voice actually drives OMPK (the real differentiator)

Tool calling exists; a demonstrated end-to-end voice→session→result loop does not.
This is the part that makes it more than a talking search box.

### B1 — Spoken request to a real session

With a live OMPK session running, say a question that requires the session's context
(for example: *"in the environments-cloud session, what changed in the last commit?"*).

Pass: `dispatchRealtimeToolCall` fires, the answer reflects the session's real state,
and it is spoken back. Capture the tool-call payload alongside the transcript.

### B2 — Session targeting resolution

`realtime-session-target.ts` merges dashboard, attention-heartbeat and Agent Hub
identities, prefers exact IDs then canonical paths, names and aliases, and is
documented to **fail explicitly on ambiguous fragments**.

Verify by voice, not just unit test:
- exact session id → resolves
- unique name → resolves
- alias / compact route (`one`, `two` per `docs/VOICE_SESSION_BRIDGE.md`) → resolves
- deliberately ambiguous fragment → **fails loudly**, does not silently pick one

Pass: the ambiguous case produces a spoken clarification, never a guess.
This is a safety property: a wrong guess here runs a command in the wrong repo.

### B3 — Target isolation across connections

The chosen target is stored per live connection, never in the global routing target.
Open two live clients, point them at different sessions, and confirm neither
reassigns the other.

Pass: no cross-talk.

### B4 — Approval gate on mutations

`ControlServer.realtimeBridge` exposes trusted in-process actions, but realtime
dispatch must invoke mutations **only after command approval**, and the orb handles
`tool_approval_*` without opening `/app/`.

Verify by voice:
- a read (list sessions, read a file) → no prompt
- a mutation (write, run, kill) → approval prompt appears **before** anything happens
- reject → nothing executed, said out loud
- approve → executes once, not twice

Pass: no mutation path reaches execution without an approval event in the log.
Look hard for a bypass: this is the highest-consequence property in the whole stack.

### B live verification result — 2026-07-29

| Criterion | Result | Observed evidence |
|---|---|---|
| B1 spoken request | **PASS** | A TTS prompt was injected through the live microphone stream. The provider transcript (`Use getsessioninfo...`) dispatched `get_session_info`; raw `tool_complete` data returned selected target `pi-speak1`, session ID `1f02101a73e97a3c`, and `C:\dev\desktop-projects\pi-speak-extension`. The assistant repeated that session-specific result while the client reported `Speaking` and received 57 binary audio frames (639,588 bytes). |
| B2 target resolution | **PARTIAL** | Exact ID resolved with `match:"session-id"`; unique name `envcloud1` resolved with `match:"name"`; fragment `lane` returned `code:"ambiguous"` with four candidates and a spoken clarification instead of choosing. No `one`/`two` alias was configured in this runtime, so the model asked for clarification and the compact-route success case remains unverified. |
| B3 connection isolation | **PASS** | Two simultaneous `/orb/` WebSocket sessions selected different targets. Follow-up `get_session_info` calls returned `selectedForConnection:true` for `envcloud1` (`5e1715cd763b7bfd`) and `pi-speak1` (`1f02101a73e97a3c`) respectively; neither selection changed the other. |
| B4 mutation approvals | **PARTIAL — gate passed** | Read-only `get_session_info` ran without approval. `npm install --ignore-scripts` emitted `tool_approval_required` before execution; rejection produced one rejected `tool_complete` and the assistant said it was not executed. An approved `send_session_message` emitted exactly one `tool_approval_resolved` and one `tool_complete`; the trusted bridge then aborted safely because the target identity had changed. The no-bypass and no-duplicate properties passed, but a successful mutating side effect was intentionally not forced. |

The `/orb/` client used for this run now includes a compact text composer. It is
disabled until the live `start` event, sends `{type:"text"}` without disconnect
fallbacks, renders one immediate user bubble, and suppresses the matching provider
echo. Live submission, input clearing, exact-once bubble rendering, and disconnected
disablement were exercised in this run.

---

## C — Robustness gaps not covered by existing evidence

### C1 — Audio device change mid-session
Unplug/swap headset while streaming. Existing evidence covers network drops, not
device changes.
Pass: capture and playback re-bind, or fail with a spoken message. No silent deafness.

### C2 — `audio_format` renegotiation
The start announcement defaults to 24 kHz and Android has
`StreamingPcmPlayer.setSampleRate`. Confirm a mid-session change is honoured on
desktop too, not only Android.

### C3 — Long-turn behaviour
A tool call that takes 30 s+ (a real build or test run). Gemini `NON_BLOCKING` slow
tools are developer-API only — **Vertex blocks them** — so on Vertex the session may
stall silently.
Pass: the assistant says something ("still running") rather than going quiet, on every
backend/API combination actually in use.

### C4 — Failure voice
Kill the upstream mid-turn. The user should hear a failure, not silence.


### C live/source verification result — 2026-07-29

| Criterion | Result | Observed evidence |
|---|---|---|
| C1 device change | **GAP CONFIRMED** | Desktop clients have no `devicechange` listener or media-stream reacquisition path. A physical unplug campaign was not performed in this continuation, but current code cannot meet the rebind-or-spoken-failure requirement. |
| C2 format renegotiation | **GAP CONFIRMED** | `audio_format` is handled by clients, including Android sample-rate reset, but the gateway emits it only during initial setup; no mid-session producer path was found or exercised. |
| C3 long tool | **GAP CONFIRMED** | After replacing raw Windows `spawn` with the existing shell-safe `safeSpawn`, an authenticated Gemini Live (`gemini-live-2.5-flash`) client ran `npm test` through `execute_terminal_command`. `tool_start` arrived 361 ms after the text request and `tool_complete` arrived 100,383 ms later. No interim assistant transcript or binary audio arrived during that interval; the first response text started 276 ms after completion. The live backend therefore stayed silent for the full long-running call. |
| C4 upstream failure voice | **GAP CONFIRMED** | Upstream errors/disconnects update UI/log state, but there is no client or gateway speech fallback that can vocalize the failure after the upstream voice provider is gone. |

### Interrupted assistant audio replay follow-up

Web, Standard Android, and Boox now retain a bounded, client-local PCM snapshot for
the active assistant segment. An interrupt freezes that snapshot and exposes a local
Replay control; replay never sends a WebSocket message or replays tools. Android owns
interrupt coordination and replay availability per live session, rejects replay while
streaming writes or queued PCM remain, and atomically releases a replay before writing
new accepted provider PCM. Duplicate/out-of-order frames cannot steal replay ownership.

Deterministic verification passed:

- `node --test tests/interrupted-audio-replay.test.mjs` — 5/5.
- `:app:testStandardDebugUnitTest --tests com.example.audio.InterruptedPcmBufferTest`.
- `:app:compileBooxDebugKotlin`.
- `:app:assembleStandardDebug :app:assembleBooxDebug`.
- Final adversarial replay-lifecycle re-audit — **PASS** after queued-audio,
  session-replacement, provider-preemption, and early-return ownership fixes.
- Standard APK SHA-256:
  `6d5dd58e2a6b5c1746aac686907bc5aceacc4502fa1ad2eac6c7a29effa049a8`.
- Boox APK SHA-256:
  `f68285506333fbcf32cd0956d37682aa14a38e1688fc31966aae79a88bc29a04`.
- Final APK installation and cold launch succeeded on Pixel 9a `55181JEBF00791`
  and Boox Palma `67E811DD`; APKs pulled from both devices matched the packaged
  files byte-for-byte. `/download/pi-speak.apk` also matched the Standard APK.

An audible replay tap-through on those two physical devices remains **UNVERIFIED**.
Pixel is now unlocked, authenticated, and connected to `/v1/live` through
`adb reverse`, but the host-played TTS prompt did not produce a live assistant
turn, so no replay was claimed. Palma remains behind secure keyguard, which ADB
cannot dismiss.

---

## D — Only if A–C find gaps

Do not start here. Likely candidates, in the order they usually pay off:

1. **Playback buffer trimming** — if 5−4 dominates in A1, the ring buffer is
   over-buffering; reduce prefill at the cost of underrun risk.
2. **Noise-gate tuning** — if A2 is slow, the dBFS threshold is gating speech onset.
   Settings controls already exist; find defaults rather than adding knobs.
3. **Speculative turn start** — begin upstream send before VAD end-of-speech.
   Meaningful latency win, but it changes barge-in semantics; do this last.

---

## Explicitly out of scope

- **Do not add voice to `handoff-bot`.** That Telegram bot is text-only by design
  (`handleTelegramMessage` reads `message.text` and nothing else). Realtime voice
  belongs here, where the transport already exists. If the two should share session
  management, factor the OMPK session layer out — do not duplicate a voice pipeline
  into a polling Telegram bot.
- No new upstream backends until A3 shows the two existing ones measured.

---

## Related

- `docs/ARCHITECTURE.md` — `realtime-gateway.ts`, `live-backend.ts`, `openai-realtime-live.ts`
- `docs/realtime-readiness-evidence.md` — resilience/barge-in evidence (no latency data)
- `docs/VOICE_SESSION_BRIDGE.md` — wake phrases and compact numeric routing
- `docs/REALTIME_VOICE_FEEL_IMPL_PROMPT.md`, `docs/SESSION_NAVIGATION_VOICE_PLAN.md`
- `wiki/syntheses/realtime-live-hf-parity-2026-07-20.md` — Live/HF parity baseline
