#!/usr/bin/env python3
"""Capture lifecycle observations as review-gated memory candidates."""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from llm_wiki_provider import load_config


PRIVATE_BLOCK_RE = re.compile(r"<private>.*?</private>", re.IGNORECASE | re.DOTALL)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def memory_capture_config(workspace: Path) -> dict[str, Any]:
    config = load_config(workspace)
    capture = config.get("memory_capture") if isinstance(config.get("memory_capture"), dict) else {}
    return {
        "enabled": bool(capture.get("enabled", False)),
        "candidate_only": bool(capture.get("candidate_only", True)),
        "pii_sensitive": bool(capture.get("pii_sensitive", False)),
        "deny_paths": [str(item) for item in capture.get("deny_paths", []) if str(item)],
        "deny_generated_artifacts": bool(capture.get("deny_generated_artifacts", True)),
    }


def strip_private_blocks(text: str) -> str:
    return PRIVATE_BLOCK_RE.sub("[private content omitted]", text)


def path_denied(path: str, cfg: dict[str, Any]) -> bool:
    normalized = path.replace("\\", "/").lower()
    for denied in cfg.get("deny_paths", []):
        if denied.replace("\\", "/").lower() in normalized:
            return True
    if cfg.get("deny_generated_artifacts"):
        generated_markers = ("reporting/tracking", "portal exports", ".tmp", "tmp", "screenshots", ".png", ".html")
        if any(marker in normalized for marker in generated_markers):
            return True
    return False


def sanitize_observation(text: str, cfg: dict[str, Any]) -> str:
    sanitized = strip_private_blocks(text).strip()
    if cfg.get("pii_sensitive"):
        sanitized = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[email omitted]", sanitized)
        sanitized = re.sub(r"\b\d{3}[-.)\s]?\d{3}[-.\s]?\d{4}\b", "[phone omitted]", sanitized)
    return sanitized


def compress_session_summary(text: str, *, max_items: int = 5) -> list[str]:
    items: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip().lstrip("-*0123456789. ").strip()
        if len(line) < 12:
            continue
        if line not in items:
            items.append(line)
        if len(items) >= max_items:
            break
    if items:
        return items
    compact = re.sub(r"\s+", " ", text).strip()
    return [compact[:240].rstrip()] if compact else []


def candidate_dir(workspace: Path) -> Path:
    return workspace / ".llm-wiki" / "memory-ledger" / "candidates"


def capture_event(workspace: str | Path, *, event: str, observation: str, source_path: str = "", tags: list[str] | None = None) -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    cfg = memory_capture_config(root)
    if source_path and path_denied(source_path, cfg):
        return {"captured": False, "reason": "source_path_denied", "source_path": source_path}
    sanitized = sanitize_observation(observation, cfg)
    if not sanitized or sanitized == "[private content omitted]":
        return {"captured": False, "reason": "empty_after_privacy_filter"}
    payload = {
        "version": 1,
        "status": "candidate",
        "event": event,
        "captured_at": utc_now(),
        "source_path": source_path,
        "tags": tags or [],
        "observation": sanitized,
    }
    if event == "session-end":
        payload["session_summary"] = compress_session_summary(sanitized)
    out_dir = candidate_dir(root)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", f"{event}-{utc_now()}").strip("-").replace(":", "")
    path = out_dir / f"{slug}.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return {"captured": True, "path": str(path), "candidate": payload}


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture a lifecycle observation as a memory candidate.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--event", required=True)
    parser.add_argument("--observation", default="")
    parser.add_argument("--observation-file", default="")
    parser.add_argument("--source-path", default="")
    parser.add_argument("--tag", action="append")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    observation = Path(args.observation_file).read_text(encoding="utf-8") if args.observation_file else args.observation
    payload = capture_event(args.workspace, event=args.event, observation=observation, source_path=args.source_path, tags=args.tag or [])
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(payload.get("path") if payload.get("captured") else f"skipped: {payload.get('reason')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
