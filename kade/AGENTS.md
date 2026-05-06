# AGENTS.md

This `kade/AGENTS.md` file is the KADE overlay for a packet-backed workspace.

Load order:

- `~/.kade/HUMAN.md` when present
- repo root `AGENTS.md`
- repo root `LLM_WIKI_MEMORY.md`
- repo root `.llm-wiki/config.json`
- this file
- `kade/KADE.md`

Boundaries:

- packet root files own search, memory, MCP wiring, and workspace scaffolding
- this overlay owns KADE-specific session structure and handoff expectations
- richer g-kade and gstack runtimes belong in repo-owned dependency paths, not home wrappers alone
- do not overwrite root packet files with KADE-specific content

Repo runtime contract:

- `g-kade`: `missing` at `deps/pk-skills1/gstack/g-kade`
- `gstack`: `missing` at `deps/pk-skills1/gstack`

Workspace root: `C:\dev\Desktop-Projects\pi-speak-extension`
