#!/usr/bin/env python3
"""Build the skill suggestion index from wiki/skills/active/.

Usage:
    python support/scripts/build_skill_index.py [--workspace PATH] [--backend tei|keyword|stub]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from skill_index import build_index, resolve_embedder


def load_config(workspace: Path) -> dict:
    config_path = workspace / ".llm-wiki" / "config.json"
    if config_path.exists():
        return json.loads(config_path.read_text(encoding="utf-8"))
    return {}


def main() -> int:
    parser = argparse.ArgumentParser(description="Build skill suggestion index.")
    parser.add_argument("--workspace", default=str(Path.cwd()), help="Workspace root")
    parser.add_argument("--backend", choices=["tei", "keyword", "stub"], default=None, help="Embedding backend override")
    parser.add_argument("--tei-url", default=None, help="TEI endpoint URL override")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    config = load_config(workspace)
    skill_config = config.get("skills", {})
    index_config = skill_config.get("index", {})

    backend = args.backend or index_config.get("backend", "keyword")
    tei_url = args.tei_url or index_config.get("tei_url", "http://127.0.0.1:8182/embed")

    active_dir = workspace / skill_config.get("active_dir", "wiki/skills/active")
    output_path = workspace / ".llm-wiki" / "skill-index.json"

    embedder_config = {"backend": backend, "tei_url": tei_url}
    embedder = resolve_embedder(embedder_config)

    print(f"Building skill index from {active_dir} ...")
    print(f"Backend: {backend}")

    index = build_index(active_dir, output_path, embedder=embedder)
    print(f"Indexed {len(index.skills)} skill(s) -> {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
