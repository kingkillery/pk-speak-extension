#!/usr/bin/env python3
"""Auto-reducer watcher: draft episodic summaries from session start/end markers.

Usage:
    python scripts/auto_reducer_watcher.py start --session-id <id> --agent <agent> --goal <text> [--workspace PATH]
    python scripts/auto_reducer_watcher.py end --session-id <id> --returncode <N> [--workspace PATH]
    python scripts/auto_reducer_watcher.py list [--workspace PATH]
    python scripts/auto_reducer_watcher.py approve <draft_id> [--workspace PATH]
    python scripts/auto_reducer_watcher.py reject <draft_id> [--workspace PATH]
    python scripts/auto_reducer_watcher.py show <draft_id> [--workspace PATH]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _git_status(workspace: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout if result.returncode == 0 else ""
    except Exception:
        return ""


def _git_diff_names(workspace: Path) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "diff", "--name-status", "HEAD"],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return []
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return lines
    except Exception:
        return []


def _file_list(workspace: Path) -> list[str]:
    """Fallback file list for non-git workspaces."""
    files = []
    try:
        for p in workspace.rglob("*"):
            if p.is_file() and ".git" not in p.parts and ".llm-wiki" not in p.parts:
                files.append(str(p.relative_to(workspace)))
    except Exception:
        pass
    return files


def _infer_candidacy(goal: str, changed_files: list[str]) -> str:
    text = (goal or "") + " " + " ".join(changed_files)
    lowered = text.lower()
    scores = {
        "ui": len(re.findall(r"click|button|dropdown|ui|page|browser|element|selector", lowered)),
        "api": len(re.findall(r"api|endpoint|request|http|post|get|json|curl|fetch", lowered)),
        "debug": len(re.findall(r"test|fix|debug|error|fail|bug|crash|breakpoint|trace", lowered)),
        "workflow": len(re.findall(r"git|deploy|build|ci|cd|pipeline|workflow|release|bump", lowered)),
    }
    best = max(scores, key=lambda k: scores[k])
    return best if scores[best] > 0 else "none"


def _workspace_dirs(workspace: Path) -> tuple[Path, Path, Path, Path]:
    base = workspace / ".llm-wiki" / "skill-pipeline"
    return (
        base,  # pipeline dir
        base / "sessions",  # session markers
        base / "auto-packets",  # drafts
        base / "auto-packets" / "rejected",  # rejected drafts
    )


def cmd_start(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    _, sessions_dir, _, _ = _workspace_dirs(workspace)
    sessions_dir.mkdir(parents=True, exist_ok=True)

    session_id = args.session_id or str(uuid.uuid4())
    marker = {
        "session_id": session_id,
        "agent": args.agent,
        "goal": args.goal,
        "start_time": _now_iso(),
        "start_git_status": _git_status(workspace),
        "start_file_list": _file_list(workspace),
    }
    path = sessions_dir / f"{session_id}.json"
    path.write_text(json.dumps(marker, indent=2), encoding="utf-8")
    print(f"Session marker written: {path}")
    return 0


def cmd_end(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    pipeline_dir, sessions_dir, drafts_dir, rejected_dir = _workspace_dirs(workspace)
    sessions_dir.mkdir(parents=True, exist_ok=True)
    drafts_dir.mkdir(parents=True, exist_ok=True)
    rejected_dir.mkdir(parents=True, exist_ok=True)

    marker_path = sessions_dir / f"{args.session_id}.json"
    if not marker_path.exists():
        print(f"No session marker found for {args.session_id}", file=sys.stderr)
        return 1

    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    end_time = _now_iso()
    returncode = args.returncode

    # Diff workspace state
    end_git_status = _git_status(workspace)
    start_status_lines = set(marker.get("start_git_status", "").splitlines())
    end_status_lines = set(end_git_status.splitlines())
    changed_status = sorted(end_status_lines - start_status_lines)

    # If git status didn't change meaningfully, fall back to mtime scan
    changed_files = changed_status
    if not changed_files:
        start_files = set(marker.get("start_file_list", []))
        end_files = set(_file_list(workspace))
        changed_files = sorted(end_files - start_files)

    outcome = "success" if returncode == 0 else "failure"
    candidacy = _infer_candidacy(marker.get("goal", ""), changed_files)

    draft_id = f"auto-{_now_iso().replace(':', '').replace('-', '')[:14]}-{args.session_id[:8]}"

    draft_md = f"""---
draft_id: {draft_id}
session_id: {args.session_id}
agent: {marker.get('agent', '')}
status: pending
created_at: {end_time}
skill_candidacy: {candidacy}
outcome: {outcome}
returncode: {returncode}
---

## Task Summary

{marker.get('goal', 'No goal recorded.')}

## Files Changed

"""
    if changed_files:
        for line in changed_files:
            draft_md += f"- {line}\n"
    else:
        draft_md += "- No detectable file changes.\n"

    draft_md += f"""
## Outcome

{outcome.capitalize()} (return code {returncode}).

## Skill Candidacy

{candidacy}

## Observations

- Session started: {marker.get('start_time', '')}
- Session ended: {end_time}
- Agent: {marker.get('agent', '')}
"""

    draft_path = drafts_dir / f"{draft_id}.md"
    draft_path.write_text(draft_md, encoding="utf-8")

    # Clean up marker
    marker_path.unlink()

    print(f"Draft reducer packet written: {draft_path}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    _, _, drafts_dir, _ = _workspace_dirs(workspace)
    if not drafts_dir.exists():
        print("No drafts directory.")
        return 0

    drafts = sorted(drafts_dir.glob("auto-*.md"))
    if not drafts:
        print("No pending drafts.")
        return 0

    print(f"Pending drafts ({len(drafts)}):")
    for d in drafts:
        print(f"  {d.stem}")
    return 0


def cmd_approve(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    _, _, drafts_dir, _ = _workspace_dirs(workspace)
    target = drafts_dir / f"{args.draft_id}.md"
    if not target.exists():
        print(f"Draft not found: {target}", file=sys.stderr)
        return 1

    # Move to approved packets dir
    packets_dir = workspace / ".llm-wiki" / "skill-pipeline" / "packets"
    packets_dir.mkdir(parents=True, exist_ok=True)
    dest = packets_dir / target.name
    target.rename(dest)
    print(f"Approved: {dest}")
    return 0


def cmd_reject(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    _, _, drafts_dir, rejected_dir = _workspace_dirs(workspace)
    rejected_dir.mkdir(parents=True, exist_ok=True)
    target = drafts_dir / f"{args.draft_id}.md"
    if not target.exists():
        print(f"Draft not found: {target}", file=sys.stderr)
        return 1

    dest = rejected_dir / target.name
    target.rename(dest)
    print(f"Rejected: {dest}")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    _, _, drafts_dir, rejected_dir = _workspace_dirs(workspace)
    for d in (drafts_dir, rejected_dir):
        target = d / f"{args.draft_id}.md"
        if target.exists():
            print(target.read_text(encoding="utf-8"))
            return 0
    print(f"Draft not found: {args.draft_id}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Auto-reducer watcher")
    parser.add_argument("--workspace", default=str(Path.cwd()), help="Workspace root")
    sub = parser.add_subparsers(dest="command", required=True)

    start_p = sub.add_parser("start", help="Record session start marker")
    start_p.add_argument("--session-id", default="", help="Session identifier")
    start_p.add_argument("--agent", required=True, help="Agent name")
    start_p.add_argument("--goal", default="", help="Task goal / user intent")

    end_p = sub.add_parser("end", help="Generate draft reducer from session end")
    end_p.add_argument("--session-id", required=True, help="Session identifier")
    end_p.add_argument("--returncode", type=int, default=0, help="Process exit code")

    sub.add_parser("list", help="List pending drafts")

    approve_p = sub.add_parser("approve", help="Approve a draft")
    approve_p.add_argument("draft_id", help="Draft ID to approve")

    reject_p = sub.add_parser("reject", help="Reject a draft")
    reject_p.add_argument("draft_id", help="Draft ID to reject")

    show_p = sub.add_parser("show", help="Show draft contents")
    show_p.add_argument("draft_id", help="Draft ID to display")

    args = parser.parse_args()
    handlers = {
        "start": cmd_start,
        "end": cmd_end,
        "list": cmd_list,
        "approve": cmd_approve,
        "reject": cmd_reject,
        "show": cmd_show,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
