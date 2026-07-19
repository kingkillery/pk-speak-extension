---
type: concept
title: "Agent Harness Design"
created: 2026-07-13
updated: 2026-07-13
tags: [agent-harness, frontier-models, multi-agent, research-reading-list]
status: developing
related:
  - "[[herdr-agent-hub- Module]]"
  - "[[syntheses/oh-my-pk-fork-2026-07|oh-my-pk Fork Architecture Snapshot 2026-07]]"
sources:
  - arxiv "Scaling the Harness in Agentic AI" (2605.26112)
  - arxiv "Toward Executable, Verifiable, and Stateful Agent Systems" (2605.18747v1)
  - arxiv "Interpreting Agentic Systems: Beyond Model Explanations" (2601.17168v1)
  - cdn.openai "The Shift to Agentic AI: Evidence from Codex"
  - emergentmind Terminal-Bench / RE-Bench / Hierarchy of Agentic Capabilities / Forecasting Frontier Agent Capabilities
  - philschmid "The importance of Agent Harness in 2026"
  - devblogs.microsoft "Microsoft Agent Framework at BUILD 2026"
  - platform.claude "Context engineering: memory, compaction, and tool clearing"
  - bdtechtalks "ai-harness-scaling" (2026-06-01)
---

# Agent Harness Design (reading list)

Curated reading list for the **harness** side of agentic systems — i.e., everything *around* the model that turns a frontier LLM into a long-lived, auditable, verifiable agent: persistent execution, context governance, memory, skill routing, role coordination, supervision, and runtime orchestration. The model is one component; the harness is the system that makes multi-day, multi-step work reliable.

This page is a concept/reference note rather than a project observation. It complements the in-repo observations captured at [[herdr-agent-hub- Module]] (our own `/v1/herdr/agent*` hub wiring) and [[syntheses/oh-my-pk-fork-2026-07|oh-my-pk Fork Architecture Snapshot 2026-07]] (fork-side runtime contracts).

## Reading list

### Most relevant papers

- **Scaling the Harness in Agentic AI** — argues the next bottleneck is system scaling, not just model scaling, and centers auditable persistent execution, context governance, trustworthy memory, and dynamic skill routing. [arxiv](https://arxiv.org/pdf/2605.26112.pdf)
- **Toward Executable, Verifiable, and Stateful Agent Systems** — looks at how harnesses for multi-agent code tasks need shared state, role coordination, and execution verifiability. [arxiv](https://arxiv.org/html/2605.18747v1)
- **Interpreting Agentic Systems: Beyond Model Explanations** — frames the state of the art as a convergence of architectural components that operationalize agent behavior, which is useful for understanding harness design. [arxiv](https://arxiv.org/html/2601.17168v1)
- **The Shift to Agentic AI: Evidence from Codex** — uses large-scale usage evidence to show that agentic systems shift work from chat toward delegation, making supervision, verification, and coordination central. [cdn.openai](https://cdn.openai.com/pdf/5d1e1489-21c0-43e4-9d42-f87efdbf0082/the-shift-to-agentic-ai-evidence-from-codex.pdf)

### Benchmark and capability papers

- **Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Command Line Interfaces** — relevant because command-line realism is where harness design becomes crucial for long-horizon task completion. [emergentmind](https://www.emergentmind.com/topics/frontier-models-and-agents)
- **RE-Bench: Evaluating frontier AI R&D capabilities of language model agents against human experts** — useful for studying agentic performance on expert workflows rather than toy tasks. [emergentmind](https://www.emergentmind.com/topics/frontier-models-and-agents)
- **The Hierarchy of Agentic Capabilities: Evaluating Frontier Models on Realistic RL Environments** — good for understanding where frontier models succeed or fail in realistic environments. [emergentmind](https://www.emergentmind.com/topics/frontier-models-and-agents)
- **Forecasting Frontier Language Model Agent Capabilities** — helpful if you want a broader systems view of how far frontier agents can go with strong scaffolding. [emergentmind](https://www.emergentmind.com/topics/frontier-models-and-agents)

### Practical harness engineering

- **The importance of Agent Harness in 2026** — a practitioner-oriented piece that explains why harnesses are now essential for reliable multi-day tasks. [philschmid](https://www.philschmid.de/agent-harness-2026)
- **Microsoft Agent Framework at BUILD 2026** — not a paper, but a useful technical reference on approvals, execution, and runtime orchestration. [devblogs.microsoft](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-at-build-2026-announce/)
- **Context engineering: memory, compaction, and tool clearing** — useful if your real interest is how to make a long-lived harness actually work with frontier models. [platform.claude](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)

## Suggested reading order

If the goal is to understand the research frontier, start with:
1. **Scaling the Harness in Agentic AI** — framing.
2. **Toward Executable, Verifiable, and Stateful Agent Systems** — concrete multi-agent requirements.
3. One benchmark paper — **Terminal-Bench** (CLI realism) or **RE-Bench** (expert workflows).

For practitioner work, follow the **Microsoft Agent Framework** announce for runtime orchestration references, then **Context engineering: memory, compaction, and tool clearing** for context-governance mechanics, then **philschmid**'s piece as a compact summary.

## Notes

- The links listed under `sources` in the frontmatter are reference URLs only — none are stored locally in `wiki/sources/` yet. Promote a paper into a dedicated concept note when it materially shapes an in-repo decision.
- The bdtechtalks piece (2026-06-01) is included in `sources` as the recommended synthesis article for harness-scaling framing. If a tighter reading list is wanted, organized by **harness design**, **evaluation**, and **safety/verification**, that's a follow-up to extract into this page or a sibling concept note.