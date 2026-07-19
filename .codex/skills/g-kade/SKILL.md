---
name: g-kade
description: How agents execute work for Kade. Use when starting substantive or multi-step work, discovering workspace and repository instructions, selecting skills or tools, assembling minimal context, delegating or handing off work, verifying results, or synchronizing state. Do not use for simple direct answers, Kade's profile or governance (use kade-hq), or repository-specific implementation truth (use repo-local instructions).
version: 2.0.0
---

# g-kade

## Purpose: how agents execute work

`g-kade` coordinates execution between a request, Kade-HQ, repository instructions, skills, tools, and temporary agents.

It:

- Discovers the workspace and repository instructions.
- Selects relevant skills, tools, and execution targets.
- Assembles the minimum task-specific context.
- Defines execution contracts and delegates independently owned work.
- Coordinates handoffs and prevents edit collisions.
- Verifies results before completion claims.
- Synchronizes relevant state, decisions, open loops, and evidence.

It does not:

- Duplicate Kade's profile or human-context rules.
- Create an independent durable-memory system.
- Replace repository-local implementation truth.
- Reimplement tool-specific business logic across CLI, MCP, and UI.

Use `kade-hq` for human context and governance. Use repository-local files for implementation constraints.

## Required references

Read only the references required by the task:

| Need | Reference |
|---|---|
| Instruction and evidence ordering | `references/CONTEXT_PRECEDENCE.md` |
| Repository and environment inspection | `references/WORKSPACE_BOOTSTRAP.md` |
| Selecting agent/tool/workflow | `references/ROUTING.md` |
| Inspecting routable skill metadata | `references/SKILL_CONTRACT.md` |
| Delegation or fan-out | `references/HANDOFFS.md` |
| Completion claim | `references/VERIFICATION.md` |
| Project/session/memory update | `references/STATE_SYNC.md` |

## Orchestration loop

For delegated, multi-step, or multi-agent work:

1. **Discover** the workspace, repository, local instructions, execution environment, and current working-tree state.
2. **Classify** the request by task type, risk, expected duration, and required capabilities.
3. **Assemble** a minimal context packet using the precedence rules.
4. **Select** the smallest set of skills and agents necessary.
5. **Contract** the work with an objective, observable definition of done, scope, side-effect boundary, evidence requirements, and return format.
6. **Execute** in the current workspace or a safe isolated workspace as appropriate.
7. **Verify** the artifact and behavior. Do not equate file edits with completion.
8. **Synchronize** relevant decisions, open loops, verification evidence, and memory candidates.
9. **Return** the verified result directly.

For a focused edit or direct question, take the fast path: execute, verify as appropriate, and answer. Do not add orchestration ceremony.

Do not narrate every routing or tool decision. Surface only meaningful milestones, scope changes, blockers, or findings.

## Workspace discovery

Before proposing architecture or editing code, determine:

```yaml
workspace_root:
repo_identity:
current_branch:
working_tree_status:
instruction_files: []
languages: []
package_manager:
test_commands: []
build_commands: []
risk_boundaries: []
available_execution_targets: []
```

Repository-local `AGENTS.md`, `CLAUDE.md`, skill files, and project documentation override general implementation preferences within their scope unless they conflict with a current explicit user instruction or safety boundary.

Do not assume the home directory is the workspace. The invoked repository is the default workspace root.

## Context assembly

Build a small, labeled packet instead of flattening every available memory and instruction into one prompt.

Required categories:

```yaml
request:
facts: []
current_decisions: []
repo_instructions: []
human_preferences: []
constraints: []
assumptions: []
unresolved_conflicts: []
source_map: []
```

Apply the precedence rules in `references/CONTEXT_PRECEDENCE.md`.

- Facts and assumptions must remain distinguishable.
- Current explicit instructions override stale memory.
- Inject only Kade-HQ rules relevant to the current task.
- Preserve source and date when context may be stale or disputed.

## Routing

Use the lightest capable route. Routable skills should conform to `references/SKILL_CONTRACT.md` and `schemas/skill-contract.schema.json`.

| Task | Default route |
|---|---|
| One focused repository edit | Current coding agent in the current or isolated workspace |
| Broad architecture investigation | Research/planning pass, then implementation |
| Independent file/subsystem work | Parallel agents with exclusive ownership |
| Local desktop action | Local computer-use tool/agent |
| Long-running isolated implementation | Disposable remote worker with a handoff contract |
| Email/calendar write | Connected app tool with explicit send/write gate |
| Personal planning or overload | Triggered Kade-HQ executive-function support |
| Simple answer | Answer directly; do not orchestrate |

Do not invoke a heavyweight fan-out for a one-file fix.

## Execution contract

Every delegated or tool-driven implementation should define:

```yaml
objective:
definition_of_done:
exclusive_scope:
inputs: []
constraints: []
non_goals: []
allowed_side_effects: []
blocked_actions: []
required_evidence: []
validation: []
return_format:
```

For a consequential action, include a review gate and stop before crossing it.

## Multi-agent fan-out

Parallelize only work that can be independently owned.

Each agent receives:

- Exclusive files, subsystem, or question ownership
- A distinct strategy family when approaches intentionally differ
- Explicit non-goals
- Required evidence and return schema
- A collision policy
- A named reconciliation owner

Do not let two agents silently edit the same files. If shared files are unavoidable, serialize changes or assign one merge owner.

## Verification gate

No executor may report `done` solely because files changed or a command exited without inspection.

Require evidence appropriate to the task:

```yaml
artifact_exists:
expected_behavior_demonstrated:
tests_run: []
static_checks: []
manual_inspection: []
unverified_items: []
regressions_checked: []
cleanup_completed:
```

User-facing reporting distinguishes:

```text
Implemented:
Verified:
Not verified:
Remaining risk:
```

Omit empty sections, but never imply a check was performed when it was not.

## State and memory synchronization

At meaningful boundaries, record only what changed:

- Current outcome or definition of done
- Decisions and their reason
- Open loops or waiting-on items
- Commitments that meet Kade-HQ criteria
- Verification evidence
- Memory candidates with provenance

Use Kade-HQ narrow state and memory operations. `g-kade` may pass memory candidates to Kade-HQ, but it must not create or maintain a separate memory store. Never rewrite live state wholesale.

## Skill maintenance

Machine installation, doctor, status, and repair are maintenance paths—not ordinary task execution. Use the packet's `scripts/reconcile_skills.py`, default to dry-run, back up conflicts, and never replace live state or durable memory with templates. `kade-hq` is canonical; `kade-headquarters` is a retired compatibility name.

## Completion standard

The orchestrated task is complete only when:

1. The requested artifact or outcome exists.
2. Required validation has run.
3. Results were inspected sufficiently to support the claim.
4. Material unverified items are explicit.
5. State and handoff records are updated when relevant.
6. Temporary execution debris is cleaned up or intentionally retained and named.

Return the result, not an orchestration diary.
