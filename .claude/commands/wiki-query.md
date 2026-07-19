---
description: answer from the wiki and file durable results
---
Read `CLAUDE.md`, then read `LLM_WIKI_MEMORY.md` if present, `.llm-wiki/config.json`, `wiki/hot.md`, `wiki/index.md`, and the most relevant wiki pages first.

Answer the user's question from the wiki. Read raw sources only when needed.
If the result is durable, offer to file it back into the canonical wiki layer. For deep research, save by default unless the user opts out. When saving: if `.llm-wiki/config.json` resolves a packet vault, use `python "<vault>/scripts/llm_wiki_save.py"`; otherwise write to the default vault `C:\dev\Desktop-Projects\Helpful-Docs-Prompts\VAULTS-OBSIDIAN\designandbuilding-vault/Projects/<PROJECT>/<topic>.md`. Then update `wiki/index.md`, prepend `wiki/log.md`, refresh `wiki/hot.md` where they exist.

Routing:
- use `pk-qmd` for repo-specific evidence and prompt lookup
- use `pk-qmd` first when the target repo area is not known yet
- use `GitVizz` when repo structure, API context, or dependency relationships are the real need
- use `brv` for durable preferences, prior decisions, or repeated workflow quirks
- if `pk-qmd` and `brv` conflict, answer from current source evidence

Return:
- stack/config used
- files read
- files changed
- save offered or applied
- unresolved conflicts
- next best actions
