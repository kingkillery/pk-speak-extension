# AGENTS.md - pi-speak-pk Extension

Development contract for `pi-speak-pk`, a conversational assistant for pi-coding-agent reachable through voice, wake word, phone, browser, and Android clients.

Keep this root file compact because it is injected into every agent request. Load [docs/AGENT_REFERENCE.md](docs/AGENT_REFERENCE.md) only when its detailed file map, endpoint notes, test topology, or KADE/wiki workflow is relevant. Product guides live in [README.md](README.md), [docs/VOICE_SESSION_BRIDGE.md](docs/VOICE_SESSION_BRIDGE.md), and [docs/SESSION_OPERATIONS.md](docs/SESSION_OPERATIONS.md).

## Commands

```bash
npm run build                # Compile TypeScript
npm test                     # Default unit/integration suite
npm run test:realtime-live   # Realtime gateway dispatch + approval flow
npm run build:omp-bundle     # Single-file bundle for compiled oh-my-pk
npm run prepublishOnly       # Release build
```

## Architecture Map

| Area | Primary files |
|---|---|
| Extension and server entry | `index.ts`, `server-app.ts`, `control-server.ts` |
| Pairing and runtime paths | `pairing.ts`, `runtime-paths.ts`, `persistent-tray.ts` |
| Session routing and events | `session-routing.ts`, `session-routing-store.ts`, `session-events.ts`, `voice-session-command.ts` |
| Agent Hub | `agent-hub-*.ts`, `herdr-agent-hub-*.ts`, `hub-handoff.ts` |
| Realtime assistant | `realtime-gateway.ts`, `live-backend.ts`, `openai-realtime-live.ts`, `realtime-*.ts` |
| Voice stack | `voice-mode.ts`, `tts.ts`, `stt.ts`, `listener/listener.py`, `gemini-live-*.ts` |
| Web and desktop clients | `web/remote/`, `desktop-live-client.ts`, `ui/` |
| Android client | `android-app/` |

## Non-Negotiable Contracts

- **Approval boundary:** session discovery and connection-local `switch_session` are read-only. `send_session_message`, `resume_session`, `launch_agent`, `kill_agent`, `revive_agent`, `archive_session`, and non-allowlisted terminal commands execute only after their matching approval message. Keep the public `ControlServer.agentHubGateway` read-only; mutations go through the trusted `realtimeBridge`. Audit proposal, approval, and result steps.
- **Speech shaping:** every model-facing realtime tool response passes through `shapeRealtimeToolOutputForSpeech`. Preserve the complete raw payload in the client `tool_complete` event. Explicit progress/done response overrides intentionally skip shaping.
- **Workspace reads:** keep browse/read operations confined to `PI_SPEAK_WORKSPACE_ROOT`. Preserve lexical traversal checks, realpath containment, secret-shaped path refusal, Windows device-name rejection, and documented size/entry caps.
- **Compiled OMP bundle:** `dist/omp-index.js` must have zero bare runtime imports because the compiled Bun resolver does not search external `node_modules`. Configure compiled oh-my-pk to load this bundle, not `dist/index.js`.
- **Client parity:** when adding gateway features used by the web remote, extend Android parsing in `android-app/.../api/` and both standard and Boox UI surfaces when applicable. Do not bury transport parsing in `MainActivity.kt`.
- **Session writes:** pane mutations flow through persisted routing load, a pure routing helper, persistence, then `appendSessionEvent`. Keep the extension's external-store reload behavior intact.
- **Route identity:** preserve distinct `one/1` and `two/2` compact route families; multi-word names such as `PK to Google` remain literal.
- **Agent launch:** build CLI arguments through `buildOhMyPiLaunchArgv`. Default omitted `cwd` through `AGENT_CWD`, then `AGENT_WORKSPACE`, then `process.cwd()`.
- **Credentials:** audio providers use their dedicated credentials. Never expose keys through tool output, logs, or workspace reads.
- **Remote audio:** browser microphone access requires an HTTPS origin except for trusted loopback contexts.

## Testing Rules

- Test externally observable behavior and security boundaries, not source text.
- Run `npm test` for ordinary changes and `npm run build` for TypeScript/build validation.
- Run `npm run test:realtime-live` when changing the realtime gateway's actual tool-call dispatch, approval gating, audit flow, or workspace-read integration. Pure helper tests alone do not cover that switch.
- Use the simulated Live backend for deterministic, keyless end-to-end coverage. Do not infer simulation implicitly from missing credentials.
- Add focused coverage for changed contracts; avoid duplicating the same assertion at several abstraction levels.

## Context and Retrieval

- Current source and project-local instructions outrank memory. Load only task-relevant context.
- When the correct file or prior decision is unknown, use the configured repository retrieval/index tools before broad file scans.
- Read `LLM_WIKI_MEMORY.md`, `.llm-wiki/config.json`, or `kade/` only for tasks that need project history, durable decisions, or KADE/wiki operations.
- Put durable repository knowledge in `wiki/` and keep `wiki/index.md` and `wiki/log.md` synchronized when making meaningful wiki changes. Never edit immutable material under `raw/`.
- Confirm the configured vault path before any Obsidian access or creation.

## Release

Use `npm publish` only when explicitly requested. `npm run prepublishOnly` builds the package first.
