---
description: generate or update a source-backed codebase wiki page with maps and diagrams
argument-hint: "[scope or topic] [--append <wiki page>]"
---
Read `CLAUDE.md`, `LLM_WIKI_MEMORY.md` if present, `.llm-wiki/config.json`, `wiki/hot.md`, `wiki/index.md`, and recent `wiki/log.md`.

Use this command when the user wants a wiki page, section, repo tour, architecture map, flow map, or diagram for a codebase area.

Workflow:
1. Interpret `$ARGUMENTS` as the target scope, feature, subsystem, workflow, or existing wiki page to update.
2. Search the existing wiki first. Prefer updating a relevant page over creating a duplicate.
3. Gather source evidence before writing. Use `scripts/llm_wiki_packet.py context --task "$ARGUMENTS"` and `scripts/llm_wiki_packet.py evidence --query "$ARGUMENTS" --plane source --deep --json` when available; use targeted local search as fallback.
4. Build a concise source-backed page or section with:
   - scope
   - source evidence
   - codebase map
   - Mermaid architecture or flow diagram
   - key files and entry points
   - main flows
   - open questions and `[VERIFY]` caveats
5. Save through `python scripts/llm_wiki_generate.py --title "<title>" --scope "$ARGUMENTS" --body-file <researched-body-file> --source "<file-or-note>"`. For an existing page section, use `--mode upsert-section --path "<wiki/path.md>" --section-title "<section>"`.
6. Let the script update `wiki/index.md`, prepend `wiki/log.md`, and refresh `wiki/hot.md` / `wiki/overview.md`.

Do not ask the user to remember the underlying save command unless they explicitly want CLI details. The slash command is the user-facing interface.

Return:
- created or updated page
- map/diagram type added
- source files or notes used
- unresolved `[VERIFY]` items
