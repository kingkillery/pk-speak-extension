# Formal skill contract

Every routable skill should expose inspectable metadata rather than relying on prompt inference alone.

## Required fields

```yaml
name:
version:
owner:
purpose:
activates_when: []
does_not_activate_when: []
inputs:
  required: []
  optional: []
reads: []
writes: []
side_effects: []
confirmation_policy:
  reversible:
  consequential:
output_schema:
verification: []
failure_behavior: []
```

## Routing rules

- A skill is eligible only when every required input can be supplied.
- `does_not_activate_when` takes precedence over a generic activation match.
- Select the smallest set of eligible skills that covers the task.
- Side effects must fit the current execution contract and Kade-HQ autonomy policy.
- A skill that writes state or memory must use the shared capability layer.
- Verification requirements are inherited by the parent execution contract.
- Version and owner must be included in execution logs so routing failures can be traced.

## Example

```yaml
name: decision-packet
version: 1.0.0
owner: kade-hq
purpose: Produce a bounded, actionable decision packet.
activates_when:
  - Multiple viable choices materially affect cost, scope, risk, or schedule.
  - Kade explicitly asks for a recommendation.
does_not_activate_when:
  - A safe reversible default is obvious.
  - The request is informational only.
inputs:
  required: [decision, options]
  optional: [deadline, constraints]
reads: [human.preferences, session.decisions, project.constraints]
writes: [session.pending_decision]
side_effects: []
confirmation_policy:
  reversible: recommend_and_proceed
  consequential: require_confirmation
output_schema: kade-hq/schemas/decision-packet.schema.json
verification:
  - Options are materially distinct.
  - Recommendation follows the stated constraints.
failure_behavior:
  - State the missing evidence.
  - Recommend the safest reversible default.
```
