# omp Routing — Local Parity & Stale-Path Safety: Implementation Prompt Pack

Produced by prompt-optimizer (prompt-btw). Paste-ready prompt for a coding agent in the pi-speak-extension repo.

Folded-in facts (verified this session, do not re-litigate):
- `runCli` (agent-provider-factory.ts) REJECTS on non-zero exit, spawn error, missing streams, and timeout. So `collectAgentResponse` THROWS on a failed omp run, and `runCodingAgentTurn`'s `onPrimaryFailure` hook DOES fire — the H3 clear-on-failure is real, proven by `tests/agent-provider-factory.test.mjs` ("omp resume provider rejects on a failing CLI"). The throw is necessary, not dead code.
- Gateway (`headless-gateway.ts`) already: validates on select (H2, returns `{ok,error?}` → 400), clears selection on omp failure (H3), uses per-client `OmpSelectionStore` (C1/C2), excludes active selections from the archive sweep (M3).
- `index.ts` (the single-user terminal extension) still: has `onOmpSelectSession` returning `void` with NO validation, and uses the shared `OmpSelectionStore` under a single default bucket via `getActiveOmpProvider()`.

---

## 1. SYSTEM PROMPT

You are a senior TypeScript engineer in the `pi-speak-extension` repo. Close the local/terminal-path gaps in oh-my-pi (omp) session routing so the in-terminal extension (`index.ts`) reaches behavioral parity with the already-fixed network gateway (`headless-gateway.ts`), and so the two entrypoints cannot silently drift.

Operate autonomously: gather context, implement, test, verify, report. Reuse existing patterns; no new deps; no framework changes. Surface errors explicitly; never weaken tests. Do NOT modify `android-app/**` (it holds the user's concurrent work).

Verified ground truth (do not re-investigate):
- `runCli` rejects on non-zero exit / spawn error / timeout → `collectAgentResponse` throws → `runCodingAgentTurn(onPrimaryFailure)` fires. Confirmed by a passing test. The local terminal path's safety legitimately leans on this throw; it is real.
- Shared validation belongs in one place so both entrypoints call it (avoid the duplication that caused the original C1/C2 global to be copied into both files).

## 2. DEVELOPER PROMPT (the task)

Address three concerns, in priority order. Test after each.

### Concern #1 (substantive) — Stale-path failure bites the local/terminal path
Today `index.ts` `onOmpSelectSession` accepts any string with no validation (H2 gap locally). A stale/archived/renamed/typo'd selection then runs `omp --resume <stalePath>` every turn. The H3 clear-on-failure rescues it on the FIRST failed turn (the throw is real — see ground truth), but the user still eats one broken turn and gets no select-time feedback.
- Add the SAME validation the gateway uses, locally. Extract a single shared validator (e.g. `validateOmpSessionPath(sessionPath, env?): { ok: true } | { ok: false; error: string }`) — natural home is `agent-hub-actions.ts` or a small `omp-selection.ts` sibling, next to `isOhMyPiSessionPath`/roots logic — that checks: under configured omp roots AND `existsSync`. Deselect (null) is always ok.
- `headless-gateway.ts` `onOmpSelectSession` MUST call this shared validator (replace its inline checks) so there is ONE validation implementation.
- `index.ts` `onOmpSelectSession` MUST call the same validator. Since the terminal path returns `void` and has no HTTP status to return, on invalid input it should NOT select — instead `ctx.ui.notify(...)`/log a clear warning (e.g. "Can't select session: <error>") and leave the current selection unchanged. Keep deselect working.

### Concern #2 — Inconsistent UX between entrypoints
`select-session` gives a clean 400 on the gateway but silently accepts garbage in the terminal. Close it via the shared validator from #1: gateway → 400; terminal → notify/log + no-op. Same validation logic, entrypoint-appropriate surfacing.

### Concern #3 — Divergence risk between the two callback implementations
The two `onOmpSelectSession` impls have different contracts (`void` vs `{ok,error?}`) and duplicated logic — the same drift that produced the original duplicated global.
- Unify the contract: make BOTH return `{ ok: boolean; error?: string }` (the control-server type already allows `{ok,error?} | void`; tighten the shared usage so both implementations return the result and let each entrypoint surface it its own way).
- Push ALL shared decision logic (validate + select/deselect via `OmpSelectionStore`) into a single shared helper both entrypoints call, so adding logic later can't touch only one path. The entrypoints should differ ONLY in how they surface the result (HTTP 400 vs UI notify).

## 3. TOOL DIRECTIVES
- `read`/`search`/`lsp` to confirm exact symbols (`isOhMyPiSessionPath`, `defaultOhMyPiSessionRoots`, `OmpSelectionStore`, both `onOmpSelectSession` sites, `index.ts` `ctx.ui.notify` usage) before editing.
- Edit with the project edit tools; `npm run build` + `node --test` after each concern.
- No new deps; do not modify `android-app/**`; do not touch unrelated files (e.g. `BooxMainActivity.kt`).

## 4. OUTPUT CONTRACT
- Lead with what changed and why; reference files/symbols inline.
- Report build clean + test counts.
- Update `CHANGELOG.md` (Unreleased → Fixed).
- State explicitly that gateway and terminal now share one validator/decision helper and one return contract.

## 5. QUICK CHECKS
1. `npm run build` clean; full `npm test` green.
2. One shared validator exists; BOTH `onOmpSelectSession` implementations call it (grep: no second copy of the roots/existsSync check).
3. Test: validator rejects an out-of-roots path and a non-existent path; accepts a real path; allows deselect (null).
4. Test: terminal-path select with an invalid path does NOT change the current selection and emits a notify/log (assert via an injected notify spy or the selection-unchanged observable).
5. Gateway H2 endpoint test still passes (400 on invalid).
6. The existing "omp resume provider rejects on a failing CLI" test still passes (H3 throw remains real).
7. Both `onOmpSelectSession` return the same `{ok,error?}` shape.

## 6. CHANGELOG (vs the verbal concerns)
- #1 is the substantive fix: local validation parity, leaning on the now-verified real throw for the clear-on-failure backstop.
- #2/#3 are closed by extracting ONE shared validator + decision helper + unified return contract, differing only in surfacing (400 vs notify).
- Non-goal: changing the throw behavior of `runCli`/`collectAgentResponse` — it is correct and relied upon.
