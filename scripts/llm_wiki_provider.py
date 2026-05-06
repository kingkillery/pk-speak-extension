#!/usr/bin/env python3
"""Canonical wiki provider interfaces and direct-file Obsidian implementation."""
from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass
class WikiWriteResult:
    path: str
    action: str
    transport: str


class WikiProviderError(RuntimeError):
    pass


class DirectFileWikiProvider:
    transport = "direct-file"

    def __init__(self, vault_path: str | Path) -> None:
        self.vault_path = Path(vault_path).expanduser().resolve(strict=False)

    def resolve_path(self, path: str | Path) -> Path:
        raw = Path(path)
        candidate = raw if raw.is_absolute() else self.vault_path / raw
        resolved = candidate.resolve(strict=False)
        try:
            resolved.relative_to(self.vault_path)
        except ValueError as exc:
            raise WikiProviderError(f"Wiki path escapes vault: {path}") from exc
        return resolved

    def relative_path(self, path: str | Path) -> str:
        return self.resolve_path(path).relative_to(self.vault_path).as_posix()

    def read(self, path: str) -> str:
        return self.resolve_path(path).read_text(encoding="utf-8")

    def write(self, path: str, content: str) -> WikiWriteResult:
        target = self.resolve_path(path)
        action = "updated" if target.exists() else "created"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return WikiWriteResult(path=target.relative_to(self.vault_path).as_posix(), action=action, transport=self.transport)

    def exists(self, path: str) -> bool:
        return self.resolve_path(path).exists()

    def search(self, query: str, *, limit: int = 10) -> list[dict[str, Any]]:
        terms = [term.lower() for term in re.findall(r"[A-Za-z0-9_+-]+", query) if len(term) > 1]
        if not terms:
            return []
        results: list[dict[str, Any]] = []
        for note in self.vault_path.rglob("*.md"):
            if ".git" in note.parts:
                continue
            rel = note.relative_to(self.vault_path).as_posix()
            try:
                text = note.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            haystack = f"{rel}\n{text}".lower()
            score = sum(haystack.count(term) for term in terms)
            if score:
                results.append({"path": rel, "score": score})
        results.sort(key=lambda item: (-int(item["score"]), str(item["path"])))
        return results[:limit]

    def move(self, old_path: str, new_path: str) -> None:
        source = self.resolve_path(old_path)
        target = self.resolve_path(new_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        source.replace(target)

    def tag(self, path: str, tags: list[str]) -> None:
        note = self.resolve_path(path)
        text = note.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            block = "---\ntags:\n" + "".join(f"  - {tag}\n" for tag in tags) + "---\n\n"
            note.write_text(block + text, encoding="utf-8")
            return
        _, frontmatter, body = text.split("---", 2)
        if re.search(r"(?m)^tags:\s*$", frontmatter):
            existing = {match.group(1).strip() for match in re.finditer(r"(?m)^\s*-\s*(.+?)\s*$", frontmatter)}
            additions = "".join(f"  - {tag}\n" for tag in tags if tag not in existing)
            frontmatter = re.sub(r"(?m)^tags:\s*$", "tags:\n" + additions.rstrip("\n"), frontmatter, count=1)
        else:
            frontmatter = frontmatter.rstrip() + "\ntags:\n" + "".join(f"  - {tag}\n" for tag in tags)
        note.write_text("---" + frontmatter + "---" + body, encoding="utf-8")


def load_config(workspace_root: Path) -> dict[str, Any]:
    path = workspace_root / ".llm-wiki" / "config.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def provider_from_workspace(workspace_root: str | Path) -> DirectFileWikiProvider:
    root = Path(workspace_root).expanduser().resolve(strict=False)
    config = load_config(root)
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    obsidian = config.get("obsidian") if isinstance(config.get("obsidian"), dict) else {}
    memory_base = config.get("memory_base") if isinstance(config.get("memory_base"), dict) else {}
    vault = wiki_layer.get("vault_path") or obsidian.get("vault_path") or memory_base.get("vault_path")
    if not vault:
        raise WikiProviderError(
            "Obsidian vault path is not configured. Ask the user where to create or access the Obsidian vault, "
            "then set wiki_layer.vault_path, obsidian.vault_path, or memory_base.vault_path in .llm-wiki/config.json."
        )
    vault_path = Path(str(vault))
    if not vault_path.is_absolute():
        vault_path = root / vault_path
    return DirectFileWikiProvider(vault_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read, write, and search the canonical llm-wiki provider.")
    parser.add_argument("--workspace", default=os.getcwd())
    sub = parser.add_subparsers(dest="command", required=True)
    read = sub.add_parser("read")
    read.add_argument("path")
    write = sub.add_parser("write")
    write.add_argument("path")
    write.add_argument("--content", default="")
    write.add_argument("--content-file", default="")
    exists = sub.add_parser("exists")
    exists.add_argument("path")
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    provider = provider_from_workspace(args.workspace)
    if args.command == "read":
        print(provider.read(args.path), end="")
    elif args.command == "write":
        content = Path(args.content_file).read_text(encoding="utf-8") if args.content_file else args.content
        print(json.dumps(asdict(provider.write(args.path, content)), indent=2))
    elif args.command == "exists":
        return 0 if provider.exists(args.path) else 1
    elif args.command == "search":
        print(json.dumps(provider.search(args.query, limit=args.limit), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
