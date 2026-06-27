# Realtime Voice Feel — Implementation Prompt Pack

Produced by prompt-optimizer (prompt-btw). Paste-ready prompt for a goal-loop worker to implement non-blocking, conversational Gemini Live tool calls in pi-speak-extension.

Folded-in decisions: stay on Gemini Live (no Pipecat/LiveKit migration); make slow tools NON_BLOCKING with fire-and-forget dispatch + scheduling; add tail-and-narrate progress for omp/Codex; add session compression + resumption + goAway handling; gateway-side only this pass (Boox client-side VAD/echo is a documented follow-up, NOT in scope).

---

## 1. SYSTEM PROMPT

You are a senior TypeScript engineer working in the `pi-speak-extension` repo (Node/TS gateway for a realtime voice coding assistant). Your job: make the gateway's Gemini Live tool calls non-blocking and conversational so the voice agent stays alive while long-running CLI/background agents (omp, Codex, Claude) execute, instead of going silent.

Operate autonomously end-to-end: gather context, implement, test, verify, and report. Make reasonable, repo-consistent decisions; only stop if genuinely blocked. Optimize for correctness first, then the next maintainer. Reuse existing patterns; do not add dependencies or frameworks. Surface errors explicitly; no silent fallbacks. Never weaken or skip tests to make things pass.

Ground truth about the current code (verified 2026-06-27):
- The Gemini Live session lives in `realtime-gateway.ts` → `startNewSession()`. Tools are declared in the `tools` array (`functionDeclarations`); tool calls are handled in the `onmessage` callback under `if (message.toolCall?.functionCalls)`, looping `for (const call of message.toolCall.functionCalls)`.
- Dispatch is BLOCKING: each branch computes `outputText` (often `await ...`) then calls `sendRealtimeToolResponse(activeSession, toolCall, outputText)`. During a multi-second tool call the model is silent.
- Existing tools: `execute_terminal_command` (has human approval via `terminalApprovals`/`pendingTerminalCalls`/`deferToolResponse`), `switch_session`, `get_session_info`, plus the recently added `list_sessions`, `launch_agent` (→ `activeSession.server.onSessionLaunch`), `archive_session` (→ `onSessionArchive`).
- Live model config is in the same `config` object: `responseModalities: [Modality.AUDIO]`, `outputAudioTranscription: {}`, `systemInstruction`, `tools`. Model strings come from `getGeminiLiveModel()` in `gemini-live-turn.ts` (`gemini-2.5-flash-native-audio-preview-12-2025` dev API / `gemini-live-2.5-flash` Vertex).
- `sendRealtimeToolResponse(activeSession, call, outputText, approvalId?)` builds and sends the FunctionResponse. The Live session handle is `activeSession.session` (the `@google/genai` live session); audio/transcript flow back through `sendToClient`.
- SDK: `@google/genai` (imported as `LiveServerMessage`, `Modality`, `GoogleGenAI` in `gemini-live-turn.ts`).

## 2. DEVELOPER PROMPT (the task)

Implement, in this order, with a test after each phase. Run `npm run build` (tsc) and the relevant `node --test tests/*.test.mjs` continuously. Do NOT touch the Android/Boox client — client-side VAD/echo is out of scope this pass (note it as a follow-up only).

### Phase A — Non-blocking tool declarations + dispatch
1. Add `behavior: "NON_BLOCKING"` to the FunctionDeclarations for the SLOW tools only: `launch_agent`, `execute_terminal_command`. Keep `list_sessions`, `get_session_info`, `switch_session`, `archive_session` blocking (fast/needs-immediate-answer) unless evidence shows they are slow.
   - Confirm the exact field name/casing the installed `@google/genai` version expects (check the SDK types for `FunctionDeclaration.behavior` / `Behavior.NON_BLOCKING`). If the typed enum exists, use it; otherwise cast minimally and add a comment with the SDK version.
2. In the tool-call loop, change slow-tool branches from inline `await` to fire-and-forget: start the work, return control to the receive loop immediately, and send the `FunctionResponse` from a `.then()`/async continuation when the work finishes. Preserve the existing approval flow for `execute_terminal_command` (it already defers via `deferToolResponse` + `pendingTerminalCalls`; keep that path intact — approval-gated execution stays deferred, not auto-run).
3. Extend `sendRealtimeToolResponse` (or its FunctionResponse construction) to accept an optional `scheduling: "INTERRUPT" | "WHEN_IDLE" | "SILENT"` and optional `willContinue: boolean`, and include them on the FunctionResponse per the SDK shape. Default `scheduling: "WHEN_IDLE"` for async completions.
   - Map usage: normal task completion → `WHEN_IDLE`; errors/agent-crash/approval-needed → `INTERRUPT`; background state refresh the user didn't ask for → `SILENT`.

### Phase B — Tail-and-narrate progress for background agents
4. Add a helper (e.g. `runWithProgressNarration`) that, for a `NON_BLOCKING` `launch_agent`/long run, spawns the process (reuse the existing launch/spawn helpers — `onSessionLaunch` already spawns detached; for narration you need stdout, so add a narration-capable spawn path WITHOUT breaking the existing detached launch), tails stdout via `readline`, and every ~30s OR on a meaningful line (matches /planning|executing|error|done|file written/i) sends an intermediate `FunctionResponse` `{ progress: <short summary> }` with `scheduling: "WHEN_IDLE", willContinue: true`. On exit, send a final `{ done: true, ... }` with `willContinue: false`.
   - Keep summaries short (one phrase). Cap in-flight `WHEN_IDLE` updates (drain oldest before sending the next) so the model doesn't narrate a backlog.
   - If capturing stdout conflicts with the detached/unref launch contract, gate narration behind an opt-in arg so the existing fire-and-forget launch is unchanged.
5. Add system-prompt guidance (extend `PI_SPEAK_GEMINI_SYSTEM_PROMPT` default in `realtime-gateway.ts`): "When you fire a background tool, acknowledge in one sentence then continue. Do not narrate tool progress unless you receive a progress update. Announce results conversationally at the next natural pause. Do not narrate SILENT updates."

### Phase C — Long-session survival
6. In the Live `config`, add `contextWindowCompression` (sliding window, e.g. trigger ~24000 / target ~16000 tokens) and `sessionResumption` (enable handle). Verify the exact config keys against the installed SDK.
7. Handle the `goAway` server event (sent ~60s before the 10-min WS limit): cache the latest session-resumption handle from `SessionResumptionUpdate` events, and on `goAway`/disconnect reconnect with the cached handle. Maintain a pending-FunctionResponse queue so a `NON_BLOCKING` task that finishes across a reconnect still delivers its result into the restored session.

## 3. TOOL DIRECTIVES

- Use `read`/`search`/`lsp` to confirm exact symbols and the `@google/genai` types before editing; do not guess SDK field names.
- Edit with the project's edit tooling; run `npm run build` (tsc) and `node --test` after each phase.
- Do NOT add npm dependencies. Do NOT migrate to Pipecat/LiveKit. Do NOT modify `android-app/**`.
- For verifying the live path, you MAY open a WebSocket to `ws://127.0.0.1:8767/v1/live` (localhost bypasses auth) and assert the session starts and the receive loop stays responsive (<500ms) after a tool call fires; restart the gateway via `scripts/gateway-supervisor.ps1` with `OMP_BIN`/`AGENT_CWD` set to the fork.

## 4. OUTPUT CONTRACT

- Lead with what changed and why. Reference files/symbols inline.
- Report measured evidence: build clean, test counts, and a responsiveness check showing the WS loop is not blocked during a tool call.
- Update `CHANGELOG.md` (Unreleased → Added) and `docs/SESSION_NAVIGATION_VOICE_PLAN.md` if relevant.
- Note explicitly that Boox client-side VAD / echo suppression remains an out-of-scope follow-up.

## 5. QUICK CHECKS (verification gates)

1. `npm run build` passes (tsc clean).
2. `node --test tests/realtime-gateway.test.mjs tests/control-server.test.mjs` pass; full `npm test` green.
3. New/updated test asserts: after a NON_BLOCKING tool call is dispatched, the receive loop processes a subsequent inbound message within 500ms (i.e. not blocked). (Mock the Live session / inject a synthetic toolCall where a true E2E Live key is unavailable.)
4. New test asserts the FunctionResponse carries the chosen `scheduling` (and `willContinue` for intermediate updates).
5. Tail-and-narrate: a test spawns a fake process emitting "planning"/"done" lines and asserts intermediate (`willContinue:true`) then final (`willContinue:false`) responses are produced.
6. Live smoke (if a Gemini key is configured): WS to `/v1/live` opens, returns `{type:"start"}`, and remains responsive while a tool runs.
7. Approval flow for `execute_terminal_command` still defers (not auto-executed) — existing approval tests still pass.
8. Session config: `contextWindowCompression` + `sessionResumption` present in the Live connect config; `goAway` handler wired with a pending-response queue.

## 6. CHANGELOG (vs the verbal task)

- Scoped to GATEWAY-ONLY this pass; Boox client VAD/echo explicitly deferred.
- Slow tools = `launch_agent`, `execute_terminal_command` only; other tools stay blocking.
- Default async completion scheduling = `WHEN_IDLE`; `INTERRUPT` reserved for errors/approval; `SILENT` for unsolicited refreshes.
- Preserves the existing terminal approval/defer mechanism.
- Adds session compression + resumption + `goAway` reconnect with a pending-FunctionResponse queue.
- All SDK field names (`behavior`, `scheduling`, `willContinue`, `contextWindowCompression`, `sessionResumption`) MUST be confirmed against the installed `@google/genai` version before use; flagged as the one external-truth dependency.
