---
description: explain how to use the installed llm-wiki packet in plain language
argument-hint: "[question]"
---
Read `CLAUDE.md`, `AGENTS.md`, `LLM_WIKI_MEMORY.md` if present, `.llm-wiki/config.json`, and `wiki/index.md` if present.

Use this command when the user asks for help with the packet, the wiki, memory, skills, install/setup, commands, Obsidian, MCP, repo maps, or "what can this tool do?".

Answer in plain language. Do not make the user remember command internals unless they ask for CLI details.

If `$ARGUMENTS` is empty, give a short help menu:
- what this packet does
- how to ask normal natural-language questions
- the main slash commands: `/wiki-help`, `/wiki-query`, `/wiki-save`, `/wiki-map`, `/wiki-skill`, `/wiki-ingest`, `/wiki-lint`
- the one-command install for the user's shell when relevant
- the health check command for the current shell

If `$ARGUMENTS` contains a question, answer that question directly and include only the commands the user actually needs.

Prefer examples like:
- "Explain auth and save the durable summary."
- "Generate a wiki map for the billing flow."
- "What do we already know about deployment?"
- "Create a reusable skill for this repeated workflow."

Return:
- shortest useful answer
- exact next command only when needed
- where the result will be saved or read from
