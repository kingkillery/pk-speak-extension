---
name: llm-wiki-skills
description: Use when the task should consult, capture, validate, evolve, or retire reusable workflow shortcuts through the local `llm-wiki-skills` MCP server or its CLI. This packet-owned wrapper explains the full tool lifecycle in depth and is installable into ~/.agents/skills, ~/.codex/skills, ~/.claude/skills, and ~/.pi/agent/skills.
---

# llm-wiki-skills

This is the packet-owned home-skill wrapper for `llm-wiki-skills`.

Use it when the job is not just "answer this once", but "make this reusable, reviewable, and cheaper next time."

## Startup

1. Read repo-local instructions first.
2. If you are inside an llm-wiki-memory workspace, read `AGENTS.md`, `LLM_WIKI_MEMORY.md`, and `.llm-wiki/config.json` before acting.
3. Verify that the local skill lifecycle plane exists:
- `scripts/llm_wiki_skill_mcp.py`
- `.llm-wiki/skills-registry.json`
- `.llm-wiki/skill-pipeline/`
4. If present, prefer the local MCP workflow over inventing an ad hoc skills registry.

## How To Call

Every MCP tool in this skill has an identical CLI subcommand. When MCP is not wired, call the script directly:

```
python scripts/llm_wiki_skill_mcp.py <subcommand> [options]
```

The script prints a JSON result to stdout and exits 0 on success, 1 on `blocked` or `missing`.

### Quick reference

| MCP tool | CLI subcommand | Key required args |
|---|---|---|
| `skill_lookup` | `lookup` | `--goal` or `--url-pattern` |
| `skill_reflect` | `reflect` | `--title`, `--kind`, `--goal`, `--evidence` |
| `skill_validate` | `validate` | `--title`, `--kind`, `--goal`, `--evidence` |
| `skill_pipeline_run` | `pipeline-run` | `--title`, `--kind`, `--goal`, `--evidence` |
| `skill_propose` | `propose` | `--title`, `--kind`, `--goal`, `--evidence` |
| `skill_evolve` | `evolve` | `--title`, `--kind`, `--goal`, `--evidence` |
| `skill_feedback` | `feedback` | `--skill-id`, `--verdict`, `--reason` |
| `skill_frontier` | `frontier` | (none required) |
| `skill_get` | `get` | `--skill-id` |
| `skill_retire` | `retire` | `--skill-id`, `--reason` |
| `wiki_bootstrap` | `wiki-bootstrap` | (none required) |

### Vault Bootstrap

When `kade-hq` or `g-kade` detects a missing wiki vault, delegate here for a deterministic scaffold:

1. **Directories** — create if missing:
   - `wiki/concepts/`
   - `wiki/entities/`
   - `wiki/skills/active/`
   - `wiki/skills/feedback/`
   - `wiki/skills/retired/`
   - `wiki/comparisons/`
   - `wiki/syntheses/`
   - `wiki/sources/`
   - `wiki/timelines/`
   - `wiki/questions/`
2. **Core files** — create stubs if missing:
   - `wiki/index.md` — taxonomy with Quick Links, Concepts, Entities, Skills, Syntheses, Sources, Timelines, Questions, Comparisons
   - `wiki/log.md` — `# Wiki Log\n\n`
   - `wiki/skills/index.md` — `# Skill Index\n\n`
3. **Config layer** — ensure `.llm-wiki/config.json` and `.llm-wiki/skills-registry.json` exist.
4. **Canvas** — if `wiki/Wiki Canvas.canvas` is missing, regenerate it using the Canvas Maintenance workflow below.
5. **Exit** — return JSON with `{"status": "bootstrapped", "pages": <count>, "canvas": <bool>}`.

Prefer this routine over ad hoc scaffolding so that `g-kade` and `kade-hq` have a single, consistent Layer 0 entry point.

### Common CLI patterns

Look up before starting work:
```
python scripts/llm_wiki_skill_mcp.py lookup --goal "select airport from Google Flights dropdown"
```

Capture a reusable shortcut in one pass:
```
python scripts/llm_wiki_skill_mcp.py pipeline-run \
  --title "Google Flights airport row click" \
  --kind ui \
  --goal "Select the exact airport row from the Google Flights suggestion list" \
  --trigger "Multiple airport rows appear for one city and require an exact row click" \
  --fast-path "Type the city, wait for the suggestion list, click the exact airport row" \
  --evidence "Three sessions confirmed that clicking the exact airport row resolves the ambiguity" \
  --observation "Pressing Enter commits the first suggestion, not the intended one" \
  --failure-modes "Pressing Enter too early commits the wrong airport" \
  --apply "https://www.google.com/travel/flights*"
```

Run an evolution cycle against an existing skill:
```
python scripts/llm_wiki_skill_mcp.py evolve \
  --title "Google Flights airport row click" \
  --kind ui \
  --goal "Select the exact airport row from the Google Flights suggestion list" \
  --evidence "New evidence from multi-airport regression test" \
  --target-skill-id skill-google-flights-airport-row-click \
  --proposal-action edit_skill \
  --surrogate-verdict pass \
  --oracle-verdict pass \
  --benchmark google-flights-regression \
  --iteration 2
```

Check the current frontier:
```
python scripts/llm_wiki_skill_mcp.py frontier --limit 5
```

Inspect a skill record with full lineage:
```
python scripts/llm_wiki_skill_mcp.py get --skill-id skill-google-flights-airport-row-click
```

Record feedback after applying a skill:
```
python scripts/llm_wiki_skill_mcp.py feedback \
  --skill-id skill-google-flights-airport-row-click \
  --verdict upvote \
  --reason "Saved approximately 8 steps in a repeated Google Flights booking flow"
```

Retire a stale skill:
```
python scripts/llm_wiki_skill_mcp.py retire \
  --skill-id skill-legacy-google-flights-enter \
  --reason "Superseded by the click-based airport selection skill"
```

### Subcommand details

Each subcommand accepts the same fields as the corresponding MCP tool input schema.

Required for most write subcommands: `--title`, `--kind`, `--goal`, `--evidence`.

Common optional flags across write subcommands:
- `--workspace` — workspace root (default: current directory)
- `--apply` (repeatable) — URL patterns the skill applies to
- `--problem`, `--trigger`, `--preconditions` — structured context
- `--fast-path` — the reusable shortcut
- `--failure-modes` — what goes wrong without this skill
- `--observation` (repeatable), `--risk` (repeatable) — supporting detail
- `--file` (repeatable), `--reference` (repeatable), `--artifact-ref` (repeatable) — durable refs
- `--memory-scope` — `working`, `episodic`, `semantic`, `procedural`, or `hybrid`
- `--memory-strategy` — `hierarchical`, `knowledge_object`, or `flat`
- `--update-strategy` — `append_only`, `merge_append`, `replace_on_validation`, or `deprecate_on_conflict`
- `--durable-fact` (repeatable) — stable facts worth preserving beyond the immediate run
- `--provenance-ref` (repeatable) — supporting refs used later for audit/deprecation
- `--retrieval-hint` (repeatable) — compact lookup handles for future agents
- `--canonical-key` (repeatable) — write-time reconciliation handles so overlapping skills update/merge instead of duplicating
- `--route-decision` — one of `complete`, `retry_same_worker`, `reroute_to_sibling`, `escalate_to_parent`, `stop_insufficient_evidence`
- `--skip-steps-estimate` — how many steps this shortcut avoids
- `--confidence` — `low`, `medium`, or `high`

Evolve-specific flags:
- `--target-skill-id` — existing skill to edit
- `--proposal-action` — `create_skill`, `edit_skill`, or `discard`
- `--surrogate-verdict` — `pass`, `revise`, or `fail`
- `--oracle-verdict` — external accept/reject signal
- `--verification-mode` — `heuristic`, `objective`, or `subjective_pairwise`
- `--benchmark`, `--iteration`, `--program-id` — tracking fields

Subjective pairwise flags (when `--verification-mode subjective_pairwise`):
- `--subjective-task` — what the judge evaluates
- `--baseline-output` — current skill output
- `--candidate-output` — proposed replacement output
- `--judge-choice` — `A` or `B`
- `--judge-summary`, `--judge-finding` (repeatable) — judge rationale

Run `python scripts/llm_wiki_skill_mcp.py <subcommand> --help` for the full flag list.

## What This Surface Is For

`llm-wiki-skills` is the reusable skill lifecycle plane for the packet.

It is for:

- looking up prior reusable shortcuts before rediscovering them
- capturing reducer packets after meaningful exploration
- validating whether a candidate is safe, distinct, and promotion-worthy
- proposing merges or new active skills
- collecting feedback on whether a saved shortcut actually helped
- evolving skills through repeated review and frontier selection
- retiring stale or harmful skills cleanly

It is not for:

- storing secrets, tokens, API keys, or personal private data
- dumping raw transcripts without a reducer packet
- replacing source-evidence retrieval when `pk-qmd` is the right first move
- creating duplicates when an existing skill should be merged or amended

## Recommended Run Order

1. Start with `skill_lookup` before rediscovering a workflow.
2. If the task required real exploration or produced a repeatable shortcut, capture it with `skill_reflect` or `skill_pipeline_run`.
3. Use `skill_validate` when you need an explicit privacy, overlap, and promotion check.
4. Use `skill_propose`, `skill_feedback`, `skill_evolve`, and `skill_frontier` to improve the library over time.
5. Use `skill_get` when you need the full record or lineage of an existing entry.
6. Use `skill_retire` when a skill is stale, unsafe, superseded, or actively misleading.

## Tool Guide

### `skill_lookup`

Use this first when you suspect the library may already contain a shortcut.

Use it to:

- search for an existing skill by trigger, task shape, or domain
- avoid duplicated work before starting broad exploration
- decide whether to reuse, amend, or supersede an existing entry

Good default behavior:

- run `skill_lookup` before a long or repetitive operational task
- prefer reusing an existing high-confidence shortcut if it matches the current preconditions
- if the hit is partial, use it as the seed for reflection instead of inventing a brand-new skill from scratch

### `skill_reflect`

Use this after meaningful work when you want to capture the reusable lesson without promoting it blindly.

Use it to record:

- the repeated trigger
- the shortest reliable fast path
- preconditions
- failure modes
- artifact references
- a reducer packet for long tasks

This is the right tool when:

- the task took real exploration cost
- you found a stable shortcut
- you want a packet and review trail before deciding whether it belongs in the active library

For long tasks, do not save only a summary. Save a reducer packet plus artifact refs so future agents can escalate into the underlying evidence when needed.

### `skill_validate`

Use this when the candidate exists but should not be promoted on trust alone.

Validation should answer:

- does this contain secrets or sensitive data
- does this duplicate an existing skill
- are the trigger and fast path concrete enough
- are the preconditions and failure modes explicit
- should this merge into an existing record instead of creating a new one

Use it whenever:

- the candidate may overlap with an existing skill
- the material came from a long or messy session
- privacy or evidence boundaries are not obvious
- you want a formal gate before proposal or promotion

### `skill_pipeline_run`

Use this when you want the full packet-native pipeline in one pass.

This is the best default when the task produced a real reusable shortcut and you want:

- reflection
- validation
- proposal or merge output
- durable artifact placement under `.llm-wiki/skill-pipeline/`

Prefer `skill_pipeline_run` over a manual sequence when:

- you want the standard packet workflow
- the task already justified a reusable skill candidate
- you want fewer chances to skip a validation step

### `skill_propose`

Use this when you want an explicit candidate proposal or merge proposal, not just a reflection record.

Typical use:

- propose a new active skill candidate
- propose a delta against an existing skill
- prepare a candidate for review after validation

Use it when the important question is:

- "should this become an active reusable shortcut"

instead of:

- "what did we learn from the session"

### `skill_feedback`

Use this after a saved skill has been applied in the real world.

Feedback should capture whether the skill:

- actually saved time
- failed under a new edge case
- needs tighter preconditions
- should be merged, narrowed, or retired

Use feedback to improve the library instead of silently bypassing a bad or stale skill.

### `skill_evolve`

Use this when accumulated proposals, feedback, and review history justify a better version of the skill.

This is for deliberate improvement, not casual editing.

Typical evolution inputs include:

- repeated positive or negative feedback
- surrogate review artifacts
- validator findings
- frontier comparisons

Use it when you want the library to improve based on evidence instead of ad hoc rewrites.

### `skill_frontier`

Use this when you need the best current evolved candidates, not just the most recent raw proposals.

This is useful for:

- deciding which version should be treated as the current best shortcut
- checking whether an evolved candidate outperforms the active record
- surfacing the best-known entry after multiple iterations

### `skill_get`

Use this when you need the full stored record for a specific skill or candidate.

Use it to inspect:

- current content
- lineage
- proposal history
- validation trail
- associated packets or artifacts

This is the "show me the exact record" tool.

### `skill_retire`

Use this when a skill should stop being recommended.

Retire a skill when it is:

- stale because the environment changed
- misleading because the trigger is too broad
- superseded by a better frontier candidate
- unsafe because it encouraged private or brittle behavior

Retirement is preferable to leaving a known-bad shortcut active.

## Quality Bar

A solid reusable skill should include:

- a clear repeated trigger
- a compact, reliable fast path
- explicit preconditions
- explicit failure modes
- artifact references when the task had depth
- a memory scope that says what kind of durable knowledge this is
- a non-flat memory strategy for long or expensive trajectories
- durable facts plus provenance refs so the skill behaves like a knowledge object, not a vague note
- canonical reconciliation keys so writes can merge/update cleanly
- enough specificity that another agent can execute it without guesswork

If the shortcut still depends on hidden context in your head, it is not ready.

Modern packet default:

- most `ui` and `http` skills are **procedural** memory
- long workflow captures begin as **episodic** or **hybrid** memory
- prompt/style skills often become **semantic** memory
- the pipeline should promote raw episodes into hierarchical summaries before saving them as active procedural memory

## Wiki Canvas Maintenance

When the wiki grows beyond a handful of pages, maintain a visual canvas that maps concepts, entities, and relationships so agents can navigate the knowledge graph at a glance.

### Creating a Canvas

1. Scan all `wiki/**/*.md` files (excluding `log.md`).
2. Create one node per markdown file using Obsidian canvas JSON format:
   - `type: "file"` with `file` set to the relative path from wiki root
   - Position nodes in a grid (~4 columns) with spacing of ~400×300
   - Size: 320×240 per node
3. Scan each file for markdown internal links `[text](path)`.
4. Create edges (`fromNode` → `toNode`) for every resolved link.
5. Write the result to `wiki/Wiki Canvas.canvas`.

### Canvas JSON Structure

```json
{
  "nodes": [
    {
      "id": "node0",
      "type": "file",
      "file": "concepts/exact-approval.md",
      "x": 0,
      "y": 0,
      "width": 320,
      "height": 240
    },
    {
      "id": "node1",
      "type": "text",
      "text": "# Concepts\nCore ideas",
      "x": -200,
      "y": -100,
      "width": 180,
      "height": 60
    }
  ],
  "edges": [
    {
      "id": "edge0",
      "fromNode": "node0",
      "toNode": "node2",
      "fromSide": "right",
      "toSide": "left",
      "color": "#6c6c6c"
    }
  ]
}
```

### Group Nodes (Optional)

Add labeled group nodes for each wiki subdirectory so the canvas shows taxonomy visually:

| Group | Color | Contains |
|-------|-------|----------|
| Concepts | `#e3f2fd` | `concepts/*.md` |
| Entities | `#f3e5f5` | `entities/*.md` |
| Syntheses | `#e8f5e9` | `syntheses/*.md` |
| Skills | `#fff3e0` | `skills/*.md` |
| Sources | `#fce4ec` | `sources/*.md` |
| Timelines | `#e0f2f1` | `timelines/*.md` |
| Questions | `#fbe9e7` | `questions/*.md` |

### When to Update

- After adding 3+ new wiki pages
- After moving or renaming pages
- After a major restructure of `wiki/index.md`
- When an agent reports the canvas is stale or missing links

### Quick Check

Before considering canvas work complete:
- [ ] All `.md` files in `wiki/` (except `log.md`) appear as nodes
- [ ] All internal markdown links appear as edges
- [ ] No orphaned nodes that should be connected
- [ ] Canvas opens in Obsidian without JSON parse errors
- [ ] `wiki/index.md` links to the canvas

## Packet Integration

- `LLM_WIKI_MEMORY.md` describes the stack-level routing policy.
- `SKILL_CREATION_AT_EXPERT_LEVEL.md` is the implementation guide for high-quality skill capture.
- `.llm-wiki/skills-registry.json` is the canonical local registry state.
- `.llm-wiki/skill-pipeline/` stores briefs, packets, validations, proposals, surrogate reviews, evolution runs, frontier data, and failure artifacts.

## MCP vs CLI

When the MCP server is wired into the agent runtime, use the MCP tools directly. When MCP is not available (plain shell, Codex, Droid CLI, or CI), use the CLI subcommands documented above. Both surfaces accept the same fields and produce the same JSON output. The CLI is the authoritative fallback; MCP is the ergonomic default.

## Constraints

- Do not store secrets, credentials, or private personal data.
- Do not promote vague summaries as reusable skills.
- Do not create a duplicate when a merge or delta is the correct move.
- Prefer reducer packets plus artifact refs for long tasks.
- Prefer `pk-qmd` for source evidence and `llm-wiki-skills` for reusable shortcut lifecycle; do not confuse the two roles.
