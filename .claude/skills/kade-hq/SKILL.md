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

## Initialization (Layer 0 - Wiki Vault Bootstrap)

Before loading Layer 1 or Layer 2, verify the repo has a functional llm-wiki-memory vault. If any piece is missing, bootstrap it:

1. **Directory scaffold** — create missing `wiki/` subdirectories:
   ```
   wiki/concepts/
   wiki/entities/
   wiki/skills/active/
   wiki/skills/feedback/
   wiki/skills/retired/
   wiki/comparisons/
   wiki/syntheses/
   wiki/sources/
   wiki/timelines/
   wiki/questions/
   ```
2. **Core pages** — create stubs if missing:
   - `wiki/index.md` — taxonomy with Quick Links, Concepts, Entities, Skills, Syntheses, Sources, Timelines, Questions, Comparisons
   - `wiki/log.md` — `# Wiki Log\n\n` header only
   - `wiki/skills/index.md` — `# Skill Index\n\n`
3. **Canvas** — if `wiki/Wiki Canvas.canvas` is missing, generate it by delegating to `llm-wiki-skills` canvas maintenance instructions.
4. **Config** — ensure `.llm-wiki/config.json` exists with basic retrieval stack config.
5. **Skills registry** — ensure `.llm-wiki/skills-registry.json` exists.

## Local Routing

- load Layer 1 from ~/.kade/HUMAN.md when present
- load Layer 2 from kade/AGENTS.md and kade/KADE.md
- preserve the packet root files as the workspace contract
- use g-kade only as the bridge and router across kade-hq plus gstack
- use gstack for execution workflows such as review, QA, debugging, and ship
- delegate wiki scaffold and canvas generation to `llm-wiki-skills`

Do not treat global skill installs as sufficient for this repo. Use the packet root files, `.llm-wiki/config.json`, the repo-owned dependency paths, and the repo-local `kade/` overlay as the first-class workspace contract.
