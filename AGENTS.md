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
- **Phone setup UX**: `/pk-remote` is the shortest Android setup path. It should start the HTTP gateway if needed, choose public/Tailscale/LAN URLs in that order, and print a QR for the native `pi-speak://setup` deep link.
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
