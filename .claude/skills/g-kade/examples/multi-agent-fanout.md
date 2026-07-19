# Example: safe multi-agent fan-out

## Objective

Add an event ingestion feature spanning an API adapter, persistence, and documentation.

## Ownership

| Agent | Exclusive ownership | Strategy family |
|---|---|---|
| A | `src/adapters/` and adapter tests | minimal_adapter |
| B | `src/storage/` and storage tests | existing_repository_pattern |
| C | `docs/` and examples | operator_handoff |
| Reconciliation owner | Shared interfaces and final integration | integration_owner |

Shared interface files are edited only by the reconciliation owner after reviewing agent outputs.

## Gate

The parent task is complete only after integration tests, type checks, and documentation commands are verified in the reconciled worktree.
