#!/usr/bin/env python3
"""Report likely wiki artifacts affected by a git diff."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from llm_wiki_lint import note_records, wiki_root_from_config
from llm_wiki_provider import load_config, provider_from_workspace


def changed_files(workspace: Path, base: str) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "--name-only", base, "--"],
        cwd=workspace,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def impact_report(workspace: str | Path, *, base: str = "HEAD") -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    provider = provider_from_workspace(root)
    wiki_root = wiki_root_from_config(root, provider.vault_path)
    changes = changed_files(root, base)
    records = note_records(wiki_root)
    impacted: list[dict[str, str]] = []
    for changed in changes:
        changed_stem = Path(changed).stem.lower()
        changed_terms = {part.lower() for part in Path(changed).parts if len(part) > 2}
        for record in records:
            text = record["text"].lower()
            title = str(record["frontmatter"].get("title") or record["stem"]).lower()
            if changed.lower() in text or changed_stem in title or any(term in text for term in changed_terms):
                impacted.append(
                    {
                        "changed_file": changed,
                        "wiki_page": record["relative"],
                        "reason": "filename_or_path_terms_overlap",
                    }
                )
    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, str]] = []
    for item in impacted:
        key = (item["changed_file"], item["wiki_page"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return {
        "version": 1,
        "workspace": str(root),
        "base": base,
        "changed_files": changes,
        "impacted_pages": deduped,
        "summary": {
            "changed_file_count": len(changes),
            "impacted_page_count": len(deduped),
        },
    }


def markdown_report(payload: dict[str, Any]) -> str:
    lines = ["# Wiki Diff Impact", "", f"- base: `{payload['base']}`", f"- changed files: {len(payload['changed_files'])}", f"- impacted pages: {len(payload['impacted_pages'])}", ""]
    for item in payload["impacted_pages"]:
        lines.append(f"- `{item['changed_file']}` may affect `{item['wiki_page']}` ({item['reason']})")
    return "\n".join(lines).rstrip() + "\n"


def write_report(workspace: str | Path, payload: dict[str, Any]) -> dict[str, str]:
    root = Path(workspace).expanduser().resolve(strict=False)
    provider = provider_from_workspace(root)
    config = load_config(root)
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    reports_path = Path(str(wiki_layer.get("reports_path") or ".llm-wiki/reports"))
    report_dir = reports_path if reports_path.is_absolute() else root / reports_path
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path = report_dir / "diff-impact.json"
    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    meta_result = provider.write("wiki/meta/diff-impact.md", markdown_report(payload))
    return {"json_report_path": str(json_path), "wiki_report_path": meta_result.path}


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze likely wiki impact from a git diff.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    diff = sub.add_parser("diff")
    diff.add_argument("--workspace", default=argparse.SUPPRESS)
    diff.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    diff.add_argument("--base", default="HEAD")
    diff.add_argument("--write", action="store_true")
    args = parser.parse_args()
    payload = impact_report(args.workspace, base=args.base)
    if args.write:
        payload["reports"] = write_report(args.workspace, payload)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(markdown_report(payload), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
