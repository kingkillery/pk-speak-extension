# Memory governance

Memory should improve continuity without turning guesses, temporary constraints, or stale state into permanent truth.

## Roles in the memory stack

Keep these roles distinct:

| Layer | Role |
|---|---|
| Obsidian/wiki | Human-readable, intentional knowledge and synthesis |
| `pk-qmd` | Retrieval over source documents and evidence |
| `brv` | Normalized durable memory with provenance |
| GitVizz | Graph and repository navigation |
| Session state | Current, temporary execution context |

Do not collapse all layers into one store or let a generated summary replace raw evidence.

## Promotion flow

```text
Captured observation
  → temporary session context
  → candidate durable memory
  → freshness/conflict check
  → human-confirmed or policy-approved promotion
  → durable memory with source and date
```

## Required memory fields

```yaml
statement:
type: preference | fact | decision | procedure | project_state
source:
recorded_at:
valid_until:
confidence:
scope:
supersedes:
status: candidate | confirmed | stale | conflicted | retired
```

## Promotion rules

May be promoted without another question only when all are true:

- Kade stated it explicitly as a stable preference or fact.
- It does not conflict with a newer explicit instruction.
- Its scope is clear.
- The source and date are recorded.
- It is not sensitive data that should remain ephemeral.

Require confirmation for:

- Agent inference
- A preference inferred from one interaction
- Personal facts from an uncertain source
- A conflict between confirmed memories
- Broadening a project-specific instruction into a global preference

## Freshness and conflict

- Current explicit instructions override older memory for the current task.
- Mark superseded entries; do not silently erase provenance.
- Use `valid_until` for time-sensitive facts.
- Preserve raw evidence even when a synthesis changes.
- When sources conflict, report the conflict and avoid guessing.
