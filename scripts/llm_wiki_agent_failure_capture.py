#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
from collections import deque
from pathlib import Path
from typing import Any, TextIO

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from llm_wiki_failure_collector import FailureCollector, ensure_text
from skill_index import format_suggestions, suggest_skills


MAX_CAPTURE_CHARS = 12000

AGENT_METADATA: dict[str, dict[str, str]] = {
    "claude": {
        "display_name": "Claude Code",
        "command": "claude",
        "agent_name": "claude-code",
    },
    "codex": {
        "display_name": "Codex",
        "command": "codex",
        "agent_name": "codex",
    },
    "droid": {
        "display_name": "Factory Droid",
        "command": "droid",
        "agent_name": "factory-droid",
    },
    "pi": {
        "display_name": "pi mono",
        "command": "pi",
        "agent_name": "pi-mono",
    },
}


def default_workspace_root() -> Path:
    return SCRIPT_DIR.parent.resolve()


class TailBuffer:
    def __init__(self, limit: int = MAX_CAPTURE_CHARS) -> None:
        self.limit = max(256, limit)
        self.parts: deque[str] = deque()
        self.length = 0

    def append(self, text: str) -> None:
        if not text:
            return
        self.parts.append(text)
        self.length += len(text)
        while self.length > self.limit and self.parts:
            removed = self.parts.popleft()
            self.length -= len(removed)

    def text(self) -> str:
        return "".join(self.parts).strip()


def normalize_argv(argv: list[str]) -> list[str]:
    if argv and argv[0] == "--":
        return argv[1:]
    return argv


def first_positional(argv: list[str]) -> str:
    for item in argv:
        if not item.startswith("-"):
            return item
    return ""


def infer_mode(agent: str, argv: list[str]) -> str:
    first = first_positional(argv)
    args = set(argv)
    if agent == "claude":
        if args.intersection({"-p", "--print", "-h", "--help", "-v", "--version"}):
            return "noninteractive"
        if first in {"agents", "auth", "doctor", "install", "mcp", "plugin", "plugins", "setup-token", "update", "upgrade"}:
            return "noninteractive"
        return "interactive"
    if agent == "codex":
        if args.intersection({"-h", "--help", "-V", "--version"}):
            return "noninteractive"
        if first in {"exec", "review", "login", "logout", "mcp", "mcp-server", "app-server", "completion", "sandbox", "debug", "apply", "cloud", "exec-server", "features", "help"}:
            return "noninteractive"
        return "interactive"
    if agent == "droid":
        if args.intersection({"-h", "--help", "-v", "--version"}):
            return "noninteractive"
        if first in {"exec", "mcp", "plugin", "daemon", "search", "find", "computer", "update"}:
            return "noninteractive"
        return "interactive"
    if agent == "pi":
        if args.intersection({"-p", "--print", "-h", "--help", "-v", "--version", "--list-models", "--export"}):
            return "noninteractive"
        if first in {"install", "remove", "uninstall", "update", "list"}:
            return "noninteractive"
        return "interactive"
    return "interactive"


def resolve_command_name(agent: str, override: str = "") -> str:
    candidate = ensure_text(override) or AGENT_METADATA[agent]["command"]
    resolved = shutil.which(candidate)
    if resolved:
        return resolved
    return candidate


def summarize_goal(agent: str, argv: list[str]) -> str:
    display_name = AGENT_METADATA[agent]["display_name"]
    first = first_positional(argv)
    if agent == "droid" and first == "exec":
        for item in argv[1:]:
            if item and not item.startswith("-"):
                return ensure_text(item)
    if agent == "claude" and ("-p" in argv or "--print" in argv):
        for item in argv:
            if item and not item.startswith("-"):
                return ensure_text(item)
    if agent == "pi" and ("-p" in argv or "--print" in argv):
        for item in argv:
            if item and not item.startswith("-"):
                return ensure_text(item)
    if first:
        return f"Complete `{display_name}` command `{first}`."
    return f"Launch {display_name} successfully."


def classify_error(agent: str, returncode: int, message: str) -> tuple[str, bool]:
    normalized = ensure_text(message).lower()
    prefix = agent.replace("-", "_")
    if any(token in normalized for token in ("authentication", "unauthorized", "api key", "oauth", "token")):
        return (f"{prefix}_auth_failure", False)
    if "rate limit" in normalized:
        return (f"{prefix}_rate_limit", False)
    if "billing" in normalized:
        return (f"{prefix}_billing_error", False)
    if any(token in normalized for token in ("not recognized as", "no such file", "not found", "could not find command", "is not installed")):
        return (f"{prefix}_command_missing", False)
    return (f"{prefix}_exit_{returncode}", True)


def _log_suggestion_event(workspace: Path, agent: str, goal: str, suggestions: list[dict]) -> None:
    """Append a suggestion event to the skill-pipeline suggestions log."""
    try:
        log_dir = workspace / ".llm-wiki" / "skill-pipeline"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "suggestions.jsonl"
        event = {
            "ts": json.dumps(None).replace("null", "") or "",
            "agent": agent,
            "goal": goal,
            "suggested_ids": [s["id"] for s in suggestions],
            "top_score": suggestions[0]["score"] if suggestions else 0.0,
        }
        event["ts"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _log_feedback_event(workspace: Path, skill_id: str, agent: str, goal: str, verdict: int, reason: str) -> None:
    """Append a feedback event for reinforcement tracking."""
    try:
        log_dir = workspace / ".llm-wiki" / "skill-pipeline"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "feedback.jsonl"
        event = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "skill_id": skill_id,
            "agent": agent,
            "goal": goal,
            "verdict": verdict,
            "reason": reason,
        }
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass


def preview_command(command: list[str]) -> str:
    return json.dumps(command, ensure_ascii=True)


def write_stream_text(target: TextIO, text: str) -> None:
    try:
        target.write(text)
        return
    except UnicodeEncodeError:
        encoding = getattr(target, "encoding", None) or "utf-8"
        try:
            safe_bytes = text.encode(encoding, errors="replace")
        except LookupError:
            encoding = "utf-8"
            safe_bytes = text.encode(encoding, errors="replace")
        buffer = getattr(target, "buffer", None)
        if buffer is not None:
            buffer.write(safe_bytes)
            return
        target.write(safe_bytes.decode(encoding, errors="replace"))


def tee_stream(stream: TextIO, target: TextIO, buffer: TailBuffer) -> None:
    try:
        for line in iter(stream.readline, ""):
            write_stream_text(target, line)
            target.flush()
            buffer.append(line)
    finally:
        stream.close()


def run_command(command: list[str], cwd: Path, mode: str) -> dict[str, Any]:
    if mode == "interactive":
        try:
            completed = subprocess.run(command, cwd=str(cwd), check=False)
            return {"returncode": completed.returncode, "stdout": "", "stderr": "", "spawn_error": ""}
        except FileNotFoundError as exc:
            return {"returncode": 127, "stdout": "", "stderr": "", "spawn_error": str(exc)}

    stdout_tail = TailBuffer()
    stderr_tail = TailBuffer()
    try:
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            stdin=None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError as exc:
        return {"returncode": 127, "stdout": "", "stderr": "", "spawn_error": str(exc)}

    assert process.stdout is not None
    assert process.stderr is not None
    stdout_thread = threading.Thread(target=tee_stream, args=(process.stdout, sys.stdout, stdout_tail), daemon=True)
    stderr_thread = threading.Thread(target=tee_stream, args=(process.stderr, sys.stderr, stderr_tail), daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    returncode = process.wait()
    stdout_thread.join()
    stderr_thread.join()
    return {
        "returncode": returncode,
        "stdout": stdout_tail.text(),
        "stderr": stderr_tail.text(),
        "spawn_error": "",
    }


def build_failure_payload(
    *,
    workspace: Path,
    agent: str,
    command: list[str],
    argv: list[str],
    mode: str,
    result: dict[str, Any],
) -> dict[str, Any]:
    meta = AGENT_METADATA[agent]
    error_source = ensure_text(result.get("spawn_error") or result.get("stderr") or result.get("stdout") or f"exit code {result['returncode']}")
    error_class, auto_promote = classify_error(agent, int(result["returncode"]), error_source)
    first = first_positional(argv)
    evidence_parts = [
        f"{meta['display_name']} exited with code {result['returncode']}.",
        f"Wrapper mode: {mode}",
        f"Workspace: {workspace}",
        f"Command: {preview_command(command)}",
    ]
    if ensure_text(result.get("spawn_error")):
        evidence_parts.append(f"Spawn error: {ensure_text(result['spawn_error'])}")
    if ensure_text(result.get("stderr")):
        evidence_parts.append(f"stderr:\n{ensure_text(result['stderr'])}")
    if ensure_text(result.get("stdout")):
        evidence_parts.append(f"stdout tail:\n{ensure_text(result['stdout'])}")
    return {
        "title": f"{meta['display_name']} CLI failure",
        "kind": "workflow",
        "goal": summarize_goal(agent, argv),
        "problem": f"{meta['display_name']} exited before successful completion.",
        "trigger": f"Use when {meta['display_name']} repeatedly fails with the same startup or execution error.",
        "evidence": "\n".join(evidence_parts),
        "tool_name": meta["command"],
        "error_class": error_class,
        "error_message": error_source,
        "agent": meta["agent_name"],
        "route_decision": "complete",
        "source_type": f"{agent}_cli_process_wrapper",
        "auto_promote": auto_promote,
        "fingerprint_hint": " ".join(part for part in [agent, first, error_class, error_source[:160]] if part),
        "benchmark": f"{agent}-cli-wrapper",
        "tags": ["agent-cli-wrapper", agent, mode, first or "session"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an agent CLI and record non-zero exits into the llm-wiki failure plane.")
    parser.add_argument("--workspace", default=str(default_workspace_root()), help="Workspace root that contains .llm-wiki/config.json")
    parser.add_argument("--agent", choices=sorted(AGENT_METADATA), required=True, help="Agent CLI to launch.")
    parser.add_argument("--mode", choices=("auto", "interactive", "noninteractive"), default="auto")
    parser.add_argument("--command-name", default="", help="Override the executable name or absolute path.")
    parser.add_argument("argv", nargs=argparse.REMAINDER, help="Arguments passed to the underlying CLI after `--`.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace = Path(args.workspace).resolve()
    forwarded_args = normalize_argv(list(args.argv))
    command_name = resolve_command_name(args.agent, args.command_name)
    mode = infer_mode(args.agent, forwarded_args) if args.mode == "auto" else args.mode
    command = [command_name, *forwarded_args]
    session_id = str(uuid.uuid4())

    # Auto-reducer start marker (M2)
    try:
        goal = summarize_goal(args.agent, forwarded_args)
        if goal and not goal.startswith("Launch "):
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_DIR / "auto_reducer_watcher.py"),
                    "--workspace", str(workspace),
                    "start",
                    "--session-id", session_id,
                    "--agent", args.agent,
                    "--goal", goal,
                ],
                capture_output=True,
                timeout=10,
            )
    except Exception:
        pass

    # Skill trigger suggestion (M1)
    suggestions: list[dict] = []
    if mode == "interactive" and os.environ.get("LLM_WIKI_SKILL_SUGGEST", "").strip() != "0":
        if goal and not goal.startswith("Launch "):
            try:
                config_path = workspace / ".llm-wiki" / "config.json"
                threshold = 0.3
                if config_path.exists():
                    cfg = json.loads(config_path.read_text(encoding="utf-8"))
                    threshold = cfg.get("skills", {}).get("index", {}).get("threshold", 0.3)
                suggestions = suggest_skills(workspace, goal, top_n=3, threshold=threshold)
                if suggestions:
                    print(format_suggestions(suggestions), file=sys.stderr)
                # Log suggestion event for reinforcement tracking
                _log_suggestion_event(workspace, args.agent, goal, suggestions)
            except Exception:
                # Never block agent launch due to suggestion failure
                pass

    result = run_command(command, workspace, mode)
    returncode = int(result["returncode"])

    # Auto-reducer end marker (M2)
    try:
        if goal and not goal.startswith("Launch "):
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_DIR / "auto_reducer_watcher.py"),
                    "--workspace", str(workspace),
                    "end",
                    "--session-id", session_id,
                    "--returncode", str(returncode),
                ],
                capture_output=True,
                timeout=30,
            )
    except Exception:
        pass

    # Reinforcement hook: log feedback for top suggestion based on outcome (M1)
    try:
        if suggestions and not goal.startswith("Launch "):
            top_skill = suggestions[0]["id"]
            if returncode == 0:
                _log_feedback_event(workspace, top_skill, args.agent, goal, 1, "session succeeded after suggestion")
            else:
                _log_feedback_event(workspace, top_skill, args.agent, goal, -1, "session failed after suggestion")
    except Exception:
        pass

    if returncode == 0:
        return 0

    collector = FailureCollector(workspace)
    payload = build_failure_payload(
        workspace=workspace,
        agent=args.agent,
        command=command,
        argv=forwarded_args,
        mode=mode,
        result=result,
    )
    recorded = collector.record(payload)
    collector.promote(fingerprint=recorded["event"]["fingerprint"], limit=1, force=False)
    return returncode


if __name__ == "__main__":
    raise SystemExit(main())
