# State synchronization

Use a shared capability layer for CLI, MCP, UI, and agents.

## Capability registry

Recommended conceptual operations:

```text
context.assemble
state.read
state.update
state.merge
memory.search
memory.propose
memory.approve
handoff.create
handoff.complete
verification.record
skills.status
skills.reconcile
```

Each interface should call these capabilities rather than maintaining separate business logic.

## Write boundaries

- Kade-HQ owns the state and memory policies.
- g-kade may submit narrow operations and memory candidates.
- Executors may return proposed state updates but should not rewrite global state directly unless explicitly authorized.
- Repository-local state stays in the repository unless a deliberate cross-project memory is approved.

## Synchronization record

```yaml
operation_id:
capability:
actor:
source:
timestamp:
dry_run:
inputs_hash:
result:
changed_records: []
conflicts: []
```

## Idempotency

Operations that may be retried should accept or derive an idempotency key. Repeating a successful state update must not duplicate commitments, decisions, or open loops.

## Conflict behavior

- Merge distinct records.
- Flag concurrent edits to the same scalar field.
- Prefer explicit current instructions, but retain superseded provenance.
- Do not resolve conflicting confirmed personal facts or durable memories automatically.
