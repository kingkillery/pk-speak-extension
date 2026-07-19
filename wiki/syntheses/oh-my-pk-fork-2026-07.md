---
type: synthesis
title: "oh-my-pk Fork Architecture Snapshot 2026-07"
created: 2026-07-13
updated: 2026-07-13
tags: []
status: developing
related: []
sources:
  - oh-my-pi-fork git log a7b803d..1895db95 + uncommitted tree (2026-07-13)
---

# oh-my-pk fork: remote-workspace, task contracts, and satellite packages (2026-07 state)

Snapshot of recent architecture work in `C:\dev\Desktop-Projects\oh-my-pi-fork` (the oh-my-pk fork). The fork keeps its own in-repo wiki at `oh-my-pi-fork/.wiki/` — treat that as the source of truth for fork internals; this page is the cross-repo pointer and gotcha list.

## packages/remote-workspace (`9b33ae0`, `20f91fbe`, `1895db95`)
Isolated-execution package: Docker backend (`src/backend/msi-docker.ts`) with wait/artifact ordering and cleanup, SQLite job store (`busy_timeout`, cross-process cancel), credential redaction in Docker/SQL surfaces, job state machine, orchestrator, contract-level tests (`test/orchestrator-contract.test.ts`).

**Scope split (important):** `packages/remote-workspace` is *local Docker sandbox jobs only*. Mesh / cloud / auth / codespace-style remote launch is owned by **environments-cloud (pkscloudenvs)** — MSI-local canonical root `C:\dev\desktop-infra\environments-cloud`, override via `OMPK_ENVIRONMENTS_CLOUD_ROOT` / `PKS_ENVIRONMENTS_CLOUD_ROOT`. `loadSkills()` auto-includes `environments-cloud\.agents\skills\` when present (`packages/coding-agent/src/config/environments-cloud-skills.ts`); CLI: `bun src/cli.ts environments [skill <name>]`. Docs: `docs/environments-cloud.md`, fork wiki `.wiki/concepts/environments-cloud-routing.md`.

## Task-contract orchestration (`a7b803d`, `6087ea0`)
Ephemeral, deterministic request context in `packages/coding-agent/src/orchestration/` (task-contract, intent-compiler, contract-injector, reasoning-plan), wired by `AgentSession.prompt()` for substantial user prompts in main sessions only. Never persisted to session storage; cleared on `/new`, session switch, branch, `/btw`, tree nav; re-injected after retries/compaction. Ambiguity scoring `S = 0.25I + 0.20U + 0.20B + 0.25R + 0.10(1-E)`, material at S >= 0.60, at most one clarifying question. Executor gets a `<task-contract>` block, advisor a compact `<active-task-contract>` block sharing a 16-char digest prefix. Docs: `docs/task-contract-orchestration.md`.

## side-agent protocol (`7f755a2`, `4232bd6`)
Filesystem-based race-safe multi-agent coordination in `.omp/skills/side-agent/`: atomic claim directories (POSIX `mkdir` / PowerShell `New-Item -ErrorAction Stop`; never cmd.exe `mkdir`, which succeeds on existing dirs), double re-validation around result writes, DAG dependency validation, main-agent-only stale-claim reclaim (5 min), heartbeat liveness, write-once results, colon-free ISO-8601 archive timestamps for Windows. Dirs `.side-agent/` and `.side-agent-archive/` are gitignored.

## In-flight (uncommitted as of 2026-07-13)
- **ompk-linear-agent** (`packages/ompk-linear-agent/`): Cloudflare Worker registered as Linear Agent "ompk" — webhook on assign/label, reads `model:<combo-id>` label (combos from `~/.omp/agent/models.yml`), KV job queue, Windows-side relay long-polls `/poll` and runs `omp --print --yolo --model <combo-id>`, results posted back as Linear comments.
- **/help recommender** (`packages/coding-agent/src/help/recommendations.ts`, `docs/help.md`): deterministic feature recommender; `/help <question>` ranks built-in capabilities; unmatched questions fall through to a normal prompt.
- **Multi-agent fork collaboration policy** (`docs/multi-agent-fork-collaboration.md`): one shared fork; one Linear child issue = one owning agent = one branch = one worktree = one PR; branch naming `linear/<issue-key>-<slug>`; single dispatcher owns admission/WIP; single merge owner serializes into main. Explicitly rejects per-agent forks.
- New `mcps/` tree (codegraph, pk-mesh-orchestrator, pk-qmd, simpleaible, tasks) and `evals/agent-gui/`.

## Gotchas
- Fork reads `~/.omp/agent` (not `~/.pi/agent`) for models.yml — see memory note "Fork config dirs".
- `agent-session.ts` now obfuscates preserved archive text via the secrets obfuscator (`3ceb069`).
