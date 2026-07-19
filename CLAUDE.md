# CLAUDE.md - pi-speak-pk

Use this file as a quick repo-local operating guide for the pi-speak conversational assistant and its voice/multi-session control surfaces. The assistant is the center; voice (`/mono`, `PK` wake phrase), Telegram (`/phone`), and the mobile/web remote (`/remote`, `/pk-remote`) are input/output channels that reach the same assistant.

## Start Here For Conversational Assistant Work

When the task involves the realtime assistant persona, the `propose_command` approval flow, read-only subagent/workspace tools, or how voice/remote turns reach the assistant, read these first:

1. `realtime-gateway.ts` — assistant core, tool definitions, `propose_command` handling
2. `realtime-command-approval.ts` — approval registry for terminal/chat/kill/launch proposals
3. `README.md` — the conversational assistant thesis and how the input channels map to it
4. the relevant source file

## Start Here For Natural Voice Control Work

When the task involves spoken replies, wake-word listening, voice session routing, the `/sess` session manager, session naming, wake aliases, or compact routes like `PK one` / `PK1`, read these first:

1. `docs/VOICE_SESSION_BRIDGE.md`
2. `docs/SESSION_OPERATIONS.md` for `/sess`, wake aliases, and multi-session operator flows
3. `docs/AGENT_SPEAK.md` for `/speak agent`, the `pk-speak` CLI, and `PK_SPEAK_PREAMBLE` wiring
4. `README.md`
5. the relevant source file

`SKILL.md` is intentionally a pointer file.

## What This Repo Optimizes For

<<<<<<< HEAD
- a conversational assistant that reads subagent state and proposes commands for approval
- natural spoken interaction as one input channel among several
=======
- a conversational assistant with broad read-only access to sessions, background agents, and the workspace (workspace reads confined to the workspace root, capped, secret-shaped paths refused), but no mutation without explicit operator approval
- natural spoken interaction
>>>>>>> origin/main
- command-backed control surfaces
- safe multi-session routing
- one primary session-manager abstraction for normal operators
- deterministic short voice routes for `one/1` vs `two/2`
- explicit operator commands when behavior must stay deterministic

## Core Command Families

- `/speak` → spoken replies; `/speak agent` for agent-driven speech via `pk-speak` (no auto-watcher, no rewrite pass)
- `pk-speak` CLI → synthesize and play text from any shell; the mechanism the agent calls in `/speak agent` mode
- `pk-speak-mcp` → optional stdio MCP server (bin); thin adapter over the CLI for clients where the Bash tool is unavailable; one `speak` tool, input `{ text, voice? }`
- `/mono` → wake-word listener
- `/sess` → session manager dashboard, naming, switching, edit wrapper, aliases, removal, export, plus `/sess ui` for the interactive Ink management pane
- `/attn` → advanced ready-session broker controls
- `/phone` → Telegram remote
- `/pk-remote` → one-command Android setup QR for the native app
- `/remote` → browser remote, Android setup QR, and HTTP API

## Important Source Map

- `index.ts` → command registration and runtime orchestration (also owns the routing-store watcher that reloads after pane writes)
<<<<<<< HEAD
- `speech-preamble.ts` → exports `PK_SPEAK_PREAMBLE`; injected by pi in `/speak agent` mode; paste into codex/oh-my-pi/claude-code config for those runtimes; ready-to-paste snippets in `integrations/`
- `pk-speak.ts` → CLI entry point compiled to `dist/pk-speak.js`; `parseArgs` is pure and tested; `main()` is the bin entrypoint
- `pk-speak-mcp.ts` → MCP server entry point compiled to `dist/pk-speak-mcp.js` (bin `pk-speak-mcp`); thin stdio adapter that shells out to sibling `pk-speak.js`; never writes to stdout except JSON-RPC
- `audio-playback.ts` → `getPlayerInvocation` (pure, platform-aware) and `playAudio` (cross-platform); shared between the extension and the CLI
- `integrations/` → ready-to-paste config snippets for Claude Code (`CLAUDE.md` paste + optional `.mcp.json`), Codex, and oh-my-pi (`AGENTS.md` paste + `~/.codex/config.toml` stanza)
=======
- `realtime-gateway.ts` → conversational assistant core: Gemini Live session, read-only subagent/workspace tools, `propose_command` approval flow
- `realtime-command-approval.ts` → approval registry for terminal/chat/kill/launch proposals
>>>>>>> origin/main
- `voice-session-command.ts` → natural spoken session phrases
- `voice-routing.ts` → normalized target matching, compact numeric route families, and conflict checks
- `session-routing.ts` → naming, aliases, dashboard formatting, removal rules, and `buildSessionDashboard` shared with the pane
- `session-routing-store.ts` → durable routing persistence
- `session-events.ts` → append-only voice/admin event log the `/sess ui` pane tails for toasts
- `ui-launcher.ts` → spawns `/sess ui` detached in a new terminal
- `ui/admin.tsx`, `ui/components/*.tsx`, `ui/actions.ts`, `ui/hooks/useSessionStore.ts`, `ui/selectors.ts` → Ink management pane (built via `tsconfig.ui.json` into `dist/ui/`)
- `listener/listener.py` → hot audio loop, wake phrase, transcription segmentation
- `realtime-gateway.ts` → conversational assistant persona and tool surface (read-only tools vs. approval-gated mutating tools) for the live-voice Gemini Live gateway
- `realtime-command-approval.ts` → approval registry for non-terminal mutating tool calls (`launch_agent`, `archive_session`)
- `README.md` → operator commands and examples
- `docs/AGENT_SPEAK.md` → agent-driven speech rationale, preamble text, and per-runtime wiring guide

## Rules For Changes In This Area

If you add or change voice/session behavior:
- preserve natural-language phrasing and real slash-command behavior together
- prefer `/sess` as the main user-facing abstraction for routing and aliases
- keep `one/1` and `two/2` deterministic and distinct; do not let fuzzy matching collapse multi-word names like `to Google` into numeric routes
- keep `/sess` as the operator summary and `/sess slots` as the explicit compact-lane inspection surface
- any new realtime-gateway tool that mutates state (subagent, terminal, or file) must go through the `tool_approval_required` / `command_approve` / `command_reject` flow — never execute a mutation inline
- prefer extending extracted pure logic instead of burying new behavior inside `index.ts`
- update tests first or alongside the change when possible
- update all of:
  - `SKILL.md`
  - `docs/VOICE_SESSION_BRIDGE.md`
  - `docs/SESSION_OPERATIONS.md`
  - `docs/AGENT_SPEAK.md` if agent-driven speech, `pk-speak` CLI, or `pk-speak-mcp` server behavior changed
  - `AGENTS.md`
  - `CLAUDE.md`
  - `README.md` if user-visible behavior changed

## Validation

Run:

```bash
npm test
```

Prefer coverage in:
- `tests/pk-speak-cli.test.mjs`
- `tests/audio-playback.test.mjs`
- `tests/voice-session-command.test.mjs`
- `tests/session-routing.test.mjs`
- `tests/session-routing-store.test.mjs`
- `tests/voice-routing.test.mjs`
- `tests/session-command-integration.test.mjs`
- `tests/attention-broker.test.mjs`
