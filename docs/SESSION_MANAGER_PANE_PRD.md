---
title: Session Manager Pane PRD
project: pi-speak-pk
date: 2026-04-16
status: in-progress
owners:
  - pi-speak-pk
areas:
  - sessions
  - ui
loop: ralph
---

## How To Use This PRD (Ralph Loop)

Each iteration runs with fresh context. Before editing anything:

1. Read this file end to end.
2. Run `npm test` and record which tests pass.
3. Check the **Progress Ledger** below to see what's already done.
4. Pick the **lowest-numbered unchecked task**.
5. Implement only that task.
6. Run `npm test`. If green, tick the task in the ledger and commit.
7. If red, revert or fix — do not advance the ledger.

Do **not** attempt multiple tasks per iteration. Do **not** refactor outside the task's named files. The loop terminates when every task in the ledger is checked and the **Definition of Done** is met.

## Problem

Operators currently manage sessions by reading slash-command text output. With multiple Pi sessions in play, there's no live view of which session is current, which is ready, which is busy, and what voice commands just changed. Naming and aliasing require recalling exact commands.

## Goal

Ship an Ink-based management pane that renders the `/sess` dashboard live, reflects voice-command mutations as toasts, and lets the operator rename/alias/remove sessions interactively. Launch via `/sess ui`.

## Non-Goals

- No editable settings surface in v1 (TTS provider, wake phrase, etc. stay read-only or absent).
- No remote/browser rendering — terminal only.
- No OMC-agent concept; "active" means the current Pi session.
- No replacement of the text `/sess` dashboard — the pane is additive.

## Users

Single operator running pi-speak-pk on Windows with multiple Pi sessions. Voice-first workflow; keyboard fallback in the pane.

## User Stories

1. As an operator, I run `/sess ui` and get a live dashboard in a separate terminal.
2. As an operator, I see at a glance which session is current, which are ready, and which are busy vs idle vs saved.
3. As an operator, I say "name this session active work" and the pane flashes a toast reflecting the rename within ~1s.
4. As an operator, I press `r` on a session row, type a new name, and the rename persists and propagates back to the extension runtime.
5. As an operator, I press `x` on a session row and must confirm before routing metadata is cleared.
6. As an operator, I press `a` on a session row and add a wake alias; subsequent `PK <alias>` voice commands route there.

## Functional Requirements

### FR-1 Dashboard view
Renders per `docs/SESSION_MANAGER_SPEC.qmd` §User model: current session, ready list, store path, and per-session rows with current/ready markers, activity state (`busy`/`idle`/`saved`), and aliases.

### FR-2 Live refresh
Routing-store and attention-snapshot changes originating outside the pane process surface within 1s.

### FR-3 Voice-event toasts
Voice-originated mutations in the extension surface in the pane as dismissible toasts (3s TTL) tagged `voice: …`.

### FR-4 Rename action
Key `r` on the focused session prompts for a new name, validates (no duplicates per spec §Safe Behavior Rules), writes via `setNamedSession` + `persistSessionRouting`, emits a `source: "admin"` event.

### FR-5 Alias action
Key `a` prompts for an alias, normalizes per spec §Wake aliases are normalized, writes via `setWakeAlias` + `persistSessionRouting`.

### FR-6 Remove action
Key `x` requires two-step confirm per spec §Deletion safety; removes saved name + aliases pointing to that path; does not delete the underlying Pi session file.

### FR-7 Extension-side reload
The extension watches the routing-store path and reloads in-memory `SESSION_REGISTRY_TYPE` / `SESSION_WAKE_ALIAS_TYPE` maps on external change, so pane edits reflect in the next `/sess` text call without restart.

### FR-8 Launcher
`/sess ui` spawns the pane detached in a new terminal (Windows `start`). If no terminal emulator is available, prints the exact command.

## Non-Functional Requirements

- Pane cannot take over pi-coding-agent's TTY; must run out-of-process.
- All writes go through existing pure helpers in `session-routing.ts`. No logic forks.
- Event log bounded to 200 lines (rotated).
- Build must succeed on Windows (forward slashes in paths, no Unix-only calls).
- No new runtime deps beyond `ink`, `react`, `@types/react`.

## UX

### Dashboard
```
pi-speak session manager                    store: C:\Users\...\session-routing.json

Current: voice
Ready:   voice-bugfix

> voice            [current] [idle]   aliases: one
  voice-bugfix     [ready]   [busy]   aliases: two
  voice-docs                [saved]   aliases: three

[r] rename  [a] alias  [x] remove  [q] quit
```

### Toast (bottom band)
```
voice: wake alias "two" → voice-bugfix            (just now)
```

## Success Metrics (verifier checks)

- `npm test` green with all new tests included.
- `npm run build` and `npm run build:ui` both clean.
- Manual: `/sess ui` opens a second terminal showing the live dashboard on Windows.
- Manual: saying "name this session active work" causes a toast in the pane within 2s.
- Manual: pressing `r` in the pane renames a session and subsequent `/sess` text output reflects the new name without restart.

## Progress Ledger

Mark `[x]` only after `npm test` is green for the iteration.

### Phase 1 — Foundation
- [ ] **T1** Extract `buildSessionDashboard` selector in `session-routing.ts`; refactor `formatSessionManagerSummary` to wrap it. Add 2 selector tests (busy/idle/saved) to `tests/session-routing.test.mjs`.
- [ ] **T2** New `session-events.ts` with `appendSessionEvent` + `tailSessionEvents` (200-line rotation). New `tests/session-events.test.mjs`.
- [ ] **T3** Emit `appendSessionEvent` at every voice-originated mutation in `index.ts` (wake set/clear, name, switch, remove). Extend `tests/session-command-integration.test.mjs` with 2 cases.

### Phase 2 — Ink Pane
- [ ] **T4** Add `ink`, `react`, `@types/react` deps. New `tsconfig.ui.json`. `bin/pi-speak-admin` entry in `package.json`. Stub `ui/admin.tsx` renders `--help`.
- [ ] **T5** `ui/components/Dashboard.tsx` + `ui/selectors.ts` using T1's selector. Snapshot tests via `ink-testing-library` against 3 fixtures. If `ink-testing-library` flakes on Windows, fall back to pure-function snapshot tests of the selector output.
- [ ] **T6** `ui/hooks/useSessionStore.ts` polls mtime (500ms) and tails events. `ui/components/Toast.tsx` with 3s TTL.

### Phase 3 — Write paths + launcher
- [ ] **T7** `ui/components/ActionBar.tsx` + `ui/actions.ts` implementing `r`/`a`/`x` per FR-4/5/6. Writes go through existing helpers. New E2E test with `ink-testing-library`.
- [ ] **T8** Routing-store mtime watcher in `index.ts`; reload in-memory maps on external change. Guard self-triggered reloads. Extend `tests/session-command-integration.test.mjs`.
- [ ] **T9** `/sess ui` handler in `index.ts` spawns admin CLI detached. Fallback prints command. Smoke test mocks `spawn`.

### Phase 4 — Docs
- [ ] **T10** Update `SKILL.md`, `docs/SESSION_OPERATIONS.md`, `docs/VOICE_SESSION_BRIDGE.md`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`. No stale `/sess` surface text.

## Definition of Done

All ledger items checked AND:
- `npm test` green
- `npm run build` + `npm run build:ui` green
- `/sess ui` opens the pane on Windows manual check
- A voice-triggered rename produces a pane toast within 2s manual check
- A pane-triggered rename reflects in the next `/sess` text output without restart manual check

## Invariants (do not violate across iterations)

1. Pane is out-of-process. No inline Ink render in the pi-coding-agent TTY.
2. All session mutations go through `setNamedSession` / `setWakeAlias` / `removeSessionRoutingForPath` + `persistSessionRouting`. No parallel write paths.
3. `/sess` text dashboard behavior unchanged (T1 is a refactor, not a rewrite).
4. Windows-first paths. No Unix-only shell calls.
5. Event-log file is append-only with bounded rotation.

## Known Risks

- `ink-testing-library` + Node test runner on Windows — if flaky, demote T5/T7 tests to pure-function selector snapshots; note the fallback in the commit.
- React version mismatch with Ink peer deps — pin versions published in Ink's peer-deps range.
- Concurrent writes racing the store — `persistSessionRouting` already whole-file writes; T8's watcher must skip self-triggered reloads.

## Files Of Record

- `index.ts` — command registration, runtime state, watcher (T8), launcher (T9)
- `session-routing.ts` — pure helpers + dashboard selector (T1)
- `session-routing-store.ts` — persistence (unchanged)
- `session-events.ts` — new, append log (T2)
- `attention-broker.ts` — unchanged
- `voice-session-command.ts` — unchanged except event emission hooks
- `ui/` — Ink pane sources (T4–T7)
- `bin/pi-speak-admin` — entry (T4)
- `tsconfig.ui.json` — UI build (T4)
- `docs/SESSION_MANAGER_SPEC.qmd` — manager-shape spec (reference only)
- `docs/SESSION_MANAGER_PANE_PRD.md` — this file

## Loop Exit

When Definition of Done is satisfied, stop the Ralph loop and post the final diff summary + manual-check evidence.
