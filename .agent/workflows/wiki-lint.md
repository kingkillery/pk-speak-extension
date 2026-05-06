Read `CLAUDE.md`, `LLM_WIKI_MEMORY.md` if present, `.llm-wiki/config.json`, `wiki/index.md`, and recent `wiki/log.md`.

Lint the wiki for:
- contradictions
- stale claims
- orphan or weakly linked pages
- duplicate pages
- broken links
- missing entity or concept pages
- obvious research gaps
- stack-routing rules that are missing or unclear

Fix safe issues directly.
Flag judgment-heavy recommendations separately.
Update `wiki/index.md` if needed and append a `lint` entry to `wiki/log.md`.

Return:
- stack/config used
- files changed
- issues fixed
- issues deferred
- next best actions
