---
name: g-kade
description: Repo-local KADE bridge layered on top of the llm-wiki-memory packet.
---

# g-kade

This is the repo-local `g-kade` surface for the packet-backed workspace rooted at `C:\dev\Desktop-Projects\pi-speak-extension`.

## Repo Runtime Dependency

- contract: `repo-owned dependency/submodule/vendor path`
- configured path: `deps/pk-skills1/gstack/g-kade`
- status: `missing`
- note: `packet wrapper installed; richer repo-owned runtime still needs to be vendored or added as a submodule/dependency`

## Local Routing

- treat this repo root as the workspace root
- treat g-kade as the unifier surface only; install and preserve kade-hq plus gstack separately
- prefer packet helpers for search, memory, and MCP wiring
- use `kade/AGENTS.md` and `kade/KADE.md` as the project overlay
- if the richer repo-owned runtime is present, read it before routing work

Do not treat global skill installs as sufficient for this repo. Use the packet root files, `.llm-wiki/config.json`, the repo-owned dependency paths, and the repo-local `kade/` overlay as the first-class workspace contract.

## Fastest Successful Install

- run `python installers/install_g_kade_workspace.py --workspace <repo-root>` from the packet checkout when available
- if using the hosted installer fallback, set `LLM_WIKI_INSTALL_MODE=g-kade` before invoking `install.sh` or `install.ps1`
- vendor or submodule the richer runtime into the configured repo dependency path before claiming the full KADE/G-Stack runtime is available
- let setup and health run with GitVizz skipped until a real GitVizz repo path is configured

## Wiki Bootstrap (run on every project init)

When `g-kade` initializes or re-enters a repo, ensure the llm-wiki-memory vault is present and current:

1. **Scaffold check** — verify these directories exist; create if missing:
   ```
   wiki/
   ├── concepts/
   ├── entities/
   ├── skills/active/
   ├── skills/feedback/
   ├── skills/retired/
   ├── comparisons/
   ├── syntheses/
   ├── sources/
   ├── timelines/
   ├── questions/
   └── .obsidian/           (if Obsidian is the target viewer)
   ```
2. **Core files check** — verify these files exist; create stubs if missing:
   - `wiki/index.md` — taxonomy hub with links to all sections
   - `wiki/log.md` — chronological operational log
   - `wiki/skills/index.md` — skill inventory
   - `.llm-wiki/config.json` — retrieval stack config
   - `.llm-wiki/skills-registry.json` — canonical skill registry
3. **Canvas check** — if `wiki/Wiki Canvas.canvas` is missing or stale, regenerate it:
   - Scan all `wiki/**/*.md` (except `log.md`)
   - Create Obsidian canvas nodes for each file
   - Create edges for every internal markdown link
   - Write to `wiki/Wiki Canvas.canvas`
4. **Cross-skill coordination**:
   - Delegate canvas generation to `llm-wiki-skills` (canvas maintenance section)
   - Delegate skill inventory to `llm-wiki-organizer` (skill lifecycle section)
   - Preserve `kade-hq` Layer 2 overlays (`kade/AGENTS.md`, `kade/KADE.md`)

## Roadblocks And Corrections

- packet file copy alone is not enough; this workspace also needs repo-local skill surfaces, KADE overlays, repo-owned runtime dependencies, setup, and health verification
- home skill installs are optional overlays, not proof the repo is bootstrapped
- thin wrappers do not count as richer repo-owned runtimes
- missing `wiki/index.md` or `wiki/log.md` means the vault is not initialized; bootstrap before claiming the wiki is ready

## Wish I Knew Before Install

- `xyz`: the repo root is the real workspace target
- `xyz`: `/g-kade install` must keep going after packet file install
- `xyz`: the richer runtime belongs in a repo-owned dependency/submodule path, not just a home skill folder
- `xyz`: GitVizz should not block first-run QMD, BRV, and MCP bootstrap
- `xyz`: wiki scaffold (concepts, entities, skills, syntheses, sources, timelines, questions, comparisons) must exist before the vault is usable
