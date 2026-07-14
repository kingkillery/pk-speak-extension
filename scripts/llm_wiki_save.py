#!/usr/bin/env python3
"""Save durable answers and research findings into the canonical wiki layer."""
from __future__ import annotations

import argparse
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from llm_wiki_provider import DirectFileWikiProvider, load_config, provider_from_workspace


DEFAULT_FOLDERS = {
    "source": "wiki/sources",
    "concept": "wiki/concepts",
    "entity": "wiki/entities",
    "question": "wiki/questions",
    "query": "wiki/queries",
    "synthesis": "wiki/syntheses",
    "decision": "wiki/decisions",
    "session": "wiki/sessions",
}


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def slug_title(title: str) -> str:
    # Drop filesystem-unsafe characters entirely (replacing with a space
    # mangled titles like "foo-* Bar" into "foo- Bar"), then normalize.
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", title)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # A removed character can leave a dangling hyphen against a space
    # ("foo- Bar"); collapse spaces around hyphens and hyphen runs.
    cleaned = re.sub(r"\s*-\s*", "-", cleaned)
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-. ")
    return cleaned or "Untitled"


def yaml_list(items: list[str]) -> str:
    if not items:
        return "[]"
    return "\n" + "".join(f"  - {item}\n" for item in items)


def yaml_scalar(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def frontmatter(note_type: str, title: str, tags: list[str], sources: list[str], related: list[str], args: argparse.Namespace) -> str:
    lines = [
        "---",
        f"type: {note_type}",
        f'title: "{title}"',
        f"created: {today()}",
        f"updated: {today()}",
        f"tags: {yaml_list(tags).rstrip()}",
        "status: developing",
        f"related: {yaml_list(related).rstrip()}",
        f"sources: {yaml_list(sources).rstrip()}",
    ]
    if args.supersedes:
        lines.append(f"supersedes: {yaml_list(args.supersedes).rstrip()}")
    if args.contradicts:
        lines.append(f"contradicts: {yaml_list(args.contradicts).rstrip()}")
    if args.observed_at:
        lines.append(f"observed_at: {yaml_scalar(args.observed_at)}")
    if args.valid_from:
        lines.append(f"valid_from: {yaml_scalar(args.valid_from)}")
    if args.valid_until:
        lines.append(f"valid_until: {yaml_scalar(args.valid_until)}")
    if note_type in {"question", "query"} and args.question:
        lines.append(f"question: {yaml_scalar(args.question)}")
        lines.append(f"answer_quality: {args.answer_quality}")
    if note_type == "source":
        if args.url:
            lines.append(f"url: {args.url}")
        lines.append(f"confidence: {args.confidence}")
    if note_type == "decision":
        lines.append(f"decision_date: {today()}")
        lines.append("decision_status: active")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def parse_frontmatter_title(text: str) -> str:
    match = re.search(r'(?m)^title:\s*"?(.+?)"?\s*$', text)
    return match.group(1).strip() if match else ""


def content_terms(text: str) -> set[str]:
    stop = {
        "about",
        "after",
        "also",
        "because",
        "before",
        "being",
        "from",
        "have",
        "into",
        "that",
        "the",
        "their",
        "there",
        "this",
        "with",
        "would",
    }
    return {term.lower() for term in re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", text) if term.lower() not in stop}


def has_negation_or_staleness(text: str) -> bool:
    return bool(re.search(r"\b(no longer|not|never|deprecated|obsolete|superseded|replaced|contradicts?)\b", text, re.I))


def configured_folders(workspace: str | Path) -> dict[str, str]:
    config = load_config(Path(workspace).expanduser().resolve(strict=False))
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    folders = wiki_layer.get("folders") if isinstance(wiki_layer.get("folders"), dict) else {}
    return {**DEFAULT_FOLDERS, **{str(key): str(value) for key, value in folders.items()}}


def configured_wiki_layer(workspace: str | Path) -> dict[str, Any]:
    config = load_config(Path(workspace).expanduser().resolve(strict=False))
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    return wiki_layer


def note_folder(note_type: str, folders: dict[str, str]) -> str:
    key = {
        "source": "sources",
        "concept": "concepts",
        "entity": "entities",
        "question": "questions",
        "query": "queries",
        "synthesis": "syntheses",
        "decision": "decisions",
        "session": "sessions",
    }.get(note_type, "syntheses")
    return folders.get(key) or DEFAULT_FOLDERS.get(note_type, "wiki/syntheses")


def find_existing(provider: DirectFileWikiProvider, folders: dict[str, str], note_type: str, title: str, sources: list[str], question: str) -> str | None:
    folder = note_folder(note_type, folders)
    desired_stem = slug_title(title).lower()
    root = provider.resolve_path(folder)
    if not root.exists():
        return None
    for note in root.glob("*.md"):
        text = note.read_text(encoding="utf-8")
        if note.stem.lower() == desired_stem or parse_frontmatter_title(text).lower() == title.lower():
            return note.relative_to(provider.vault_path).as_posix()
        if question and re.search(rf'(?m)^question:\s*"?{re.escape(question)}"?\s*$', text):
            return note.relative_to(provider.vault_path).as_posix()
        if sources and any(source in text for source in sources):
            source_title = parse_frontmatter_title(text).lower()
            if source_title == title.lower():
                return note.relative_to(provider.vault_path).as_posix()
    return None


def detect_likely_conflicts(provider: DirectFileWikiProvider, body: str, title: str, exclude_path: str | None = None) -> list[str]:
    new_terms = content_terms(f"{title}\n{body}")
    if len(new_terms) < 3:
        return []
    new_negated = has_negation_or_staleness(body)
    conflicts: list[str] = []
    wiki_root = provider.resolve_path("wiki")
    if not wiki_root.exists():
        return []
    for note in sorted(wiki_root.rglob("*.md")):
        rel = note.relative_to(provider.vault_path).as_posix()
        if rel == exclude_path or ".git" in note.parts:
            continue
        if Path(rel).name.lower() in {"index.md", "log.md", "hot.md", "overview.md"}:
            continue
        if len(Path(rel).parts) < 3:
            continue
        text = note.read_text(encoding="utf-8")
        overlap = len(new_terms & content_terms(text))
        if overlap < 3:
            continue
        old_negated = has_negation_or_staleness(text)
        if new_negated != old_negated:
            conflicts.append(rel)
    return conflicts[:5]


def conflict_section(args: argparse.Namespace, likely_conflicts: list[str] | None = None) -> str:
    lines: list[str] = []
    likely_conflicts = likely_conflicts or []
    if args.contradicts or likely_conflicts:
        lines.append("## Possible Conflict")
        lines.append("")
        if args.contradicts:
            lines.append("This note was saved with explicit contradiction metadata:")
            for item in args.contradicts:
                lines.append(f"- Contradicts: {item}")
        if likely_conflicts:
            lines.append("Likely conflicts detected before save:")
            for item in likely_conflicts:
                lines.append(f"- Review: [[{Path(item).stem}]] (`{item}`)")
        lines.append("")
    if args.supersedes:
        if not lines:
            lines.extend(["## Supersedes", ""])
        else:
            lines.extend(["## Supersedes", ""])
        for item in args.supersedes:
            lines.append(f"- Supersedes: {item}")
        lines.append("")
    return "\n".join(lines).rstrip()


def compose_body(body: str, args: argparse.Namespace, likely_conflicts: list[str] | None = None) -> str:
    sections = [body.rstrip()]
    conflicts = conflict_section(args, likely_conflicts)
    if conflicts:
        sections.append(conflicts)
    return "\n\n".join(section for section in sections if section).rstrip() + "\n"


def merge_existing(
    existing_text: str,
    body: str,
    sources: list[str],
    related: list[str],
    args: argparse.Namespace,
    likely_conflicts: list[str] | None = None,
) -> str:
    updated = re.sub(r"(?m)^updated:\s*.+$", f"updated: {today()}", existing_text, count=1)
    additions: list[str] = []
    if sources:
        additions.append("Sources revisited: " + ", ".join(sources))
    if related:
        additions.append("Related: " + ", ".join(related))
    if args.contradicts:
        additions.append("Contradicts: " + ", ".join(args.contradicts))
    if args.supersedes:
        additions.append("Supersedes: " + ", ".join(args.supersedes))
    additions.append(compose_body(body, args, likely_conflicts).rstrip())
    return updated.rstrip() + "\n\n## Update " + today() + "\n\n" + "\n".join(additions).rstrip() + "\n"


def ensure_index(provider: DirectFileWikiProvider, note_type: str, title: str, path: str) -> None:
    index_path = "wiki/index.md"
    section = {
        "source": "Sources",
        "concept": "Concepts",
        "entity": "Entities",
        "question": "Questions",
        "query": "Queries",
        "synthesis": "Syntheses",
        "decision": "Decisions",
        "session": "Sessions",
    }.get(note_type, "Syntheses")
    try:
        text = provider.read(index_path)
    except FileNotFoundError:
        text = "# Wiki Index\n\n"
    line = f"- [[{Path(path).stem}]]: {note_type} (status: developing)"
    if line in text:
        return
    heading = f"## {section}"
    if heading not in text:
        text = text.rstrip() + f"\n\n{heading}\n{line}\n"
    else:
        text = text.replace(heading, f"{heading}\n{line}", 1)
    provider.write(index_path, text if text.endswith("\n") else text + "\n")


def prepend_log(provider: DirectFileWikiProvider, note_type: str, title: str, path: str, action: str, sources: list[str]) -> None:
    log_path = "wiki/log.md"
    try:
        text = provider.read(log_path)
    except FileNotFoundError:
        text = "# Wiki Log\n\n"
    entry = (
        f"## [{today()}] save | {title}\n"
        f"- Type: {note_type}\n"
        f"- Location: {path}\n"
        f"- Action: {action}\n"
        f"- Sources: {', '.join(sources) if sources else 'none'}\n\n"
    )
    if text.startswith("# Wiki Log"):
        lines = text.splitlines()
        text = "\n".join(lines[:1]) + "\n\n" + entry + "\n".join(lines[1:]).lstrip() + ("\n" if text.endswith("\n") else "")
    else:
        text = entry + text
    provider.write(log_path, text)


def update_hot(provider: DirectFileWikiProvider, title: str, path: str, action: str) -> None:
    content = (
        "---\n"
        'type: meta\n'
        'title: "Hot Cache"\n'
        f"updated: {now_iso()}\n"
        "---\n\n"
        "# Recent Context\n\n"
        f"## Last Updated {today()}\n\n"
        "## Key Recent Facts\n"
        f"- {action.title()}: [[{Path(path).stem}]]\n\n"
        "## Recent Changes\n"
        f"- {action.title()}: [[{Path(path).stem}]] ({title})\n\n"
        "## Active Threads\n"
        "- No active thread recorded by this save.\n"
    )
    provider.write("wiki/hot.md", content)


def update_overview(provider: DirectFileWikiProvider, title: str, path: str, note_type: str, action: str) -> None:
    overview_path = "wiki/overview.md"
    try:
        text = provider.read(overview_path)
    except FileNotFoundError:
        text = (
            "---\n"
            'type: meta\n'
            'title: "Wiki Overview"\n'
            f"updated: {now_iso()}\n"
            "status: developing\n"
            "---\n\n"
            "# Wiki Overview\n\n"
            "## What This Workspace Is\n\n"
            "## What We Currently Know\n\n"
            "## Active Knowledge Gaps\n\n"
        )
    text = re.sub(r"(?m)^updated:\s*.*$", f"updated: {now_iso()}", text, count=1)
    entry = f"- {today()}: {action.title()} {note_type} [[{Path(path).stem}]]"
    section = "## Recent Durable Updates"
    if entry in text:
        provider.write(overview_path, text if text.endswith("\n") else text + "\n")
        return
    if section not in text:
        text = text.rstrip() + f"\n\n{section}\n{entry}\n"
    else:
        text = text.replace(section, f"{section}\n{entry}", 1)
    provider.write(overview_path, text if text.endswith("\n") else text + "\n")


def save_note(args: argparse.Namespace) -> dict[str, Any]:
    provider = provider_from_workspace(args.workspace)
    folders = configured_folders(args.workspace)
    body = Path(args.body_file).read_text(encoding="utf-8") if args.body_file else args.body
    title = slug_title(args.title)
    note_type = args.type
    sources = args.source or []
    related = args.related or []
    tags = args.tag or []
    existing = None if args.mode == "create-only" else find_existing(provider, folders, note_type, title, sources, args.question)
    likely_conflicts = detect_likely_conflicts(provider, body, title, exclude_path=existing)
    if existing and args.mode != "create-only":
        content = merge_existing(provider.read(existing), body, sources, related, args, likely_conflicts)
        result = provider.write(existing, content)
    else:
        path = f"{note_folder(note_type, folders)}/{title}.md"
        content = frontmatter(note_type, title, tags, sources, related, args) + compose_body(body, args, likely_conflicts)
        result = provider.write(path, content)
    ensure_index(provider, note_type, title, result.path)
    prepend_log(provider, note_type, title, result.path, result.action, sources)
    update_hot(provider, title, result.path, result.action)
    update_overview(provider, title, result.path, note_type, result.action)
    promoted_path = ""
    promote_to = str(getattr(args, "promote_to", "") or "")
    if note_type == "query" and promote_to:
        promoted_title = title
        promoted_sources = [f"[[{Path(result.path).stem}]]", *sources]
        promoted_body = f"Promoted from saved query [[{Path(result.path).stem}]].\n\n{body.rstrip()}\n"
        promoted_path = f"{note_folder(promote_to, folders)}/{promoted_title}.md"
        promoted_content = frontmatter(promote_to, promoted_title, tags, promoted_sources, related, args) + compose_body(
            promoted_body,
            args,
            likely_conflicts,
        )
        promoted = provider.write(promoted_path, promoted_content)
        ensure_index(provider, promote_to, promoted_title, promoted.path)
        prepend_log(provider, promote_to, promoted_title, promoted.path, promoted.action, promoted_sources)
        update_hot(provider, promoted_title, promoted.path, promoted.action)
        update_overview(provider, promoted_title, promoted.path, promote_to, promoted.action)
        promoted_path = promoted.path
    return {
        "path": result.path,
        "action": result.action,
        "transport": result.transport,
        "likely_conflicts": likely_conflicts,
        "promoted_path": promoted_path,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Save a durable note to the canonical Obsidian wiki layer.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--title", required=True)
    parser.add_argument("--type", default="synthesis", choices=["synthesis", "concept", "source", "decision", "session", "entity", "question", "query"])
    parser.add_argument("--body", default="")
    parser.add_argument("--body-file", default="")
    parser.add_argument("--source", action="append")
    parser.add_argument("--related", action="append")
    parser.add_argument("--tag", action="append")
    parser.add_argument("--question", default="")
    parser.add_argument("--answer-quality", default="solid")
    parser.add_argument("--confidence", default="medium")
    parser.add_argument("--url", default="")
    parser.add_argument("--supersedes", action="append")
    parser.add_argument("--contradicts", action="append")
    parser.add_argument("--observed-at", default="")
    parser.add_argument("--valid-from", default="")
    parser.add_argument("--valid-until", default="")
    parser.add_argument("--promote-to", choices=["concept", "synthesis", "decision"], default="")
    parser.add_argument("--mode", choices=["create-or-update", "create-only", "update-only"], default="create-or-update")
    args = parser.parse_args()
    result = save_note(args)
    print(f"{result['action']}: {result['path']} ({result['transport']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
