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

## Roadblocks And Corrections

- packet file copy alone is not enough; this workspace also needs repo-local skill surfaces, KADE overlays, repo-owned runtime dependencies, setup, and health verification
- home skill installs are optional overlays, not proof the repo is bootstrapped
- thin wrappers do not count as richer repo-owned runtimes

## Wish I Knew Before Install

- `xyz`: the repo root is the real workspace target
- `xyz`: `/g-kade install` must keep going after packet file install
- `xyz`: the richer runtime belongs in a repo-owned dependency/submodule path, not just a home skill folder
- `xyz`: GitVizz should not block first-run QMD, BRV, and MCP bootstrap
