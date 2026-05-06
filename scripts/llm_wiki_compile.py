#!/usr/bin/env python3
"""Compiler-style status and changed-source tracking for llm-wiki workspaces."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from llm_wiki_lint import lint_workspace
from llm_wiki_provider import load_config, provider_from_workspace


DEFAULT_STATE_PATH = ".llm-wiki/state/wiki-compile.json"
DEFAULT_TOTAL_TOKEN_BUDGET = 6000
DEFAULT_PER_SOURCE_TOKEN_BUDGET = 1500


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def slug_title(title: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", title).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "Untitled"


def yaml_scalar(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def wiki_layer_config(workspace: Path) -> dict[str, Any]:
    config = load_config(workspace)
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    return wiki_layer


def compile_config(workspace: Path) -> dict[str, Any]:
    config = load_config(workspace)
    wiki_compile = config.get("wiki_compile") if isinstance(config.get("wiki_compile"), dict) else {}
    return wiki_compile


def estimate_tokens(text: str) -> int:
    # Deterministic approximation used only for budget guardrails.
    return max(1, (len(text) + 3) // 4) if text else 0


def clip_to_token_budget(text: str, token_budget: int) -> str:
    if estimate_tokens(text) <= token_budget:
        return text
    max_chars = max(0, token_budget * 4)
    return text[:max_chars].rstrip()


def prompt_budget_report(workspace: Path, sources: list[Path]) -> dict[str, Any]:
    config = compile_config(workspace)
    total_budget = int(config.get("total_token_budget") or DEFAULT_TOTAL_TOKEN_BUDGET)
    per_source_budget = int(config.get("per_source_token_budget") or DEFAULT_PER_SOURCE_TOKEN_BUDGET)
    total_budget = max(1, total_budget)
    per_source_budget = max(1, per_source_budget)
    fair_share_budget = max(1, total_budget // max(1, len(sources)))
    effective_per_source_budget = min(per_source_budget, fair_share_budget)

    items: list[dict[str, Any]] = []
    total_estimated_tokens = 0
    total_budgeted_tokens = 0
    warnings: list[str] = []
    for path in sources:
        rel = path.relative_to(workspace).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        estimated = estimate_tokens(text)
        budgeted_text = clip_to_token_budget(text, effective_per_source_budget)
        budgeted = estimate_tokens(budgeted_text)
        clipped = estimated > effective_per_source_budget
        total_estimated_tokens += estimated
        total_budgeted_tokens += budgeted
        if clipped:
            warnings.append(
                f"{rel} estimated at {estimated} tokens exceeds per-source budget {effective_per_source_budget}; clipped."
            )
        items.append(
            {
                "path": rel,
                "estimated_tokens": estimated,
                "budgeted_tokens": budgeted,
                "token_budget": effective_per_source_budget,
                "clipped": clipped,
                "excerpt": budgeted_text,
            }
        )
    if total_estimated_tokens > total_budget:
        warnings.append(
            f"Sources estimate {total_estimated_tokens} tokens exceeds total budget {total_budget}; fair-share budget applied."
        )
    return {
        "total_token_budget": total_budget,
        "per_source_token_budget": per_source_budget,
        "effective_per_source_token_budget": effective_per_source_budget,
        "estimated_tokens": total_estimated_tokens,
        "budgeted_tokens": total_budgeted_tokens,
        "warnings": warnings,
        "sources": items,
    }


def state_path(workspace: Path) -> Path:
    wiki_layer = wiki_layer_config(workspace)
    raw = Path(str(wiki_layer.get("compile_state_path") or DEFAULT_STATE_PATH))
    return raw if raw.is_absolute() else workspace / raw


def raw_import_roots(workspace: Path) -> list[Path]:
    candidates = [workspace / "raw" / "imports", workspace / ".raw"]
    return [path for path in candidates if path.exists()]


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "sources": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"version": 1, "sources": {}}
    if not isinstance(payload.get("sources"), dict):
        payload["sources"] = {}
    payload.setdefault("version", 1)
    return payload


def save_state(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def source_files(workspace: Path) -> list[Path]:
    files: list[Path] = []
    for root in raw_import_roots(workspace):
        for path in root.rglob("*"):
            if path.is_file() and ".git" not in path.parts:
                files.append(path)
    return sorted(files)


def source_output_path(workspace: Path, source_path: Path) -> str:
    stem = slug_title(source_path.stem)
    return f"wiki/sources/{stem}.md"


def note_path(note_type: str, title: str) -> str:
    folder = {
        "concept": "wiki/concepts",
        "entity": "wiki/entities",
        "synthesis": "wiki/syntheses",
    }[note_type]
    return f"{folder}/{slug_title(title)}.md"


def compile_source_note(workspace: Path, source_path: Path, token_budget: int) -> tuple[str, str]:
    rel = source_path.relative_to(workspace).as_posix()
    title = slug_title(source_path.stem)
    text = source_path.read_text(encoding="utf-8", errors="replace")
    excerpt = clip_to_token_budget(text, token_budget)
    body = [
        "---",
        "type: source",
        f"title: {yaml_scalar(title)}",
        f"created: {utc_now()}",
        f"updated: {utc_now()}",
        "status: compiled",
        "confidence: source-backed",
        "sources:",
        f"  - {rel}",
        f"source_path: {yaml_scalar(rel)}",
        f"source_sha256: {yaml_scalar(sha256_file(source_path))}",
        "---",
        "",
        f"# {title}",
        "",
        "## Source",
        "",
        f"- Path: `{rel}`",
        f"- SHA-256: `{sha256_file(source_path)}`",
        "",
        "## Extract",
        "",
        excerpt.rstrip(),
        "",
    ]
    return source_output_path(workspace, source_path), "\n".join(body)


def extract_marked_values(text: str, label: str) -> list[str]:
    values: list[str] = []
    pattern = re.compile(rf"(?im)^\s*(?:[-*]\s*)?{re.escape(label)}\s*:\s*(.+?)\s*$")
    for match in pattern.finditer(text):
        value = slug_title(match.group(1))
        if value and value not in values:
            values.append(value)
    return values[:12]


def compile_synthesis_note(workspace: Path, source_path: Path, source_note_path: str, token_budget: int) -> tuple[str, str]:
    rel = source_path.relative_to(workspace).as_posix()
    title = f"{slug_title(source_path.stem)} Synthesis"
    text = source_path.read_text(encoding="utf-8", errors="replace")
    excerpt = clip_to_token_budget(text, max(1, token_budget // 2))
    body = [
        "---",
        "type: synthesis",
        f"title: {yaml_scalar(title)}",
        f"created: {utc_now()}",
        f"updated: {utc_now()}",
        "status: compiled",
        "sources:",
        f"  - [[{Path(source_note_path).stem}]]",
        f"source_path: {yaml_scalar(rel)}",
        "---",
        "",
        f"# {title}",
        "",
        "## Summary",
        "",
        "This deterministic synthesis was compiled from an imported raw source. Review before treating it as approved knowledge.",
        "",
        "## Evidence",
        "",
        f"- Source note: [[{Path(source_note_path).stem}]]",
        f"- Raw path: `{rel}`",
        "",
        "## Extract",
        "",
        excerpt.rstrip(),
        "",
    ]
    return note_path("synthesis", title), "\n".join(body)


def compile_marked_notes(workspace: Path, source_path: Path, source_note_path: str) -> list[tuple[str, str]]:
    rel = source_path.relative_to(workspace).as_posix()
    text = source_path.read_text(encoding="utf-8", errors="replace")
    notes: list[tuple[str, str]] = []
    for title in extract_marked_values(text, "Concept"):
        body = [
            "---",
            "type: concept",
            f"title: {yaml_scalar(title)}",
            f"created: {utc_now()}",
            f"updated: {utc_now()}",
            "status: compiled",
            "sources:",
            f"  - [[{Path(source_note_path).stem}]]",
            "---",
            "",
            f"# {title}",
            "",
            f"Compiled from [[{Path(source_note_path).stem}]] (`{rel}`).",
            "",
        ]
        notes.append((note_path("concept", title), "\n".join(body)))
    for title in extract_marked_values(text, "Entity"):
        body = [
            "---",
            "type: entity",
            f"title: {yaml_scalar(title)}",
            f"created: {utc_now()}",
            f"updated: {utc_now()}",
            f"observed_at: {yaml_scalar(utc_now())}",
            "status: compiled",
            "sources:",
            f"  - [[{Path(source_note_path).stem}]]",
            "---",
            "",
            f"# {title}",
            "",
            f"Compiled entity observation from [[{Path(source_note_path).stem}]] (`{rel}`).",
            "",
        ]
        notes.append((note_path("entity", title), "\n".join(body)))
    return notes


def compile_status(workspace: str | Path) -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    provider = provider_from_workspace(root)
    state_file = state_path(root)
    state = load_state(state_file)
    sources_state = state.get("sources", {})
    changed: list[dict[str, str]] = []
    sources = source_files(root)
    for path in sources:
        rel = path.relative_to(root).as_posix()
        current_hash = sha256_file(path)
        previous = sources_state.get(rel, {}) if isinstance(sources_state, dict) else {}
        if previous.get("sha256") != current_hash:
            changed.append({"path": rel, "sha256": current_hash, "previous_sha256": str(previous.get("sha256") or "")})
    lint = lint_workspace(root)
    budget = prompt_budget_report(root, sources)
    return {
        "version": 1,
        "workspace": str(root),
        "vault": str(provider.vault_path),
        "state_path": str(state_file),
        "source_count": len(sources),
        "page_count": lint["page_count"],
        "pending_changed_sources": len(changed),
        "changed_sources": changed,
        "prompt_budget": budget,
        "lint_summary": lint["summary"],
    }


def mark_compiled(workspace: str | Path, *, changed_only: bool = True) -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    provider = provider_from_workspace(root)
    state_file = state_path(root)
    state = load_state(state_file)
    sources_state = state.setdefault("sources", {})
    status = compile_status(root)
    changed_paths = {item["path"] for item in status["changed_sources"]}
    updated: list[str] = []
    budget_by_path = {item["path"]: int(item["token_budget"]) for item in status["prompt_budget"]["sources"]}
    for path in source_files(root):
        rel = path.relative_to(root).as_posix()
        if changed_only and rel not in changed_paths:
            continue
        token_budget = budget_by_path.get(rel, DEFAULT_PER_SOURCE_TOKEN_BUDGET)
        output_path, content = compile_source_note(root, path, token_budget)
        provider.write(output_path, content)
        synthesis_path, synthesis = compile_synthesis_note(root, path, output_path, token_budget)
        provider.write(synthesis_path, synthesis)
        outputs = [output_path, synthesis_path]
        for extra_path, extra_content in compile_marked_notes(root, path, output_path):
            provider.write(extra_path, extra_content)
            outputs.append(extra_path)
        sources_state[rel] = {
            "sha256": sha256_file(path),
            "last_compiled_at": utc_now(),
            "outputs": outputs,
        }
        updated.append(rel)
    state["last_compile_at"] = utc_now()
    save_state(state_file, state)
    after = compile_status(root)
    return {**after, "compiled_sources": updated}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run llm-wiki compiler status and changed-source tracking.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    status_parser = sub.add_parser("status")
    status_parser.add_argument("--workspace", default=argparse.SUPPRESS)
    status_parser.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    compile_parser = sub.add_parser("compile")
    compile_parser.add_argument("--workspace", default=argparse.SUPPRESS)
    compile_parser.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    compile_parser.add_argument("--changed-only", action="store_true")
    args = parser.parse_args()

    if args.command == "status":
        payload = compile_status(args.workspace)
    else:
        payload = mark_compiled(args.workspace, changed_only=args.changed_only)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"sources: {payload['source_count']}")
        print(f"pages: {payload['page_count']}")
        print(f"pending changed sources: {payload['pending_changed_sources']}")
        print(f"prompt budget warnings: {len(payload['prompt_budget']['warnings'])}")
        print(f"lint: {payload['lint_summary']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
