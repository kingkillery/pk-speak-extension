# AGENTS.md - pi-speak-pk Extension

Extension development context for `pi-speak-pk` — a conversational assistant for pi-coding-agent that uses voice, wake-word, and remote-control as input channels. The assistant can read all subagent state and the workspace, interview the user to scope work, and propose commands that only execute after explicit approval. Voice (`/mono`, `PK` wake phrase), Telegram (`/phone`), and the mobile/web remote (`/remote`, `/pk-remote`) are all ways to reach the same assistant.

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
| `realtime-gateway.ts` | The conversational assistant core. Runs a Gemini Live session with read-only subagent/workspace tools (`list_agents`, `get_agent`, `read_transcript`, `list_workspace`, `read_workspace_file`) and a `propose_command` approval flow. Voice, phone, and remote turns all reach this assistant. |
| `realtime-terminal-approval.ts` | Original terminal-command approval registry used by the realtime gateway |
| `realtime-command-approval.ts` | Extended approval registry covering terminal, chat, kill, and launch command proposals. `propose_command` stages a mutation and returns a confirmation token; the assistant only executes after the user approves. |
| `listener/listener.py` | Always-on wake-word listener (faster-whisper wake detection + transcription) |

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
