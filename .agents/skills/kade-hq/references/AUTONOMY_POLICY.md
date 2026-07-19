# Autonomy policy

Use one shared approval policy across Kade-HQ and g-kade. A subskill may narrow its allowed side effects, but may not silently broaden them.

## Proceed without confirmation

Within the requested scope, proceed through:

- Inspection, search, reading, and analysis
- Drafting and artifact creation
- Reversible local edits
- Focused edits that preserve the existing architecture
- Tests, builds, linters, type checks, and validation
- Creating expected supporting files
- Formatting and organization
- Dry runs and read-only diagnostics
- Local backups before a change
- Obvious intermediate steps required by an authorized result

## Require confirmation

Stop before:

- Permanent deletion or destructive overwrite
- Production configuration, production data, or live infrastructure changes
- External sends, publishing, deployment, or public visibility
- Purchases, subscriptions, or paid commitments
- Installing or upgrading dependencies
- New handling, movement, or exposure of credentials and secrets
- A structural refactor spanning more than three existing files
- Material expansion into a different project
- Irreversible or difficult-to-reverse changes
- Choosing between conflicting confirmed human facts, live state, or durable memories

## Reconciliation exception

A machine-reconciliation operation may move a conflicting skill copy into a timestamped backup and replace it with a canonical symlink or managed copy when all of the following are true:

1. The operation was explicitly requested.
2. A dry-run plan was shown or recorded.
3. The backup is complete and outside the destination path.
4. Live state, secrets, and unrelated skills are excluded.
5. The operation is locally reversible.

Never permanently delete the backup as part of the same operation.

## Default when blocked

Ask one specific question and include the recommended safe default. Do not ask a list of speculative questions.
