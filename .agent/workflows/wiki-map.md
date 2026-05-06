Read `AGENTS.md`, `LLM_WIKI_MEMORY.md` if present, `.llm-wiki/config.json`, `wiki/hot.md`, `wiki/index.md`, and recent `wiki/log.md`.

Use this workflow when the user wants a source-backed codebase wiki page, section, repo tour, map, or diagram.

Workflow:
1. Treat the user request as the target scope.
2. Search existing wiki pages first and update a matching page instead of duplicating it.
3. Gather repo evidence with `scripts/llm_wiki_packet.py context --task "<scope>"` and `scripts/llm_wiki_packet.py evidence --query "<scope>" --plane source --deep --json` when available. Fall back to targeted file search.
4. Write a compact page or section with scope, source evidence, codebase map, Mermaid diagram, key files, main flows, and `[VERIFY]` caveats.
5. Persist it with `python scripts/llm_wiki_generate.py --title "<title>" --scope "<scope>" --body-file <researched-body-file> --source "<file-or-note>"`, or use `--mode upsert-section --path "<wiki/path.md>" --section-title "<section>"` for an existing page.
6. Confirm `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`, and `wiki/overview.md` were updated by the script.

Return the created or updated path, the evidence used, the diagram type, and any unresolved verification items.
