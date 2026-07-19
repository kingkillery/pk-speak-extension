---
title: "PR 13 Android Gateway Parity Completion"
type: session
tags: [pi-speak-extension, android, gateway, parity, pr13, review]
status: complete
date: 2026-07-02
---

# PR 13 Android Gateway Parity Completion

## Summary
PR #13, "feat: bring Android app to functional parity with the web remote", was merged into `main` on 2026-07-02 at 06:56:17Z as merge commit `35fed0a`.

The run then performed a post-merge verifier pass against the current code. Three GPT subagents reviewed correctness, API contract parity, and reliability. Their still-valid findings were fixed locally on `main`; stale or out-of-scope findings were skipped with reasons.

## Achieved
- Verified and completed the original PR review items:
  - `GatewayEventStream.stop()` now cancels the active call and wakes reconnect backoff promptly.
  - Gateway Ops refresh clears loading in `finally` so failed refreshes do not leave the pane disabled.
  - Android/Robolectric tests are pinned to a Java 21 launcher.
  - Failed route updates no longer mutate saved gateway route prefs.
- Wired Android archive/recover actions through the actual gateway `onSessionArchive` handler in `index.ts`.
- Fixed browser EventSource auth by allowing `/v1/events?token=...` and updating the web remote to include the saved token in the SSE URL.
- Hardened Android gateway operations so malformed gateway URLs are caught inside client error handling instead of escaping request construction.
- Preserved `/v1/workspace` `truncated` state through Android parsing and surfaced a capped-folder notice in the UI.
- Added Android handling for valid legacy `/v1/agents` responses that provide `agents: string[]` without structured `running` rows.
- Added regression coverage for SSE query-token auth, malformed Android gateway URLs, and Android workspace truncation parsing.

## Validation
- `npm test`: 333 passing.
- `android-app/.\\gradlew.bat :app:testStandardDebugUnitTest :app:compileBooxDebugKotlin :app:assembleStandardDebug`: successful.
- `git diff --check`: exit 0, with only expected LF/CRLF warnings.
- `gh pr view 13`: state `MERGED`, merge commit `35fed0aeb79f332937085791e9bcaae304a13c0c`.

## Skipped Findings
- SSE resume offsets after event-log trimming: real residual risk, but shared/pre-existing and not a minimal Android parity fix for this run.
- Disposed event-stream stale callback race: non-blocking lifecycle hardening; not required for the parity completion.
- Reverse-direction browser gaps where Android has extra controls: not an Android parity blocker.

## Current Local State
The merged PR is on `origin/main`. The follow-up verifier fixes from this run are still uncommitted local changes on `main` across:
- `android-app/app/src/main/java/com/example/MainActivity.kt`
- `android-app/app/src/main/java/com/example/api/GatewayEventStream.kt`
- `android-app/app/src/main/java/com/example/api/VoiceAgentClient.kt`
- `android-app/app/src/test/java/com/example/api/VoiceAgentClientConnectionTest.kt`
- `control-server.ts`
- `index.ts`
- `tests/control-server.test.mjs`
- `web/remote/app.js`

## Subagent Cleanup
The GPT reviewer subagents finished and were closed. A leftover Cline verifier process for this workspace was stopped. MiniMax desktop/daemon remained running, but `minimax session list` reported sessions as `finished`; no Kimi or psmux verifier sessions remained.
