---
name: kade-hq
description: Repo-local KADE System surface layered on top of the llm-wiki-memory packet.
---

# kade-hq

This is the repo-local `kade-hq` surface for the packet-backed workspace rooted at `C:\dev\Desktop-Projects\pi-speak-extension`.

## Repo Runtime Dependency

- contract: `KADE System launcher surface for this repo workspace`
- configured path: `kade/ + ~/.kade + packet root files`
- status: `managed by the workspace installer`
- note: `g-kade is only the unifier skill; install and preserve kade-hq separately from gstack`

## Local Routing

- load Layer 1 from ~/.kade/HUMAN.md when present
- load Layer 2 from kade/AGENTS.md and kade/KADE.md
- preserve the packet root files as the workspace contract
- use g-kade only as the bridge and router across kade-hq plus gstack
- use gstack for execution workflows such as review, QA, debugging, and ship

Do not treat global skill installs as sufficient for this repo. Use the packet root files, `.llm-wiki/config.json`, the repo-owned dependency paths, and the repo-local `kade/` overlay as the first-class workspace contract.
