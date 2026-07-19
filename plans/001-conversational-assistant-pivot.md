# Plan 001: Reframe pi-speak as a conversational assistant hub

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5199341..HEAD -- realtime-gateway.ts agent-hub-dashboard.ts herdr-agent-hub-gateway.ts agent-hub-actions.ts control-server.ts index.ts docs/ README.md`
> If any of those files changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5199341`, 2026-07-13
- **Issue**: (none — internal pivot)

## Why this matters

`pi-speak` is currently positioned as a "voice workstation" (`/mono`, `/speak`, `/sess`). The underlying pieces already support a richer model: a conversational assistant that can see all subagent state, interview the user to scope work, and send commands only after explicit approval. Reframing the product around this assistant model makes the existing voice, phone, and remote surfaces clients of the assistant rather than the primary interface, and it reuses the real-time gateway and Agent Hub infrastructure already in place.

## Current state

- `realtime-gateway.ts` — runs a Gemini Live session with tool calling (`execute_terminal_command`, `launch_agent`). It already has an approval registry (`realtime-terminal-approval.ts`) and a `REALTIME_SYSTEM_PROMPT` that treats it as a "concise voice coding assistant".
- `agent-hub-dashboard.ts` — scans `~/.ompk/agent/sessions` and parses `backgroundInstance`/`subagents` records to build a read-only dashboard of background lanes.
- `herdr-agent-hub-gateway.ts` — exposes `listAgents`, `getAgent`, `readTranscript`, `chat`, `kill`, `revive` through an `AgentHubBinding` with a `canMutate` flag. The gateway layer also requires confirmation tokens for destructive actions (`kill`).
- `agent-hub-actions.ts` — pure helpers for archive/recover/launch and `validateOmpSelection` for path containment.
- `control-server.ts` — HTTP API surface used by the web remote and phone (`/v1/herdr/agent*`, `/v1/sessions/launch`, `/v1/workspace`, etc.).
- `index.ts` — extension command registration (`/speak`, `/mono`, `/sess`, `/phone`, `/remote`, `/pk-remote`).
- `docs/VOICE_SESSION_BRIDGE.md` and `docs/SESSION_OPERATIONS.md` — describe the voice-first `/sess` and wake-phrase flows.
- `README.md` — opens with "Voice, wake-word, and remote-control extensions for Pi / `pi-mono`".

Repo conventions to match:
- TypeScript with `type: "module"`, compiled to `dist/` by `npm run build`.
- Error handling returns `{ ok: boolean; message?: string }` in `agent-hub-actions.ts` and `herdr-agent-hub-gateway.ts`; follow that pattern for new tools.
- Tests live in `tests/*.test.mjs` and require `npm run build` first.
- Environment-driven config (e.g. `PI_SPEAK_*`, `AGENT_CWD`, `AGENT_WORKSPACE`).

## Commands you will need

| Purpose   | Command                               | Expected on success |
|-----------|---------------------------------------|---------------------|
| Build     | `npm run build`                       | exit 0, no TS errors |
| UI build  | `npm run build:ui`                    | exit 0              |
| Typecheck | `npm run typecheck`                   | exit 0, no errors   |
| Tests     | `npm run test`                        | exit 0, all pass    |

## Scope

**In scope** (the only files you should modify):
- `realtime-gateway.ts` — replace the "voice coding assistant" system prompt with a conversational assistant persona; add read-only subagent tools and a `propose_command` tool that must wait for user approval.
- `realtime-terminal-approval.ts` or a new `realtime-command-approval.ts` — extend the approval registry to cover command proposals (terminal, chat, kill, launch) so the assistant can ask "Should I do this?" and wait.
- `agent-hub-dashboard.ts` — expose a compact, conversation-friendly snapshot of all agents and their recent status.
- `herdr-agent-hub-gateway.ts` — ensure the read-only binding (`canMutate=false`) is safe for the assistant to call on every turn; add a `propose` path that stages mutations and returns a confirmation token.
- `docs/VOICE_SESSION_BRIDGE.md` — reframe wake phrases as a way to start a conversation with the assistant.
- `docs/SESSION_OPERATIONS.md` — update `/sess` description to show it as assistant-managed sessions.
- `README.md` — lead with the conversational assistant thesis; keep voice/remote as clients.
- `AGENTS.md` / `CLAUDE.md` — reflect the new framing.
- `tests/` — add/update tests for the new assistant tools and approval flow.

**Out of scope** (do NOT touch, even though they look related):
- `tts.ts`, `stt.ts`, `listener/listener.py` — keep TTS/STT and the wake-word listener as-is; they become input/output channels.
- `android-app/` and `web/` UI — do not redesign the mobile UI in this plan; only the gateway/API contract may be extended.
- Authentication or pairing (`pairing.ts`, `clearRootVoiceDisable`) — no new auth model.
- Replacing `pi-coding-agent` or the background-lane subagent model — the assistant supervises, it does not replace.

## Git workflow

- Branch: `advisor/001-conversational-assistant-pivot`
- Commit per logical step; message style: conventional commits (e.g., `docs: reframe README around conversational assistant`, `feat(realtime): add read-only subagent tools`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Rename and refocus the assistant persona

In `realtime-gateway.ts`, update `REALTIME_SYSTEM_PROMPT` and the tool descriptions so the model acts as a conversational assistant, not a voice command executor.

Current excerpt:
```ts
export const REALTIME_SYSTEM_PROMPT = [
	"You are a concise voice coding assistant.",
	"When you fire a background tool (launch_agent, execute_terminal_command), acknowledge in one short sentence, then continue the conversation normally.",
	"Do not narrate a tool's progress unless you receive an explicit progress update.",
	"When a tool result arrives, announce it conversationally at the next natural pause.",
	"Do not narrate background state refreshes delivered silently.",
].join(" ");
```

Replace it with a prompt that tells the model:
- It is a conversational assistant that can read all subagent state.
- It must interview the user to scope ambiguous requests.
- It must ask for explicit approval before any command that mutates a subagent, terminal, or file.
- It should keep replies short and conversational.

**Verify**: `npm run build` → exit 0, no TS errors.

### Step 2: Add read-only assistant tools

In `realtime-gateway.ts`, add tool definitions (or new tool functions) that call:
- `listAgents()` and `getAgent()` from `herdr-agent-hub-gateway.ts` / `agent-hub-dashboard.ts`.
- `readTranscript()` from `herdr-agent-hub-gateway.ts`.
- `GET /v1/workspace` and `GET /v1/workspace/file` from `control-server.ts` for file browsing.

These tools must return structured JSON summarizing state; the assistant never mutates here.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add propose + approval flow for mutating commands

Create or extend an approval registry that covers:
- `execute_terminal_command` (already exists in `realtime-terminal-approval.ts`).
- `chat` / `kill` / `launch` subagent commands.
- `launch_agent` or `execute_terminal_command` with a multi-step plan.

In `realtime-gateway.ts`, when a tool wants to mutate, the assistant should call a `propose_command` tool that:
- Returns a confirmation token and a human-readable description.
- Does NOT execute until the user says "yes" or the UI approves.
- On approval, executes and returns the result conversationally.

Reuse the confirmation-token pattern in `AgentHubGateway.kill` and `realtime-terminal-approval.ts`.

**Verify**: `npm run test` → exit 0, including new/updated tests for proposal and approval.

### Step 4: Reframe documentation

Update `README.md`, `docs/VOICE_SESSION_BRIDGE.md`, `docs/SESSION_OPERATIONS.md`, `AGENTS.md`, and `CLAUDE.md` to describe `pi-speak` as a conversational assistant that uses voice/remote as input channels. Keep the existing `/mono`, `/sess`, `/phone`, `/remote` commands, but describe them as ways to reach the assistant.

**Verify**: `grep -R "voice workstation" README.md docs/ AGENTS.md CLAUDE.md` returns no matches (or only in historical context), and `grep -R "conversational assistant" README.md docs/ AGENTS.md CLAUDE.md` returns matches.

### Step 5: Add/update tests

Add tests in `tests/` for:
- The new assistant system prompt persona.
- Read-only `listAgents` / `getAgent` tool responses.
- Propose command generation and approval token flow.
- Rejection of commands without approval.

Use `tests/agent-hub-actions.test.mjs` and `tests/voice-session-command.test.mjs` as patterns for pure-logic and integration-style tests.

**Verify**: `npm run test` → exit 0, new tests pass.

## Test plan

- New tests for the assistant persona/system prompt behavior.
- New tests for the `propose_command` approval flow.
- New tests for read-only subagent state tools.
- Existing tests must still pass.

**Verification**: `npm run test` → all pass, including N new tests.

## Done criteria

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run test` exits 0; new tests for the assistant and approval flow exist and pass.
- [ ] `realtime-gateway.ts` uses a conversational assistant persona and has read-only subagent tools plus a `propose_command` approval path.
- [ ] `README.md` and `docs/VOICE_SESSION_BRIDGE.md` are updated to describe the assistant model.
- [ ] No files outside the in-scope list are modified (`git status` matches expected).
- [ ] `plans/README.md` status row updated to `DONE`.

## STOP conditions

Stop and report back (do not improvise) if:
- The code at the locations in "Current state" doesn't match the excerpts (the codebase has drifted since this plan was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- The Gemini Live backend or `@google/genai` API no longer supports the tool-calling shape used in `realtime-gateway.ts`.

## Maintenance notes

- Future surfaces (Android, PWA, `/sess ui`) should call the same `propose_command` flow so approval semantics stay consistent.
- If a new subagent provider is added, extend the `AgentHubBinding` read-only methods; the assistant layer should not care about provider specifics.
- Reviewers should scrutinize the approval boundary: anything that can mutate a subagent, terminal, or file must go through `propose_command` and user approval.
