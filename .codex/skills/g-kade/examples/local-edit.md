# Example: focused local edit

## Request

Fix one API handler without changing dependencies.

## Route

```yaml
task_class: focused_repository_edit
preferred_agent: current_coding_agent
execution_target: current_worktree
parallelism: 1
review_gate: dependency_or_production_boundary
```

## Contract

```yaml
objective: Correct the handler's invalid status-code behavior.
definition_of_done: Focused tests reproduce the old failure and pass after the change.
exclusive_scope: Handler file and its focused tests.
constraints:
  - No new dependencies.
  - Preserve public API shape.
non_goals:
  - Broad routing refactor.
required_evidence:
  - Before/after focused test result.
  - Existing relevant test suite result.
blocked_actions:
  - Dependency installation.
  - Production deployment.
```
