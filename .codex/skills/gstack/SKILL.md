---
name: gstack
description: Repo-local gstack workflow surface layered on top of the llm-wiki-memory packet.
---

# gstack

This is the repo-local `gstack` surface for the packet-backed workspace rooted at `C:\dev\Desktop-Projects\pi-speak-extension`.

## Repo Runtime Dependency

- contract: `repo-owned dependency/submodule/vendor path`
- configured path: `deps/pk-skills1/gstack`
- status: `missing`
- note: `packet wrapper installed; richer repo-owned runtime still needs to be vendored or added as a submodule/dependency`

## Local Routing

- QA
- browser dogfooding
- code review
- debugging and investigation
- ship and PR prep
- design and DX review
- deployment verification
- verify external binaries before invoking them and fall back to native tools when absent

Do not treat global skill installs as sufficient for this repo. Use the packet root files, `.llm-wiki/config.json`, the repo-owned dependency paths, and the repo-local `kade/` overlay as the first-class workspace contract.
