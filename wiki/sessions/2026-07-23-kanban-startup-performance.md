# Session: Kanban startup performance + omp session GC (2026-07-23)

- Type: session
- Project: pk-kanban (C:/dev/desktop-projects/kanban), oh-my-pi-fork
- Sources: kanban commit `dd7ffa902`, kanban `AGENTS.md` "Startup performance map", `packages/coding-agent/src/cli/gc-cli.ts`

## What happened

Mapped every cost between `pk-kanban` invocation and a usable board, fixed the four
biggest, committed + pushed (`dd7ffa902`), then traced the 694-file omp session store
question to the fork's existing `omp gc` and ran it.

## Startup cost map (measured, warm)

| Phase | Cost | Notes |
|---|---|---|
| node boot | ~40ms | baseline |
| Eager cli.js import graph | ~230ms | commander, ora, command registrars |
| Lazy server imports | ~910ms | 6.2MB shared chunk: @clinebot/core, openai, @google/genai |
| createWorkspaceRegistry | ~420ms → ~280ms | git spawns + lockfile + hydration |
| createRuntimeServer + listen | ~12ms | provider seeding is cheap |
| **Port-ready total** | **~1.2s** | floor is the Cline SDK chunk parse (unfixed lever) |
| First WS snapshot (15 projects) | ~3.2s → **~0.8s** | was the real perceived delay |

## Fixes shipped (`dd7ffa902`)

1. `hasGitRepository` → fs walk-up for `.git` entry, no git spawn (stream resolve ~750ms → ~5ms)
2. `detectGitRepositoryInfo` → 3s TTL cache over its 4-spawn probe
3. Presence inventory → single global 10s cache; per-repo cache keys had made a
   15-project payload rescan all of `~/.omp/agent/sessions` 15× (~1.4s of the 2.3s)
4. `detectRuntimeTools` → async execFile, concurrent, 30s cache (was ~7s of synchronous
   spawnSync freezing the whole server when the settings dialog opened)

## omp session store

- 694 persisted transcripts ≠ running sessions (0 live processes at check time)
- The fork already ships `omp gc`: dry-run by default, `--apply` executes; archives
  settled sessions to `~/.omp/agent/archive/sessions/*.jsonl.gz`, moves artifacts,
  cleans history DB, sweeps orphaned blobs, checkpoints WALs
- Ran it: 12 sessions archived, 97 blobs (5.1 MiB) swept; active store 682
- Binding retention knob for this usage: `gc.retainNewestGlobal` (500). Age and
  per-cwd caps never bind. ~179 interrupted/unknown-status sessions never archive.
- Runbook: `omp gc --agent-dir "C:\Users\prest\.omp\agent" --apply` (monthly).
  PATH `omp` is the OMPK build — without `--agent-dir` it GCs `~/.ompk/agent` instead.

## Corrections logged during the session

- First-build slowness was NOT git worktree scans (15 concurrent spawns = 71ms);
  it was the per-project session-store rescan. Sized the wrong sessions root first
  (`~/.omp/sessions` vs `~/.omp/agent/sessions`).
- "The fork has no session GC" was wrong — it lives in `src/cli/gc-cli.ts`, not
  `src/session/`.

## Reusable lesson

Windows + piped stdio hangs `node dist/cli.js` forever during module eval; redirect
to files when measuring. And before building maintenance tooling for a store you
don't own, grep the whole codebase for an existing implementation — not just the
module you expect it in.
