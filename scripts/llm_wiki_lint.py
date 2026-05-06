#!/usr/bin/env python3
"""Lint llm-wiki markdown notes for structural wiki health."""
from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from llm_wiki_provider import load_config, provider_from_workspace


REQUIRED_FRONTMATTER = {
    "source": {"type", "title", "sources", "confidence"},
    "concept": {"type", "title"},
    "entity": {"type", "title", "observed_at"},
    "question": {"type", "title", "question"},
    "query": {"type", "title", "question"},
    "synthesis": {"type", "title", "sources"},
    "decision": {"type", "title", "decision_status"},
    "session": {"type", "title"},
}


@dataclass
class LintFinding:
    code: str
    severity: str
    path: str
    message: str
    suggestion: str = ""


def wiki_root_from_config(workspace: Path, vault_path: Path) -> Path:
    config = load_config(workspace)
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    wiki_path = str(wiki_layer.get("wiki_path") or "wiki")
    raw = Path(wiki_path)
    return raw if raw.is_absolute() else vault_path / raw


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    frontmatter = parts[1]
    body = parts[2]
    parsed: dict[str, Any] = {}
    current_key = ""
    for line in frontmatter.splitlines():
        if not line.strip():
            continue
        if line.startswith("  - ") and current_key:
            parsed.setdefault(current_key, []).append(line[4:].strip())
            continue
        if ":" in line and not line.startswith(" "):
            key, value = line.split(":", 1)
            current_key = key.strip()
            value = value.strip()
            parsed[current_key] = [] if value == "" else value.strip('"')
    return parsed, body


def note_records(wiki_root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not wiki_root.exists():
        return records
    for path in sorted(wiki_root.rglob("*.md")):
        if ".git" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        frontmatter, body = parse_frontmatter(text)
        records.append(
            {
                "path": path,
                "relative": path.relative_to(wiki_root.parent).as_posix(),
                "frontmatter": frontmatter,
                "body": body,
                "text": text,
                "stem": path.stem,
            }
        )
    return records


def wikilinks(text: str) -> list[str]:
    return [match.group(1).split("|", 1)[0].strip() for match in re.finditer(r"\[\[([^\]]+)\]\]", text)]


def lint_workspace(workspace: str | Path) -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    provider = provider_from_workspace(root)
    wiki_root = wiki_root_from_config(root, provider.vault_path)
    records = note_records(wiki_root)
    findings: list[LintFinding] = []
    stems = {record["stem"] for record in records}
    title_to_paths: dict[str, list[str]] = {}
    linked_stems: set[str] = set()

    for record in records:
        rel = str(record["relative"])
        frontmatter = record["frontmatter"]
        note_type = str(frontmatter.get("type") or "").strip()
        title = str(frontmatter.get("title") or record["stem"]).strip()
        title_to_paths.setdefault(title.lower(), []).append(rel)

        if not frontmatter:
            findings.append(LintFinding("missing-frontmatter", "error", rel, "Note is missing YAML frontmatter."))
        if note_type:
            required = REQUIRED_FRONTMATTER.get(note_type, {"type", "title"})
            missing = sorted(key for key in required if key not in frontmatter or frontmatter.get(key) in ("", []))
            if missing:
                findings.append(
                    LintFinding(
                        "missing-required-frontmatter",
                        "warning",
                        rel,
                        f"Missing required frontmatter: {', '.join(missing)}.",
                    )
                )

        if note_type == "decision" and str(frontmatter.get("decision_status") or "").lower() == "active":
            updated = str(frontmatter.get("updated") or "")
            if not updated:
                findings.append(LintFinding("stale-decision-check-missing", "warning", rel, "Active decision has no updated date."))

        if note_type == "source" and not frontmatter.get("sources") and not frontmatter.get("url"):
            findings.append(LintFinding("source-without-citation", "warning", rel, "Source note has no source citation or URL."))

        if note_type == "entity" and not frontmatter.get("observed_at"):
            findings.append(LintFinding("entity-without-observation", "warning", rel, "Entity note has no observed_at timestamp."))

        if frontmatter.get("contradicts") and str(frontmatter.get("status") or "").lower() not in {"superseded", "resolved", "verified"}:
            findings.append(LintFinding("unresolved-contradiction", "warning", rel, "Note has contradiction metadata that is not resolved."))

        for link in wikilinks(record["text"]):
            target = Path(link).stem
            linked_stems.add(target)
            if target not in stems:
                findings.append(LintFinding("broken-wikilink", "error", rel, f"Broken wikilink: [[{link}]]."))

    for title, paths in sorted(title_to_paths.items()):
        if len(paths) > 1:
            findings.append(LintFinding("duplicate-title", "warning", paths[0], f"Duplicate title appears in: {', '.join(paths)}."))

    for record in records:
        if record["stem"] not in linked_stems and record["stem"].lower() not in {"index", "log", "hot", "overview"}:
            findings.append(LintFinding("orphan-note", "info", str(record["relative"]), "Note is not linked from another wiki page."))

    summary: dict[str, int] = {"error": 0, "warning": 0, "info": 0}
    for finding in findings:
        summary[finding.severity] = summary.get(finding.severity, 0) + 1
    return {
        "version": 1,
        "workspace": str(root),
        "vault": str(provider.vault_path),
        "wiki_root": str(wiki_root),
        "page_count": len(records),
        "summary": summary,
        "findings": [asdict(finding) for finding in findings],
    }


def markdown_report(payload: dict[str, Any]) -> str:
    lines = [
        "# Wiki Lint Report",
        "",
        f"- pages: {payload['page_count']}",
        f"- errors: {payload['summary'].get('error', 0)}",
        f"- warnings: {payload['summary'].get('warning', 0)}",
        f"- info: {payload['summary'].get('info', 0)}",
        "",
    ]
    for item in payload["findings"]:
        lines.append(f"- **{item['severity']} {item['code']}** `{item['path']}`: {item['message']}")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Lint llm-wiki markdown notes.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    payload = lint_workspace(args.workspace)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(markdown_report(payload), end="")
    return 1 if payload["summary"].get("error", 0) else 0


if __name__ == "__main__":
    raise SystemExit(main())
