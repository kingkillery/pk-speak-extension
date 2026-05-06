#!/usr/bin/env python3
"""Suggest relevant skills for a given task.

Usage:
    python support/scripts/skill_trigger.py --task "user task text" [--workspace PATH] [--top-n 3] [--threshold 0.3]
    python support/scripts/skill_trigger.py --task-file path/to/task.txt [--workspace PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from skill_index import format_suggestions, suggest_skills


def main() -> int:
    parser = argparse.ArgumentParser(description="Suggest skills for a task.")
    parser.add_argument("--workspace", default=str(Path.cwd()), help="Workspace root")
    parser.add_argument("--task", default="", help="Task text to classify")
    parser.add_argument("--task-file", default="", help="File containing task text")
    parser.add_argument("--top-n", type=int, default=3, help="Max suggestions")
    parser.add_argument("--threshold", type=float, default=0.3, help="Minimum score")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of human text")
    parser.add_argument("--quiet", action="store_true", help="Exit 0 even if no suggestions")
    args = parser.parse_args()

    if os.environ.get("LLM_WIKI_SKILL_SUGGEST", "").strip() == "0":
        if args.json:
            print(json.dumps({"suggestions": [], "disabled": True}))
        return 0

    task_text = args.task
    if args.task_file:
        task_text = Path(args.task_file).read_text(encoding="utf-8")

    if not task_text.strip():
        print("Error: --task or --task-file required.", file=sys.stderr)
        return 2

    workspace = Path(args.workspace).resolve()
    suggestions = suggest_skills(workspace, task_text, top_n=args.top_n, threshold=args.threshold)

    if args.json:
        print(json.dumps({"suggestions": suggestions}, indent=2))
    else:
        text = format_suggestions(suggestions)
        if text:
            print(text)

    if not suggestions and not args.quiet:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
