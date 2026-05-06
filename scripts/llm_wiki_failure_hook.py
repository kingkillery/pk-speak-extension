#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from llm_wiki_failure_collector import FailureCollector, ensure_bool, ensure_text


def short_tool_goal(tool_name: str, tool_input: Any) -> str:
    if isinstance(tool_input, dict):
        for key in ("description", "command", "prompt", "path", "file_path", "url"):
            value = ensure_text(tool_input.get(key))
            if value:
                return value
    if isinstance(tool_input, str) and ensure_text(tool_input):
        return ensure_text(tool_input)
    return f"Recover from {tool_name} failure."


def infer_kind(tool_name: str) -> str:
    lowered = tool_name.lower()
    if "browser" in lowered or "playwright" in lowered:
        return "ui"
    if "http" in lowered or "fetch" in lowered or "request" in lowered:
        return "http"
    if lowered == "bash":
        return "workflow"
    return "workflow"


def json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def build_payload(hook_input: dict[str, Any]) -> dict[str, Any] | None:
    event_name = ensure_text(hook_input.get("hook_event_name"))
    if event_name == "PostToolUseFailure":
        if ensure_bool(hook_input.get("is_interrupt"), False):
            return None
        tool_name = ensure_text(hook_input.get("tool_name")) or "tool"
        tool_input = hook_input.get("tool_input") or {}
        error = ensure_text(hook_input.get("error")) or "Tool execution failed."
        auto_promote = True
        lowered = error.lower()
        if any(token in lowered for token in ("permission", "authentication", "rate limit", "billing", "interrupt")):
            auto_promote = False
        evidence_parts = [
            f"Claude hook captured a failed tool call for `{tool_name}`.",
            f"Tool input: {json_line(tool_input)}",
            f"Error: {error}",
        ]
        transcript_path = ensure_text(hook_input.get("transcript_path"))
        if transcript_path:
            evidence_parts.append(f"Transcript path: {transcript_path}")
        return {
            "title": f"Claude {tool_name} failure",
            "kind": infer_kind(tool_name),
            "goal": short_tool_goal(tool_name, tool_input),
            "problem": f"{tool_name} failed during Claude Code execution.",
            "trigger": f"Use when Claude repeatedly fails while calling `{tool_name}` with similar inputs.",
            "evidence": "\n".join(evidence_parts),
            "tool_name": tool_name,
            "error_class": slug_error(tool_name, error),
            "error_message": error,
            "session_id": ensure_text(hook_input.get("session_id")),
            "trace_id": ensure_text(hook_input.get("tool_use_id") or hook_input.get("session_id")),
            "agent": "claude-code",
            "route_decision": "complete",
            "artifact_refs": [transcript_path] if transcript_path else [],
            "source_type": "claude_hook_post_tool_use_failure",
            "auto_promote": auto_promote,
            "fingerprint_hint": f"{tool_name} {error}",
            "tags": ["claude-hook", "post-tool-use-failure", tool_name],
        }
    if event_name == "StopFailure":
        error = ensure_text(hook_input.get("error")) or "unknown"
        details = ensure_text(hook_input.get("error_details"))
        message = ensure_text(hook_input.get("last_assistant_message"))
        transcript_path = ensure_text(hook_input.get("transcript_path"))
        evidence_parts = [
            f"Claude hook captured a stop failure: {error}",
        ]
        if details:
            evidence_parts.append(f"Details: {details}")
        if message:
            evidence_parts.append(f"Assistant message: {message}")
        if transcript_path:
            evidence_parts.append(f"Transcript path: {transcript_path}")
        return {
            "title": f"Claude stop failure: {error}",
            "kind": "workflow",
            "goal": "Capture Claude API and stop-time failures for later diagnostics.",
            "problem": "Claude Code ended the turn with an API or stop failure.",
            "trigger": f"Use when Claude surfaces `{error}` during stop-time processing.",
            "evidence": "\n".join(evidence_parts),
            "error_class": f"claude_stop_failure_{slug_error('', error)}",
            "error_message": details or message or error,
            "session_id": ensure_text(hook_input.get("session_id")),
            "trace_id": ensure_text(hook_input.get("session_id")),
            "agent": "claude-code",
            "route_decision": "complete",
            "artifact_refs": [transcript_path] if transcript_path else [],
            "source_type": "claude_hook_stop_failure",
            "auto_promote": False,
            "fingerprint_hint": f"claude stop failure {error}",
            "tags": ["claude-hook", "stop-failure", error],
        }
    return None


def slug_error(tool_name: str, message: str) -> str:
    source = f"{tool_name} {message}".lower()
    compact = "".join(ch if ch.isalnum() else "-" for ch in source)
    compact = "-".join(part for part in compact.split("-") if part)
    return compact[:80] or "failure"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Claude Code hook that records failed tool calls into the llm-wiki failure plane.")
    parser.add_argument("--workspace", default=".", help="Workspace root that contains .llm-wiki/config.json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        print(json.dumps({"continue": True, "suppressOutput": True}))
        return 0

    payload = build_payload(hook_input if isinstance(hook_input, dict) else {})
    if payload:
        collector = FailureCollector(args.workspace)
        recorded = collector.record(payload)
        promoted = collector.promote(fingerprint=recorded["event"]["fingerprint"], limit=1, force=False)
        if promoted.get("promoted"):
            print(
                json.dumps(
                    {
                        "continue": True,
                        "suppressOutput": True,
                        "hookSpecificOutput": {
                            "hookEventName": ensure_text(hook_input.get("hook_event_name")),
                            "additionalContext": "Repeated failure evidence was recorded and matched an EvoSkill promotion threshold.",
                        },
                    }
                )
            )
            return 0

    print(json.dumps({"continue": True, "suppressOutput": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
