---
description: save a durable answer, source finding, or research synthesis into the canonical Obsidian wiki
---
Read `CLAUDE.md`, `LLM_WIKI_MEMORY.md` if present, and `.llm-wiki/config.json`.

Use the configured `wiki_layer` as the canonical wiki provider. For Obsidian-backed installs, treat `agent-cli-obsidian` as the behavior convention and `mcpvault` / `mcp-obsidian` / direct file fallback as the transport.

Before saving, confirm the vault path is established by `.llm-wiki/config.json`, MCP settings, environment variables, or current user instruction. If no vault path is established, ask the user where to create or access the Obsidian vault. Do not silently use the current repo as an Obsidian vault.

Save workflow:
1. Identify the durable content to preserve.
2. Classify the note type: `synthesis`, `concept`, `source`, `decision`, `session`, `entity`, or `question`.
3. Prefer updating an existing page over creating a duplicate.
4. Preserve citations/source links, caveats, open questions, related pages, and useful tags.
5. If `.llm-wiki/config.json` resolves a packet vault, save via `python "<vault>/scripts/llm_wiki_save.py" --title "..." --type synthesis --body-file <file>` (or the equivalent provider workflow). For the default vault (designandbuilding-vault, no packet tree) write the note directly to `Projects/<PROJECT>/<topic>.md`. Either way update `wiki/index.md`, prepend `wiki/log.md`, refresh `wiki/hot.md` where they exist.
6. Update `wiki/index.md`, prepend `wiki/log.md`, and refresh `wiki/hot.md`.

For deep research, save by default unless the user opted out. For ordinary quick answers, offer to save only when the result has durable value.

Return:
- created or updated wiki pages
- note type
- transport/fallback used
- index/log/hot updates
- unresolved caveats or [VERIFY] items
