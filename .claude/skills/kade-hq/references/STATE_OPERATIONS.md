# State operations

Live state should be modified through narrow, auditable operations rather than whole-file replacement.

## Canonical operations

```text
state.read
state.set_current_outcome
state.set_definition_of_done
state.add_constraint
state.add_decision
state.add_open_loop
state.resolve_open_loop
state.add_waiting_on
state.resolve_waiting_on
state.capture_tangent
state.add_commitment
state.update_commitment
state.complete_commitment
state.set_next_action
state.record_verification
state.note_conflict
```

Each write should include:

```yaml
operation:
value:
source:
actor:
timestamp:
reason:
```

## Merge rules

1. Preserve source and date for imported state.
2. Prefer an explicit current instruction over older state.
3. Do not silently merge contradictory decisions.
4. Mark stale items; do not delete them merely because they are old.
5. Do not treat captured ideas as commitments.
6. Do not replace an existing state file with a template.
7. When two agents write concurrently, merge distinct list entries and flag conflicts on the same field.
8. Resolve an item by recording resolution and date; retain enough history for handoff and audit.

## Visibility

Keep working state internal unless:

- Kade asks for status
- Context appears lost
- Scope is changing
- A handoff is occurring
- A commitment or dependency may be forgotten

When surfaced, show only the relevant slice rather than the full ledger.
