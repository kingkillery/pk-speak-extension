# Skill Creation At Expert Level

This vault supports reusable skill creation, not just generic wiki summarization.

The goal is to capture a solved workflow once, then make future agents exploit that
learning instead of paying exploration cost again.

## Core principle

Treat the skill system as an ACE-style loop:

1. Generation: finish the task or trajectory.
2. Reflection: emit a strong middle-manager reducer packet that explains the important context and references the supporting artifacts.
3. Validation: check privacy, structure, evidence quality, duplicate overlap, and route semantics.
4. Curation: merge into the existing skill library or save a new skill only when the route decision is `complete`.

Do not monolithically rewrite the library on every task. Prefer delta updates, reasoned
feedback, and grow-and-refine behavior.

## What counts as a skill

A skill is a reusable recipe for a repeated task shape.

Good candidates:

- UI quirks that take multiple retries to learn
- stable navigation flows
- repeated repo workflows
- structured prompts that consistently outperform generic prompting
- API or HTTP request patterns discovered from successful execution
- failure recovery playbooks that reliably unblock future runs

Bad candidates:

- one-off personal data
- transient runtime state
- credentials, tokens, or identifiers
- a summary with no operational shortcut
- advice that is already obvious from the source repo docs

## Storage model

Store skills in markdown so they can be searched, reviewed, and edited:

- `wiki/skills/index.md` for the registry
- `wiki/skills/active/` for live skills
- `wiki/skills/feedback/` for reasoned reviews
- `wiki/skills/retired/` for deprecated or unsafe skills

Internal pipeline artifacts live under:

- `.llm-wiki/skill-pipeline/briefs/`
- `.llm-wiki/skill-pipeline/deltas/`
- `.llm-wiki/skill-pipeline/validations/`
- `.llm-wiki/skill-pipeline/packets/`

When the local MCP server is installed, prefer the tool layer for lifecycle operations:

- `skill_lookup`
- `skill_reflect`
- `skill_validate`
- `skill_pipeline_run`
- `skill_propose`
- `skill_feedback`
- `skill_get`
- `skill_retire`

The tool layer should update the markdown registry, not bypass it.

## Long-task briefing rule

For long tasks, investigations, or any run with meaningful exploration cost, always
capture a strong reducer packet before proposing a skill.

Think: middle managers organizing the signal for executives.

The packet should cover:

- goal
- outcome
- important context
- key observations
- risks
- next actions
- files or references that matter

If a task ran long and you cannot explain the context cleanly with a route decision and artifact refs, you are not ready to save the skill.

## Skill page schema

Every active skill page should use frontmatter like:

```yaml
---
id: skill-google-flights-location-dropdown
title: Google Flights location dropdown requires suggestion click
status: active
kind: ui
applies_to:
  - https://www.google.com/travel/flights*
score: 0
helpful_count: 0
harmful_count: 0
skip_steps_estimate: 8
confidence: medium
pii_review: passed
validation_status: validated
validation_score: 8
http_candidate: false
source_type: trajectory
last_validated: 2026-04-08
brief_refs:
  - .llm-wiki/skill-pipeline/briefs/20260408-...
---
```

Then structure the page body with:

1. `Problem`
2. `Trigger`
3. `Preconditions`
4. `Fast Path`
5. `Failure Modes`
6. `Feedback Summary`
7. `Validation Summary`
8. `Brief References`
9. `HTTP Upgrade Candidate`
10. `Evidence`

## Validation model

Validation is not optional. Before a skill becomes active, check:

- privacy and PII leakage
- trigger clarity
- fast-path quality
- evidence strength
- failure-mode coverage
- estimated exploration savings
- duplicate overlap with existing active skills
- long-task briefing presence when the task was large

Validation outcomes:

- `validated`: safe to save
- `needs_revision`: useful candidate, but missing important structure
- `merge_recommended`: overlaps a live skill strongly enough that the delta should be merged
- `blocked`: do not save

## Feedback model

Skills are social objects. A vote without a reason is low value.

Every feedback entry should include:

- skill id
- verdict: `upvote`, `downvote`, or `amend`
- score delta
- written reason
- observed edge case or confirming evidence
- timestamp

The reason is part of the improvement loop.

- upvotes strengthen confidence and can add confirming evidence
- downvotes should feed new edge cases into failure modes
- amendments should refine the skill rather than starting over

If repeated downvotes drive the score below `-3`, move the skill to `wiki/skills/retired/`
and mark it as retired in the index.

## Grow-and-refine rules

Do not create a new skill when a delta belongs inside an existing one.

Prefer:

- merging into an existing skill when the trigger and applies-to pattern overlap strongly
- appending new failure modes or evidence instead of rewriting whole sections
- keeping validation and brief artifacts as append-only history
- de-duplicating semantically similar skills before saving

## Privacy gate

Before saving a skill:

- strip emails, tokens, cookies, phone numbers, addresses, account ids, and session ids
- replace user-specific selectors or values with stable generic detection rules
- reject the skill entirely if the shortcut depends on private data

If privacy review is uncertain, mark the skill as blocked and do not store it as active.

## HTTP-level upgrade path

UI skills are the first layer. HTTP skills are the next layer.

When the agent can infer a stable underlying request from repeated successful use:

- describe the API shape
- document required headers and payload fields generically
- never store secrets
- mark `http_candidate: true`

Do not claim an HTTP shortcut is production-safe unless the request shape is grounded in evidence.

## Expert-level creation workflow

When asked to create or update a skill:

1. Read existing skill pages and feedback first.
2. Run `skill_lookup` before exploring if the right page is not already known.
3. Run `skill_reflect` or `skill_pipeline_run` to produce the reducer packet, artifact refs, and candidate delta.
4. Run `skill_validate` when you need an explicit review pass before save.
5. Save or merge only after validation passes and the route decision is `complete`.
6. Update the index.
7. Append a log entry to `wiki/log.md`.

When asked to review a skill:

1. Read the active skill.
2. Read prior feedback.
3. Add a reasoned review entry.
4. Amend or retire the skill if the evidence supports it.

## Index expectations

`wiki/skills/index.md` should track:

- active skills
- current score
- validation status and score
- kind (`ui`, `http`, `workflow`, `prompt`)
- applies-to pattern
- retirement pointer when relevant

## Lint expectations

Wiki lint should also check:

- duplicate skills covering the same pattern
- active skills missing privacy review
- active skills with weak triggers or no fast path
- retired skills still linked as active
- feedback entries without reasons
- long tasks that created no brief before skill save
