# Workspace bootstrap

## Objective

Identify the actual execution environment before modifying it.

## Inspect

```text
- current directory and repository root
- Git branch, worktree, remotes, and uncommitted changes
- AGENTS.md, CLAUDE.md, README, package manifests, and local skills
- language and package-manager files
- test, build, lint, and type-check commands
- local/remote execution targets
- generated files and ignored paths
- production or secret-bearing configuration boundaries
```

## Workspace rules

- Use the invoked repository as the default workspace root.
- Do not assume `$HOME` or a central harness directory is the active project.
- Preserve existing repository conventions before applying global preferences.
- For broad or risky edits, prefer a feature worktree created from updated main.
- Do not discard uncommitted work.
- Stop on Git merge conflicts.
- Do not install dependencies without approval.

## Standard worktree flow

```bash
git status
git branch --show-current
git switch main
git pull --ff-only
git worktree add -b feature/<feature-name> ../<repo-name>-<feature-name> main
```

Merge only after validation:

```bash
git status
# commit focused worktree changes
git switch main
git pull --ff-only
git merge --no-ff feature/<feature-name>
# clean up only after a successful merge and explicit local policy allows it
```

## Bootstrap output

```yaml
workspace_root:
repo_identity:
branch:
worktree_status:
instruction_files: []
package_manager:
languages: []
test_commands: []
build_commands: []
production_boundaries: []
secrets_boundaries: []
execution_targets: []
```
