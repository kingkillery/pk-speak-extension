# Extended Agent Reference - pi-speak-pk Extension

This is the on-demand companion to the root `AGENTS.md`. It keeps the detailed file map, behavior notes, test topology, and KADE/wiki procedures out of the always-injected context. Read only the sections relevant to the current task.

Extension development context for `pi-speak-pk` — a conversational assistant for pi-coding-agent, reachable over voice, wake-word, phone, and browser/Android remote.

The assistant (`realtime-gateway.ts`) has broad read-only access to sessions, background agents, and the workspace on every turn (workspace reads stay confined to `PI_SPEAK_WORKSPACE_ROOT`, are capped in size, and refuse secret-shaped paths), but never mutates anything without explicit operator approval. See "Conversational Assistant Mode" in `README.md` and the approval-flow notes below.

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
| `server-app.ts` | `pi-speak-server` — one-command desktop app: ensures the gateway, opens the loopback-only `/connect` pairing window (Edge app mode), `--install-shortcut` for Desktop/Start Menu |
| `pairing.ts` | Shared pairing primitives: persistent install auth token (`%LOCALAPPDATA%/pi-speak/http-token`) + phone-facing base-URL discovery (Tailscale-first); used by the control server, tray, and server app |
| `voice-routing.ts` | Normalized route matching, compact numeric route families, and conflict helpers |
| `session-routing.ts` | Session naming, alias helpers, summaries, removal helpers, and the `buildSessionDashboard` selector shared with the pane |
| `session-transfer.ts` | Portable session bundles: git capture/restore, ssh send/inbox, `captureGitSummary` + `buildSessionManifest` for `GET /v1/sessions/manifest` |
| `session-worktree.ts` | Per-session git worktrees for secondary-host pickup (`/sess pickup --worktree`): bare base clone per remote, fetch-at-invoke hydration, lease-based sweep with dirty-work rescue |
| `gateway-discovery.ts` | Host-assisted tailnet gateway roster (`GET /v1/gateways`): parses `tailscale status --json`, probes online peers' `/.well-known/pi-speak` |
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
| `tts.ts` | Multi-provider TTS (edge, gemini, openai, elevenlabs, legacy) |
| `stt.ts` | Remote voice transcription |
| `phone-bridge.ts` | Telegram transport |
| `control-server.ts` | HTTP API + mobile web app server |
| `agent-hub-dashboard.ts` | Scans Oh-my-pk session roots and merges active background lanes into the route dashboard; also `findOhMyPiBackgroundSessionPath` for resolving an archived lane's name back to a file |
| `agent-hub-actions.ts` | Pure helpers: `archiveOhMyPiBackgroundSession`, `buildOhMyPiLaunchArgv` for `/v1/sessions/launch` and `/v1/sessions/remove` |
| `herdr-agent-hub-gateway.ts` | `AgentHubGateway` — chat/kill/revive/stream request handling for `/v1/herdr/agent*`, shared by every `AgentHubBinding` (disk-only fallback or live) |
| `herdr-agent-hub-live.ts` | The real (mutating) `AgentHubBinding`: chat submits a normal turn targeted at the lane's name, kill archives it, revive recovers it — no invented IPC with the external oh-my-pk binary |
| `realtime-gateway.ts` | Live conversational assistant on `/v1/live`: `REALTIME_SYSTEM_PROMPT`, `buildRealtimeTools` / `dispatchRealtimeToolCall` (session/hub/workspace reads + `web_search` + `camera_snapshot` + approval-gated mutations). Default upstream HF speech-to-speech (OpenAI-Realtime wire) when an S2S URL (`PI_SPEAK_HF_REALTIME_URL` / `HF_REALTIME_URL` / `SPEECH_TO_SPEECH_URL` / `PI_SPEAK_S2S_URL` / `PI_SPEAK_OPENAI_REALTIME_URL`) or `PI_SPEAK_LIVE_BACKEND=hf\|openai-realtime\|s2s` is configured; Gemini Live fallback otherwise (explicit `gemini` always wins), via `live-backend.ts`. |
| `live-backend.ts` | Live upstream kind selection (`openai-realtime` \| `gemini`; S2S URL presence defaults to HF speech-to-speech) and shared adapter contracts. |
| `openai-realtime-live.ts` | OpenAI-Realtime / HF S2S adapter; connect URL from `PI_SPEAK_HF_REALTIME_URL` / `HF_REALTIME_URL` / `PI_SPEAK_OPENAI_REALTIME_URL` / `SPEECH_TO_SPEECH_URL` / `PI_SPEAK_S2S_URL`, defaulting to `ws://localhost:8765/v1/realtime`. |
| `web-search.ts` | Serper-backed `web_search` helper and `/v1/search` proxy (env-only keys). |
| `desktop-live-client.ts` | Opens the terminal Live companion; defaults to `/orb/` (Edge `--app`), optional full `/app/` surface. |
| `web/remote/orb.*` | Desktop orb UI + HF-style worklet Live client for terminal operators. |
| `web/remote/live-*-worklet.js` | Capture (Int16@16kHz + noise gate) and playback (ring buffer + barge-in clear) AudioWorklets. |
| `realtime-terminal-approval.ts` | Original terminal-command approval registry used by the realtime gateway |
| `realtime-command-approval.ts` | Extended approval registry covering terminal, chat, kill, and launch command proposals. |
| `listener/listener.py` | Always-on wake-word listener (faster-whisper wake detection + transcription) |
| `realtime-terminal-approval.ts` / `realtime-terminal-command.ts` | Approval registry + safety classifier for `execute_terminal_command` (raw shell command, read-only allowlist vs. confirm) |
| `realtime-speech-brief.ts` | Pure speech shaper for the model-facing tool response: clips dumps, adds `summary`/`speechHint`, so Live *discusses* results instead of reciting them. The client `tool_complete` keeps the full payload. |
| `voice-mode.ts` | Unified voice-layer toggle (`off`/`tts`/`stt`/`combo`/`realtime`) over the TTS, wake-listener, and Live switches. `combo` = turn-based; `realtime` = full-duplex via `/v1/live` (+ desktop orb). |
| `gemini-live-simulated.ts` | In-process simulated Gemini Live backend (`PI_SPEAK_GEMINI_BACKEND=simulated`): keyless deterministic Live for CI. |
| `dist/omp-index.js` | Bun-bundled single-file extension entry for loading under the **compiled oh-my-pk binary** (`npm run build:omp-bundle`). The compiled Bun resolver never consults external `node_modules` for extension files (not via walk-up, junctions, or NODE_PATH), so ompk-loaded extensions must have zero bare runtime imports. Point `~/.omp/agent/config.yml` `extensions:` at this file, not `dist/index.js`. Upstream pi loads `dist/index.js` directly and resolves deps normally. |

## TTS Provider Logic

Auto-resolution order:
1. `legacy` — local speak11 (requires Python deps)
2. `gemini` — requires Google API key or Vertex AI configuration
3. `elevenlabs` — requires `ELEVENLABS_API_KEY`
4. `openai` — requires `PI_SPEAK_OPENAI_KEY` (dedicated, not general LLM key)
5. `edge` — works immediately (bundled `node-edge-tts`)

## Important Patterns

- **API keys for audio**: Use dedicated keys (`PI_SPEAK_OPENAI_KEY`, `ELEVENLABS_API_KEY`) or Google Gemini/Vertex credentials for Gemini TTS
- **Edge TTS**: Bundled via `node-edge-tts`, no external deps needed
- **Local voice (`/mono`)**: Requires Python stack with `faster-whisper`, `sounddevice`, `numpy`
- **Wake sensitivity**: Use `PI_SPEAK_WAKE_SENSITIVITY=low|medium|high` as the main operator control for how forgiving `PK` activation should be; use the lower-level fuzzy and compact env vars only as overrides
- **Short numeric routes**: Keep `one/1` and `two/2` as distinct voice families. `PK one` / `PK1` should stay separate from `PK two` / `PK2`, while multi-word names like `PK to Google` must stay literal.
- **Operator UX**: `/sess` should surface the compact-lane summary inline, `/sess slots` should show the explicit PK1/PK2 lane ownership view, and `/sess ui` should launch the Ink management pane in a separate terminal so it does not steal the pi-coding-agent TTY.
- **Phone setup UX**: `/pk-remote` is the shortest Android setup path. It should start the HTTP gateway if needed, choose public/Tailscale/LAN URLs in that order, and print a QR for the native `pi-speak://setup` deep link.
- **Android control-surface parity**: the native app mirrors the web remote against the same gateway endpoints — session mutations (`/v1/sessions/rename|alias|archive|remove`), route target (`/v1/route`), compact slots (`/v1/sessions/slots`), agent discovery (`/v1/agents`), the SSE event feed (`/v1/events`), and the workspace file viewer (`/v1/workspace/file`). Client parsing lives in `android-app/.../api/GatewayOps.kt` (pure, unit-tested) and the SSE tail in `api/GatewayEventStream.kt`; when a new gateway endpoint is added for the web remote, extend those instead of burying JSON parsing in `MainActivity.kt`.
- **Agent Hub portal (Tasks pane)**: the hierarchical lane → subagent tree, chat/archive, and general task launcher live behind `/v1/herdr/agent*` + `/v1/sessions/launch`. Android models/parsers are `api/GatewayHub.kt`, the per-agent SSE tail is `api/HerdrAgentStream.kt`, and both flavors' UI lives in `HubPortalComposables.kt` (standard) and inline in `BooxMainActivity.kt`'s `HubPane`/`HubSessionRow` (e-ink). Revive is intentionally NOT wired into either UI: an archived lane is invisible to the same dashboard scan that lists agents, so there is no reachable state in this tree from which reviving would find anything — `VoiceAgentClient.reviveHubAgent` stays available for a future surface that tracks archived-lane names persistently.
- **Agent hub launch**: `POST /v1/sessions/launch` spawns a fresh Oh-my-pk agent via `ompk --cwd <dir> [--model/--provider/--session-dir] -- <prompt>` or opens the Agent Hub via `ompk bg` (`hubOnly: true`). Defaults to `AGENT_CWD` → `AGENT_WORKSPACE` → `process.cwd()` when the payload omits `cwd`, so set `AGENT_CWD=C:/dev/Desktop-Projects/oh-my-pk-fork` (or use the Boox/PWA UI which sends the workspace cwd) to land in the fork. The argv is built by `buildOhMyPiLaunchArgv` (testable in `tests/agent-hub-actions.test.mjs`); the spawn helper in `index.ts` reuses the resume pattern and appends a `sess.launch` event. Legacy `oh-my-pi`/`omp` provider names and env vars remain accepted as aliases.

- **Workspace browse + file read**: The PWA Workspace tab uses `GET /v1/workspace?path=...` (lists a directory; `entries` now include files as well as directories with `name`/`path`/`type` and `size` on files) and the read-only `GET /v1/workspace/file?path=...` (returns `name`/`path`/`size`/`truncated`/`binary`/`content`, capped at the first 512 KB, empty content for binary files). Both are confined to `PI_SPEAK_WORKSPACE_ROOT`, which **defaults to the agent working directory** (`getDefaultWorkspacePath`: `AGENT_CWD`/`AGENT_WORKSPACE`/`process.cwd()`) rather than the whole drive, since the file endpoint reads file contents under that root; set it to a directory to widen, or to `fs` for the drive root. Containment uses a lexical `..` guard plus a realpath check (symlinks/junctions resolving outside root are rejected), the listing is streamed and capped at 2000 entries (`truncated` flag), and Windows reserved device names (CON/NUL/COM1…) are rejected. These expose the `workspace-browse` and `workspace-file-read` capabilities; "Use this folder" sets the launch `cwd` for turns. Endpoints/capabilities live in `control-server.ts` (`/v1/workspace`, `/v1/workspace/file`).
- **Pane write path**: All pane-driven mutations flow through `loadPersistedSessionRouting` → pure helper in `session-routing.ts` → `persistSessionRouting` → `appendSessionEvent(kind, "admin", payload)`. The extension watches the routing store mtime and reloads in-process state on external writes.
- **Conversational assistant approval boundary**: session discovery and connection-local `switch_session` are read-only. `send_session_message`, `resume_session`, `launch_agent`, `kill_agent`, `revive_agent`, `archive_session`, and non-allowlisted `execute_terminal_command` defer their model response, emit `tool_approval_required`, and execute only after the matching `command_approve`/`command_reject` or `terminal_approve`/`terminal_reject`. `ControlServer.agentHubGateway` remains a runtime read-only facade; the separate trusted `ControlServer.realtimeBridge` exposes mutations for the approval-gated dispatcher only. All request, approval, and result steps go to `realtime-terminal-audit.ts`.
- **Discuss-don't-recite shaping**: every model-facing FunctionResponse goes through `shapeRealtimeToolOutputForSpeech` (`realtime-speech-brief.ts`) inside `sendRealtimeToolResponse`. Large payloads (terminal stdout/stderr, workspace file content, agent transcripts, dashboard lists) are clipped to voice-sized previews with a `summary` + `speechHint` so the model talks *about* results instead of reading dumps. The client `tool_complete` message always carries the full raw payload — never strip fields from that. Explicit `opts.response` overrides (progress/done markers) skip shaping by design.
- **Remote audio**: Browser mic requires HTTPS origin (use Tailscale Serve or tunnel)
- **Simulated realtime backend**: `PI_SPEAK_GEMINI_BACKEND=simulated` makes `createGeminiClient({live:true})` return `createSimulatedLiveClient` (`gemini-live-simulated.ts`) so the whole `/v1/live` stack — gateway, clients, approval flows — runs keyless and deterministic. Never inferred implicitly; `isGeminiLiveConfigured()` reports true (voice UI arms) while `isGeminiLiveSimulated()` excludes the conversation reducer's Gemini fallback and the status line shows `· sim`/`SIMULATED backend`. Text-turn factory calls throw a clear "Live sessions only" error under simulated. Ordering law matches the real API: transcription → audio parts (`audio/pcm;rate=24000`) → `generationComplete` → `turnComplete`; barge-in emits `interrupted` → `turnComplete` with no `generationComplete`. Unit tests: `tests/gemini-live-simulated.test.mjs`; the no-module-mocks integration proof is `tests/integration/simulated-live-gateway.test.mjs`.

## Testing

```bash
npm test               # Non-local auth, rate limiting, body size, audio expiry, etc.
npm run test:realtime-live   # End-to-end: real handleRealtimeGateway dispatch against a fake Gemini Live connection
```

`npm test` (`tests/*.test.mjs`) covers plenty of real integration behavior generally (non-local auth, rate limiting, body size, audio expiry, etc.), but for the realtime conversational-assistant gateway specifically it only covers pure helpers in isolation — e.g. `buildRealtimeTools`, `isNavigationalLaunch`, `looksLikeSecretPath`, the approval registries. It does not exercise the actual onmessage tool-call switch in `realtime-gateway.ts`. `npm run test:realtime-live` (`tests/integration/*.test.mjs`, requires Node's `--experimental-test-module-mocks`, kept out of the default `tests/*.test.mjs` glob on purpose) fakes `@google/genai`'s `GoogleGenAI`/`live.connect` and drives the real `handleRealtimeGateway` entrypoint end to end: a read-only tool call answers immediately with no approval step; a mutating call (`launch_agent`/`archive_session`) defers behind `tool_approval_required` and only actually runs after a `command_approve` control message, never after `command_reject`; approvals/executions land in the real on-disk audit trail; `read_workspace_file` refuses a secret-shaped path without touching disk and returns real content for an ordinary one. Extend this file (not just the pure-helper tests) when changing the approval-gating wiring itself, not just the logic it calls.

## Release

```bash
npm run prepublishOnly   # Builds before publish
npm publish              # Publishes to npm
```

<!-- llm-wiki-prompt-packet:agents-guidance:start -->
## KADE-HQ, Memory, and Retrieval Routing

Use this workspace as a KADE-HQ-backed memory workspace. Treat `AGENTS.md`, `LLM_WIKI_MEMORY.md`, `.llm-wiki/config.json`, `wiki/`, and `kade/` as the operating contract for future agent work.

### Startup Routing

- Read `AGENTS.md` first, then `LLM_WIKI_MEMORY.md`, then `.llm-wiki/config.json` before substantive work.
- If this is a KADE-enabled workspace, also read `kade/AGENTS.md` and `kade/KADE.md` when present.
- Load `~/.kade/HUMAN.md` when present for user/workflow preferences, but prefer project-local instructions when they conflict.
- Run `scripts/setup_llm_wiki_memory.ps1` or `scripts/setup_llm_wiki_memory.sh` if required memory/retrieval tools are missing.

### Retrieval Order

- Use `pk-qmd` first for source-backed repo, prompt, note, and wiki evidence when the right file or concept is not already known.
- Use Obsidian MCP tools for wiki note reads, writes, moves, and tag updates when available; fall back to direct file I/O only against the configured vault path when Obsidian is unavailable, and record that fallback in `wiki/log.md`.
- Before creating or accessing an Obsidian vault, confirm the vault path is established by `.llm-wiki/config.json`, MCP settings, environment variables, or current user instruction. If no vault path is established, ask the user where to create or access it. Do not silently use the current repo as an Obsidian vault.
- Proactively offer to save source-backed findings to Obsidian when they are likely to be useful later, especially research-paper notes, prior-art reviews, resolved investigations, durable decisions, and reusable procedures.
- Treat `agent-cli-obsidian` as the recommended Obsidian behavior layer for wiki save/query/autoresearch conventions; treat `mcpvault` or `mcp-obsidian` as the lower-level vault transport.
- Use `llm-wiki-skills` for reusable skill lookup, reflection, validation, evolution, and retirement.
- Use BRV only for durable preferences, repeated workflow quirks, and decisions; do not rely on it when no provider is connected.
- Use GitVizz for repo topology, API surface, route relationships, and graph-oriented navigation after retrieval has identified the likely area.
- Prefer current source evidence over memory when sources and memory conflict.
- Start with `llm-wiki-packet context --task "..."` for a compact task bundle; use `llm-wiki-packet evidence --query "..."`, `llm-wiki-packet evidence --plane source --query "..."`, or `llm-wiki-packet context --mode deep` only when broader hybrid/source search is useful.
- For graph-heavy work, prefer configured `gitvizz.repo_id`; if GitVizz reports auth-required, use the configured auth env vars or treat graph results as degraded hints.
- Treat Hugging Face embedding/reranking settings as optional disabled-by-default planner hints, not required bootstrap tools.

### KADE-HQ System Use

- Treat KADE-HQ as the human/profile and workspace-orchestration layer, not as a replacement for project instructions.
- Treat `g-kade` as the bridge/router across KADE-HQ, G-Stack workflows, and this packet.
- Use G-Stack workflows for review, QA, debugging, browser dogfooding, deployment verification, and ship-readiness checks when the corresponding skill/runtime is installed.
- Keep the root packet files as the source of truth for memory/retrieval wiring; keep KADE-specific handoff state under `kade/`.

### Natural-Language Help

- If the user asks how to use this tool, what it can do, how to install it, how to save to the wiki, how to use Obsidian, or what command to run next, answer directly in plain language.
- Do not require the user to remember internal script names, MCP server names, or slash commands.
- Mention `/wiki-help` as the optional shortcut, but treat ordinary requests like "help me use this", "what can this do?", and "how do I save this?" as valid help requests.
- For install help, show exactly one command for the user's current shell unless they ask for alternatives.

### Memory Writes

- Write durable repo knowledge to `wiki/` pages, not chat-only memory.
- Good answers and insights should not disappear into chat history. After a substantial answer, especially research or analysis, offer to save it; for deep research, saving should be the default unless the user opts out.
- If Obsidian/wiki persistence would be useful but the vault path is unconfigured, ask for the vault location before saving.
- Use the Obsidian wiki note taxonomy: `synthesis`, `concept`, `source`, `decision`, and `session`; for research use source/entity/concept/question pages plus a synthesis page when useful.
- For research and investigation tasks, offer to write an Obsidian/wiki note that preserves the source citation, what was learned, why it mattered, caveats, and follow-up questions.
- Write reusable procedures as skill artifacts under the configured skill lifecycle, not ad hoc notes.
- Keep raw immutable sources under `raw/`; never edit `raw/` unless explicitly asked.
- Update `wiki/index.md` when adding or moving durable pages.
- Update `wiki/log.md` for meaningful wiki changes, tool fallbacks, setup changes, and unresolved questions.
- For long-running harness work, use `llm-wiki-packet manifest`, `context --run-id`, `evidence --run-id`, `reduce`, `evaluate`, `promote`, and `improve` so artifacts, retrieval metadata, memory promotion, and self-improvement gates share the same run id.
<!-- llm-wiki-prompt-packet:agents-guidance:end -->
