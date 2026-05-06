# System Contract

> **Audience:** Maintainers and integrators reasoning about the packet's canonical layers and MCP wiring. For per-vault agent operating rules, see [`LLM_WIKI_MEMORY.md`](LLM_WIKI_MEMORY.md).

This repo packages the combined `Kade-HQ` + `G-Stack` + `pk-qmd` + `Byterover` + `GitVizz` system.

## Canonical Layers

- Harness layer: `Kade-HQ` and `G-Stack`
- Repo-owned richer runtime: `deps/pk-skills1`
- Packet-owned launcher wrappers: `skills/home/kade-hq`, `skills/home/g-kade`, `skills/home/gstack`, `skills/home/llm-wiki-skills`
- Retrieval and embeddings plane: `pk-qmd`
- Durable memory plane: `Byterover` (`brv`)
- Graph and web plane: `GitVizz`
- Vault scribing plane: `obsidian` MCP (pivotal but optional)
- Obsidian behavior layer: `agent-cli-obsidian` conventions for save, query, autoresearch, and wiki note taxonomy

## MCP Servers And Codex Startup

The repo-local `.mcp.json` intentionally keeps Codex startup lean: it loads only the lightweight `llm-wiki-skills` stdio server by default. Slower or optional providers stay available through explicit packet commands, setup helpers, or non-Codex MCP wiring so they do not block Codex launch.

| Server | Command | Purpose | Required? |
|--------|---------|---------|----------|
| `llm-wiki-skills` | `python llm_wiki_skill_mcp.py mcp` | Skill lifecycle (lookup, reflect, validate, evolve, retire) | **Always** |
| `pk-qmd` | `scripts/llm_wiki_packet.py context/evidence` or Claude/Factory MCP wiring | Source evidence retrieval, docs, prompts, notes | **Always, outside Codex startup** |
| `obsidian` | `scripts/llm_wiki_provider.py`, `scripts/llm_wiki_save.py`, or Claude/Factory MCP wiring | Vault read/write - wiki scribing surface | **Pivotal but optional, outside Codex startup** |
| `brv` | `scripts/brv_query.*`, `scripts/brv_curate.*`, or `brv` CLI | Durable memory, preferences, workflow quirks | Optional, outside Codex startup |

### Obsidian: pivotal but optional

The `obsidian` MCP server provides `read_note`, `write_note`, `search_notes`, `manage_tags`, and `move_note` tools against the configured Obsidian vault. It is the preferred path for all wiki mutations.

Vault resolution rule: use an explicitly configured vault path from `.llm-wiki/config.json`, MCP settings, or a user-provided setting. If no vault path is established, ask the user where to create or access the Obsidian vault before reading, writing, creating, or assuming any vault. Do not silently use the current repo as an Obsidian vault.

Agents should offer Obsidian persistence whenever an answer produces reusable knowledge that would be expensive to rediscover, including research-paper summaries, source-backed findings, solved debugging trails, durable decisions, procedures, and prior-art comparisons. Accepted saves should become compact source-backed notes with citations/source links, key claims, caveats, open questions, and useful tags.

Clean layering: `llm_wiki_prompt_packet` owns installer, MCP wiring, and cross-agent retrieval; `agent-cli-obsidian` owns Obsidian wiki behavior and skills; `mcpvault` or `mcp-obsidian` owns vault read/write transport. The Obsidian note taxonomy is `synthesis`, `concept`, `source`, `decision`, and `session`; research flows also use source/entity/concept/question pages plus a synthesis page. For deep research, saving is the default outcome unless the user opts out.

When `obsidian` is unavailable:
1. Fall back to direct file I/O only against the configured vault path.
2. Log the fallback in `wiki/log.md`.
3. For renames and moves, prefer pausing and asking the user to open Obsidian (link-integrity risk).
4. The system remains fully functional - `pk-qmd` and `llm-wiki-skills` provide evidence and skill management independently.

### BRV: skip gracefully

When `brv` has no connected provider, skip `brv query`/`brv curate` and continue with source evidence from `pk-qmd`.

## Local Gateway (Docker / HTTP)

- Default local gateway: `127.0.0.1:8181`
- Routes:
  - `/mcp` -> `pk-qmd`
  - `/graph/*` -> GitVizz backend
  - `/memory/status`, `/memory/query`, `/memory/curate` -> narrow BRV adapter
- Auth rule:
  - loopback-only binds may run without auth
  - non-loopback binds must set `LLM_WIKI_AGENT_API_TOKEN`, unless an explicit unsafe override is set

## Setup Contract

- `scripts/setup_llm_wiki_memory.*` and `scripts/check_llm_wiki_memory.*` are thin wrappers
- Shared logic lives in `scripts/llm_wiki_memory_runtime.py`
- Managed installs prefer workspace or home `tooling.managed_tool_root` over global npm installs
- `pk-qmd` is pinned to commit `ef26cb62bb8132bc3a851b23f450af8e382e4c4e`

## Harness Control Plane Contract

- `llm-wiki-packet context` builds compact default task context from instructions, skills, wiki memory, recent lessons, preferences, and graph hints.
- `llm-wiki-packet evidence` performs explicit broad retrieval across source, skills, preference, graph, and local fallback planes without automatically bloating default context.
- `llm-wiki-packet manifest`, `reduce`, `evaluate`, `promote`, and `improve` create a versioned run lifecycle for auditable memory promotion and gated self-improvement.
- Broad retrieval results carry provenance and confidence; current source evidence has priority over stale memory.
- Optional Hugging Face embedding and reranking model settings are config-only planner hints unless `hf_enabled` is explicitly turned on by an integrator.
- `context` and `evidence` accept `--run-id` to append retrieval-plane status metadata to the matching run manifest.
- GitVizz graph retrieval uses configured `repo_id` plus optional `authorization_env` or `auth_token_env`; missing auth degrades to graph/config hints.

## Durable Memory Contract

- Official Obsidian vault name: `kade-hq`
- Official vault id: `fd8411f00d3a9d21`
- Official vault path: configure explicitly with `LLM_WIKI_MEMORY_VAULT_PATH` or `.llm-wiki/config.json`.
- Local vault root hint: configure explicitly with `LLM_WIKI_OBSIDIAN_VAULT_ROOT` when useful.
- Repo mirrors:
  - `AGENTS.md`
  - `.factory/memories.md`
  - `kade/AGENTS.md`
  - `kade/KADE.md`

### Memory layer mapping

- Working memory: active prompt context + guide files
- Episodic memory: `.llm-wiki/skill-pipeline/briefs/` and `.llm-wiki/skill-pipeline/packets/`
- Semantic memory: `wiki/` knowledge pages
- Procedural memory: `wiki/skills/active/`
- Preference memory: `brv`

Active skills should be maintained as typed memory objects with memory scope, memory strategy, update strategy, durable facts, and provenance refs.

## Source Of Truth

- Runtime config: `.llm-wiki/config.json`
- MCP wiring: `.mcp.json`
- Canonical contract doc: `SYSTEM_CONTRACT.md`
- Operational backlog: `KNOWN_ISSUES.md`
