---
id: skill-llm-as-a-verifier-cli-skill
title: "LLM-as-a-verifier CLI skill"
status: active
kind: workflow
applies_to:
  - "skill:llm-as-verifier"
  - "repo:C:\\dev\\Desktop-Projects\\pi-speak-extension"
score: 0
helpful_count: 0
harmful_count: 0
skip_steps_estimate: 6
confidence: high
pii_review: passed
validation_status: validated
validation_score: 33
http_candidate: false
source_type: trajectory
memory_scope: "procedural"
memory_strategy: "knowledge_object"
update_strategy: "merge_append"
durable_facts: ["The verifier tool source lives at C:\\dev\\Desktop-Projects\\llm-as-a-verifier and exposes verifier-collect, verify-trajectories, and evaluate-verifier CLI commands.", "Agents must run the real CLI and must not report LLM-as-a-verifier success if the CLI did not run."]
provenance_refs: [".codex/skills/llm-as-verifier/SKILL.md", ".agents/skills/llm-as-verifier/SKILL.md", ".llm-wiki/skill-pipeline/briefs/20260506-223259--llm-as-a-verifier-cli-skill.md"]
retrieval_hints: ["llm-as-verifier", "verify-trajectories", "verifier-collect"]
canonical_keys: ["llm-as-verifier-cli"]
last_validated: 2026-05-06
brief_refs: [".llm-wiki/skill-pipeline/briefs/20260506-223259--llm-as-a-verifier-cli-skill.md"]
evolution_count: 0
frontier_status: "inactive"
parent_skill_id: ""
proposal_refs: []
evolution_run_refs: []
created_at: 2026-05-06T22:32:59Z
updated_at: 2026-05-06T22:32:59Z
---

## Problem

Teach agents to use the real local llm-as-a-verifier CLI rather than simulating verification

## Trigger

User asks for llm-as-a verifier, verifier-gated coding-agent work, or comparison of candidate agent trajectories

## Preconditions

The local verifier repo exists at C:\dev\Desktop-Projects\llm-as-a-verifier; the receiving repo can write a .verifier directory; meaningful command, diff, or final-answer evidence can be collected

## Memory Role

- Scope: `procedural`
- Strategy: `knowledge_object`
- Update strategy: `merge_append`

## Durable Facts

- The verifier tool source lives at C:\dev\Desktop-Projects\llm-as-a-verifier and exposes verifier-collect, verify-trajectories, and evaluate-verifier CLI commands.
- Agents must run the real CLI and must not report LLM-as-a-verifier success if the CLI did not run.

## Retrieval Hints

- llm-as-verifier
- verify-trajectories
- verifier-collect

## Provenance

- .codex/skills/llm-as-verifier/SKILL.md
- .agents/skills/llm-as-verifier/SKILL.md
- .llm-wiki/skill-pipeline/briefs/20260506-223259--llm-as-a-verifier-cli-skill.md

## Reconciliation Keys

- llm-as-verifier-cli

## Fast Path

Check verifier-collect and verify-trajectories; if missing install with python -m pip install --user -e C:\dev\Desktop-Projects\llm-as-a-verifier; run verifier-collect init; wrap test/build commands with verifier-collect run; capture git diff with verifier-collect diff; record the final claim with verifier-collect final; run verify-trajectories; inspect .verifier\verification_result.json before finalizing

## Failure Modes

Agent simulates verifier output instead of running the CLI; CLI is unavailable and the agent claims verification anyway; .verifier\verifier.toml uses incorrectly quoted Windows paths; final answer claims success that is unsupported by captured command or diff evidence

## Feedback Summary

- No feedback yet

## Validation Summary

- No validation warnings recorded.

## Brief References

- .llm-wiki/skill-pipeline/briefs/20260506-223259--llm-as-a-verifier-cli-skill.md

## Merge History

- No merge history.

## EvoSkill Lineage

Frontier status: `inactive`

Evolution count: 0

Parent skill: `none`

### Proposal References

- No proposal history.

### Evolution Runs

- No evolution runs.

### Lineage Notes

- No lineage notes.

## HTTP Upgrade Candidate

No

## Evidence

Created .codex/skills/llm-as-verifier/SKILL.md and .agents/skills/llm-as-verifier/SKILL.md; both passed quick_validate.py; verifier-collect --help and verify-trajectories --help worked from the pi-speak-extension repo
Files involved:
- .codex/skills/llm-as-verifier/SKILL.md
- .agents/skills/llm-as-verifier/SKILL.md
