#!/usr/bin/env python3
"""Generate or update codebase wiki pages with maps and diagram scaffolds."""
from __future__ import annotations

import argparse
import os
import re
from argparse import Namespace
from pathlib import Path
from typing import Any

from llm_wiki_provider import provider_from_workspace
from llm_wiki_save import (
    configured_folders,
    ensure_index,
    find_existing,
    now_iso,
    prepend_log,
    save_note,
    today,
    update_hot,
    update_overview,
)


def clean_label(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[\[\]{}<>|`]", " ", value).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:80] or fallback


def mermaid_node(node_id: str, label: str) -> str:
    return f"    {node_id}[{clean_label(label, node_id)}]"


def source_lines(sources: list[str]) -> list[str]:
    if not sources:
        return ["- [VERIFY] Add the source files, docs, wiki pages, or command outputs used for this map."]
    return [f"- {source}" for source in sources]


def codebase_map(scope: str, sources: list[str]) -> str:
    scope_label = scope or "Requested scope"
    source_label = sources[0] if sources else "Source evidence"
    return "\n".join(
        [
            "```mermaid",
            "flowchart TD",
            mermaid_node("Workspace", "Workspace"),
            mermaid_node("Scope", scope_label),
            mermaid_node("Evidence", source_label),
            mermaid_node("Entry", "Entry points"),
            mermaid_node("Core", "Core modules"),
            mermaid_node("Data", "Data and state"),
            "    Workspace --> Scope",
            "    Scope --> Evidence",
            "    Evidence --> Entry",
            "    Entry --> Core",
            "    Core --> Data",
            "```",
        ]
    )


def architecture_diagram(scope: str, kind: str) -> str:
    if kind == "sequence":
        return "\n".join(
            [
                "```mermaid",
                "sequenceDiagram",
                "    participant User",
                "    participant EntryPoint",
                "    participant CoreLogic",
                "    participant Wiki",
                "    User->>EntryPoint: request scoped documentation",
                "    EntryPoint->>CoreLogic: inspect source-backed behavior",
                "    CoreLogic->>Wiki: persist durable map and caveats",
                "```",
            ]
        )
    if kind == "dependency":
        return "\n".join(
            [
                "```mermaid",
                "graph LR",
                mermaid_node("Feature", scope or "Feature"),
                mermaid_node("Entry", "Entry points"),
                mermaid_node("Internals", "Internal modules"),
                mermaid_node("External", "External dependencies"),
                "    Feature --> Entry",
                "    Entry --> Internals",
                "    Internals --> External",
                "```",
            ]
        )
    return "\n".join(
        [
            "```mermaid",
            "flowchart LR",
            mermaid_node("Actor", "User or agent"),
            mermaid_node("Interface", "Commands and APIs"),
            mermaid_node("Service", scope or "Codebase area"),
            mermaid_node("State", "State, files, or storage"),
            mermaid_node("Wiki", "Durable wiki page"),
            "    Actor --> Interface",
            "    Interface --> Service",
            "    Service --> State",
            "    Service --> Wiki",
            "```",
        ]
    )


def body_from_args(args: argparse.Namespace) -> str:
    if args.body_file:
        return Path(args.body_file).read_text(encoding="utf-8")
    return args.body or ""


def compose_page(args: argparse.Namespace) -> str:
    notes = body_from_args(args).strip()
    sections: list[str] = [
        f"# {args.title}",
        "",
        "## Scope",
        args.scope or "[VERIFY] State the repo area, feature, subsystem, or workflow covered by this page.",
        "",
        "## Source Evidence",
        *source_lines(args.source or []),
    ]
    if not args.no_map:
        sections.extend(["", "## Codebase Map", codebase_map(args.scope, args.source or [])])
    if not args.no_diagram:
        sections.extend(["", "## Architecture Diagram", architecture_diagram(args.scope, args.diagram_kind)])
    sections.extend(
        [
            "",
            "## Main Flows",
            notes or "- [VERIFY] Add source-backed behavior, important branches, and handoff points.",
            "",
            "## Key Files",
            "- [VERIFY] List the files or folders that future agents should inspect first.",
            "",
            "## Open Questions",
            "- [VERIFY] Record unknowns, stale assumptions, or places where source evidence was incomplete.",
        ]
    )
    return "\n".join(sections).rstrip() + "\n"


def section_heading(title: str) -> str:
    return title.strip().lstrip("#").strip() or "Codebase Map"


def compose_section(args: argparse.Namespace) -> str:
    heading = section_heading(args.section_title)
    content = body_from_args(args).strip()
    lines = [f"## {heading}", "", f"_Updated: {now_iso()}_", ""]
    if args.scope:
        lines.extend(["### Scope", args.scope, ""])
    if args.source:
        lines.extend(["### Source Evidence", *source_lines(args.source), ""])
    if not args.no_map:
        lines.extend(["### Codebase Map", codebase_map(args.scope, args.source or []), ""])
    if not args.no_diagram:
        lines.extend(["### Diagram", architecture_diagram(args.scope, args.diagram_kind), ""])
    lines.extend(["### Notes", content or "- [VERIFY] Add source-backed details for this section."])
    return "\n".join(lines).rstrip() + "\n"


def upsert_section(existing_text: str, heading: str, section_text: str) -> str:
    escaped = re.escape(heading)
    pattern = re.compile(rf"(?ms)^##\s+{escaped}\s*\n.*?(?=^##\s+|\Z)")
    if pattern.search(existing_text):
        updated = pattern.sub(section_text.rstrip() + "\n\n", existing_text, count=1)
    else:
        updated = existing_text.rstrip() + "\n\n" + section_text.rstrip() + "\n"
    return re.sub(r"(?m)^updated:\s*.+$", f"updated: {today()}", updated, count=1)


def append_section(existing_text: str, section_text: str) -> str:
    updated = existing_text.rstrip() + "\n\n" + section_text.rstrip() + "\n"
    return re.sub(r"(?m)^updated:\s*.+$", f"updated: {today()}", updated, count=1)


def save_page(args: argparse.Namespace) -> dict[str, Any]:
    return save_note(
        Namespace(
            workspace=args.workspace,
            title=args.title,
            type=args.type,
            body=compose_page(args),
            body_file="",
            source=args.source or [],
            related=args.related or [],
            tag=args.tag or ["codebase-map", "wiki-map"],
            question="",
            answer_quality="solid",
            confidence="medium",
            url="",
            supersedes=[],
            contradicts=[],
            observed_at="",
            valid_from="",
            valid_until="",
            promote_to="",
            mode="create-or-update",
        )
    )


def update_page_section(args: argparse.Namespace) -> dict[str, Any]:
    provider = provider_from_workspace(args.workspace)
    folders = configured_folders(args.workspace)
    sources = args.source or []
    target_path = args.path or find_existing(provider, folders, args.type, args.title, sources, "")
    if not target_path:
        return save_page(args)

    existing = provider.read(target_path)
    section = compose_section(args)
    if args.mode == "append-section":
        content = append_section(existing, section)
    else:
        content = upsert_section(existing, section_heading(args.section_title), section)
    result = provider.write(target_path, content)
    ensure_index(provider, args.type, args.title, result.path)
    prepend_log(provider, args.type, args.title, result.path, result.action, sources)
    update_hot(provider, args.title, result.path, result.action)
    update_overview(provider, args.title, result.path, args.type, result.action)
    return {
        "path": result.path,
        "action": result.action,
        "transport": result.transport,
        "likely_conflicts": [],
        "promoted_path": "",
    }


def generate_wiki(args: argparse.Namespace) -> dict[str, Any]:
    if args.mode == "page":
        return save_page(args)
    return update_page_section(args)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate or update a codebase wiki page with maps and diagrams.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--title", required=True)
    parser.add_argument("--scope", default="")
    parser.add_argument("--type", default="synthesis", choices=["synthesis", "concept", "decision", "session"])
    parser.add_argument("--mode", choices=["page", "append-section", "upsert-section"], default="page")
    parser.add_argument("--path", default="", help="Existing wiki-relative page path for section updates.")
    parser.add_argument("--section-title", default="Codebase Map")
    parser.add_argument("--body", default="")
    parser.add_argument("--body-file", default="")
    parser.add_argument("--source", action="append")
    parser.add_argument("--related", action="append")
    parser.add_argument("--tag", action="append")
    parser.add_argument("--diagram-kind", choices=["architecture", "sequence", "dependency"], default="architecture")
    parser.add_argument("--no-map", action="store_true")
    parser.add_argument("--no-diagram", action="store_true")
    args = parser.parse_args()

    result = generate_wiki(args)
    print(f"{result['action']}: {result['path']} ({result['transport']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
