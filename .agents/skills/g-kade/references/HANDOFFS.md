# Agent handoffs and fan-out

## Handoff contract

Every delegated task should contain:

```yaml
objective:
definition_of_done:
exclusive_scope:
files_or_systems_owned: []
inputs: []
constraints: []
non_goals: []
required_evidence: []
validation: []
allowed_side_effects: []
blocked_actions: []
strategy_family:
collision_policy:
reconciliation_owner:
return_format:
```

## Ownership rules

- One agent owns each mutable file or subsystem at a time.
- Shared read access is acceptable; shared write access must be serialized.
- The reconciliation owner resolves API contracts and integration points.
- An agent that discovers necessary out-of-scope work records it as an open loop rather than editing silently.
- Scope expansion requires a new contract or explicit approval when material.

## Return packet

```yaml
status: completed | partial | blocked
result_summary:
artifacts: []
files_changed: []
commands_run: []
evidence: []
unverified_items: []
open_loops: []
decisions_needed: []
state_updates: []
```

## Failure behavior

When blocked:

1. Preserve all completed work.
2. State the exact blocking condition.
3. Provide the smallest safe next step or decision.
4. Do not mark the parent task complete.
5. Do not improvise around a blocked safety or authorization boundary.
