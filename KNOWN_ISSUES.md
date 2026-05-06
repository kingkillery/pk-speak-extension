# Known Issues

## Open Operational Risks

- The local gateway is still a single Node process. It is intentionally thin, but high-volume or public traffic should terminate at a real reverse proxy or edge layer instead of this process.
- GitVizz still depends on an external checkout. The packet now records the managed checkout path and repo source explicitly, but GitVizz is not yet vendored like `deps/pk-skills1`.
- Root release installers remain separate shell and PowerShell entrypoints because they must bootstrap the repo before any shared repo file exists.

## Tracking Rules

- Add confirmed source-level bugs here instead of hiding them only in memory notes.
- Mirror durable contract changes into `SYSTEM_CONTRACT.md`, `.factory/memories.md`, `kade/KADE.md`, and the official Obsidian system map note.
- Remove entries when a fix ships and verification is recorded in tests or CI.
