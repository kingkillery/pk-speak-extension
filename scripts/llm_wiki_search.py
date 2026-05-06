#!/usr/bin/env python3
"""Progressive disclosure search for llm-wiki notes."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from llm_wiki_provider import provider_from_workspace


def snippet_for(text: str, query: str, *, limit: int = 220) -> str:
    terms = [term.lower() for term in re.findall(r"[A-Za-z0-9_+-]{3,}", query)]
    lowered = text.lower()
    pos = min([lowered.find(term) for term in terms if lowered.find(term) >= 0] or [0])
    start = max(0, pos - 60)
    snippet = re.sub(r"\s+", " ", text[start : start + limit]).strip()
    return snippet


def search_index(workspace: str | Path, query: str, *, limit: int = 10) -> dict[str, Any]:
    provider = provider_from_workspace(workspace)
    hits = provider.search(query, limit=limit)
    results: list[dict[str, Any]] = []
    for index, hit in enumerate(hits, start=1):
        path = str(hit["path"])
        text = provider.read(path)
        results.append(
            {
                "id": f"r{index}",
                "path": path,
                "title": Path(path).stem,
                "score": hit["score"],
                "snippet": snippet_for(text, query),
                "detail_cost": "full-note",
            }
        )
    return {"version": 1, "query": query, "results": results, "next": "Use get with selected IDs for full note content."}


def timeline(workspace: str | Path, query_or_ids: str, *, limit: int = 10) -> dict[str, Any]:
    provider = provider_from_workspace(workspace)
    try:
        log = provider.read("wiki/log.md")
    except FileNotFoundError:
        log = ""
    terms = [term.lower() for term in re.findall(r"[A-Za-z0-9_+-]{3,}", query_or_ids)]
    entries: list[dict[str, str]] = []
    for block in re.split(r"(?m)^## ", log):
        if not block.strip():
            continue
        text = block.strip()
        haystack = text.lower()
        if not terms or any(term in haystack for term in terms):
            title = text.splitlines()[0]
            entries.append({"title": title, "snippet": re.sub(r"\s+", " ", text)[:300]})
        if len(entries) >= limit:
            break
    return {"version": 1, "query": query_or_ids, "entries": entries}


def get_records(workspace: str | Path, paths: list[str]) -> dict[str, Any]:
    provider = provider_from_workspace(workspace)
    records = []
    for path in paths:
        records.append({"path": path, "title": Path(path).stem, "content": provider.read(path)})
    return {"version": 1, "records": records}


def main() -> int:
    parser = argparse.ArgumentParser(description="Progressive llm-wiki search: index, timeline, get.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=10)
    tl = sub.add_parser("timeline")
    tl.add_argument("query")
    tl.add_argument("--limit", type=int, default=10)
    get = sub.add_parser("get")
    get.add_argument("paths", nargs="+")
    args = parser.parse_args()
    if args.command == "search":
        payload = search_index(args.workspace, args.query, limit=args.limit)
    elif args.command == "timeline":
        payload = timeline(args.workspace, args.query, limit=args.limit)
    else:
        payload = get_records(args.workspace, args.paths)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        if args.command == "get":
            for record in payload["records"]:
                print(f"# {record['title']}\n\n{record['content']}\n")
        else:
            for item in payload.get("results") or payload.get("entries") or []:
                print(f"- {item.get('id', '')} {item.get('title', '')}: {item.get('snippet', '')}".strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
