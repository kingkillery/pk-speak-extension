# Verification gate

Verification must match the claim being made.

## Minimum evidence by task

| Task | Minimum evidence |
|---|---|
| Code change | Relevant tests or focused execution, plus static/build checks when available |
| Bug fix | Reproduction before or evidence of original failure, then passing behavior after |
| Configuration | Parse/validation and target-specific dry run; no production apply without authorization |
| Document | Content inspection and format/render inspection when layout matters |
| Data transform | Row/count/checksum or sample reconciliation and explicit handling of rejects |
| Research | Primary/current sources and distinction between evidence and inference |
| Machine reconciliation | Pre/post inventory, backups, target resolution, hashes, and clean final dry-run |

## Result schema

```yaml
artifact_exists:
expected_behavior_demonstrated:
tests_run:
  - command:
    exit_code:
    result:
static_checks: []
manual_inspection: []
unverified_items: []
regressions_checked: []
cleanup_completed:
evidence_paths: []
verified_at:
```

## Completion language

Allowed:

```text
Implemented: [what changed]
Verified: [specific checks and results]
Not verified: [specific omissions]
Remaining risk: [material risk]
```

Not allowed:

- “Done” after only editing files
- “Tests pass” without a recorded command/result
- “Production-ready” without production-equivalent validation
- “No regressions” when only one happy path was checked
