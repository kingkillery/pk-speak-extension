#!/usr/bin/env python3
"""Build deterministic wiki graph artifacts and guided tours."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from llm_wiki_lint import note_records, wiki_root_from_config
from llm_wiki_provider import load_config, provider_from_workspace


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_links(text: str) -> list[str]:
    return [match.group(1).split("|", 1)[0].strip() for match in re.finditer(r"\[\[([^\]]+)\]\]", text)]


def graph_paths(workspace: Path) -> tuple[Path, Path]:
    config = load_config(workspace)
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    graph_path = Path(str(wiki_layer.get("graph_path") or "graph/graph.json"))
    graph_html_path = Path(str(wiki_layer.get("graph_html_path") or "graph/graph.html"))
    if not graph_path.is_absolute():
        graph_path = workspace / graph_path
    if not graph_html_path.is_absolute():
        graph_html_path = workspace / graph_html_path
    return graph_path, graph_html_path


def graph_cache_key(nodes: list[dict[str, Any]]) -> str:
    payload = json.dumps(
        [{"path": node["path"], "sha256": node["sha256"]} for node in sorted(nodes, key=lambda item: str(item["path"]))],
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_graph(workspace: str | Path, *, write: bool = False) -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    provider = provider_from_workspace(root)
    wiki_root = wiki_root_from_config(root, provider.vault_path)
    records = note_records(wiki_root)
    by_stem = {record["stem"]: record for record in records}
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    for record in records:
        frontmatter = record["frontmatter"]
        node = {
            "id": record["stem"],
            "title": frontmatter.get("title") or record["stem"],
            "path": record["relative"],
            "type": frontmatter.get("type") or "note",
            "category": Path(record["relative"]).parts[1] if len(Path(record["relative"]).parts) > 1 else "",
            "sha256": file_hash(record["path"]),
        }
        nodes.append(node)
        for link in extract_links(record["text"]):
            target = Path(link).stem
            if target in by_stem:
                edges.append({"source": record["stem"], "target": target, "kind": "wikilink", "provenance": "EXTRACTED"})
            else:
                edges.append({"source": record["stem"], "target": target, "kind": "missing-wikilink", "provenance": "AMBIGUOUS"})
        for key in ("related", "sources", "contradicts", "supersedes"):
            values = frontmatter.get(key)
            if isinstance(values, list):
                for value in values:
                    target = Path(str(value).strip("[]")).stem
                    if target in by_stem:
                        edges.append({"source": record["stem"], "target": target, "kind": key, "provenance": "EXTRACTED"})
    cache_key = graph_cache_key(nodes)
    payload = {
        "version": 1,
        "workspace": str(root),
        "wiki_root": str(wiki_root),
        "cache_key": cache_key,
        "cached": False,
        "nodes": sorted(nodes, key=lambda item: str(item["id"])),
        "edges": sorted(edges, key=lambda item: (str(item["source"]), str(item["target"]), str(item["kind"]))),
    }
    if write:
        graph_path, graph_html_path = graph_paths(root)
        if graph_path.exists():
            try:
                cached_payload = json.loads(graph_path.read_text(encoding="utf-8-sig"))
            except json.JSONDecodeError:
                cached_payload = {}
            if cached_payload.get("cache_key") == cache_key:
                cached_payload["cached"] = True
                cached_payload["graph_path"] = str(graph_path)
                cached_payload["graph_html_path"] = str(graph_html_path)
                return cached_payload
        graph_path.parent.mkdir(parents=True, exist_ok=True)
        graph_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        graph_html_path.parent.mkdir(parents=True, exist_ok=True)
        graph_html_path.write_text(render_graph_html(payload), encoding="utf-8")
        payload["graph_path"] = str(graph_path)
        payload["graph_html_path"] = str(graph_html_path)
    return payload


def render_graph_html(payload: dict[str, Any]) -> str:
    data = json.dumps(payload, indent=2)
    return (
        "<!doctype html>\n"
        "<meta charset=\"utf-8\">\n"
        "<title>LLM Wiki Graph</title>\n"
        "<style>body{font-family:system-ui;margin:2rem;max-width:1000px}li{margin:.35rem 0}code{background:#f3f3f3;padding:.1rem .25rem}</style>\n"
        "<h1>LLM Wiki Graph</h1>\n"
        f"<p>Nodes: {len(payload['nodes'])} | Edges: {len(payload['edges'])}</p>\n"
        "<h2>Nodes</h2><ul>\n"
        + "\n".join(f"<li><code>{node['type']}</code> {node['title']} <small>{node['path']}</small></li>" for node in payload["nodes"])
        + "\n</ul><h2>Raw Graph JSON</h2><pre>"
        + data.replace("&", "&amp;").replace("<", "&lt;")
        + "</pre>\n"
    )


def generate_tour(workspace: str | Path, *, topic: str = "onboarding", write: bool = False) -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    graph = build_graph(root)
    priority = {"meta": 0, "synthesis": 1, "concept": 2, "decision": 3, "source": 4, "entity": 5, "query": 6, "session": 7}
    nodes = sorted(graph["nodes"], key=lambda item: (priority.get(str(item.get("type")), 99), str(item.get("title"))))
    steps = [
        {
            "order": index + 1,
            "title": node["title"],
            "path": node["path"],
            "reason": f"Start with this {node['type']} note for {topic}.",
        }
        for index, node in enumerate(nodes[:12])
    ]
    payload = {"version": 1, "workspace": str(root), "topic": topic, "steps": steps}
    if write:
        config = load_config(root)
        wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
        tours_path = Path(str(wiki_layer.get("tours_path") or "wiki/tours"))
        if not tours_path.is_absolute():
            tours_path = provider_from_workspace(root).vault_path / tours_path
        tours_path.mkdir(parents=True, exist_ok=True)
        tour_path = tours_path / f"{re.sub(r'[^A-Za-z0-9_-]+', '-', topic).strip('-') or 'tour'}.md"
        lines = [f"# Tour: {topic}", ""]
        for step in steps:
            lines.append(f"{step['order']}. [[{Path(step['path']).stem}]] - {step['reason']}")
        tour_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        payload["path"] = str(tour_path)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Build llm-wiki graph and tour artifacts.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--workspace", default=argparse.SUPPRESS)
    build.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    build.add_argument("--write", action="store_true")
    tour = sub.add_parser("tour")
    tour.add_argument("--workspace", default=argparse.SUPPRESS)
    tour.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    tour.add_argument("--topic", default="onboarding")
    tour.add_argument("--write", action="store_true")
    args = parser.parse_args()
    payload = build_graph(args.workspace, write=args.write) if args.command == "build" else generate_tour(args.workspace, topic=args.topic, write=args.write)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        if args.command == "build":
            print(f"nodes: {len(payload['nodes'])}")
            print(f"edges: {len(payload['edges'])}")
        else:
            for step in payload["steps"]:
                print(f"{step['order']}. {step['title']} ({step['path']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
