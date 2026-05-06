---
description: ingest a single source into the persistent wiki
---
Read `CLAUDE.md`, then read `LLM_WIKI_MEMORY.md` if present, `.llm-wiki/config.json`, `wiki/index.md`, and recent `wiki/log.md`.

Ingest the specified source into the wiki:
- create or update a source summary
- update affected entity, concept, synthesis, comparison, or timeline pages
- update `wiki/index.md`
- append an `ingest` entry to `wiki/log.md`

Routing:
- use `pk-qmd` for repo-specific evidence retrieval if needed
- use `brv` only for stable workflow or preference context
- trust current source evidence over memory

Return:
- stack/config used
- files read
- files changed
- what changed
- unresolved questions
