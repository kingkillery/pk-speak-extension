#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


DEFAULT_TARGETS = "claude,antigravity,codex,droid,pi"
PACKET_ROOT_MARKERS = (
    Path("installers") / "install_g_kade_workspace.py",
    Path("support") / "SYSTEM_CONTRACT.md",
)
WORKSPACE_ROOT_MARKERS = (
    Path(".llm-wiki") / "config.json",
    Path("AGENTS.md"),
)
TEXT_EXTENSIONS = {".md", ".txt", ".json", ".toml", ".yaml", ".yml", ".py", ".ps1", ".sh", ".cmd"}
EXCLUDED_SEARCH_PARTS = {
    ".git",
    ".llm-wiki/node_modules",
    ".llm-wiki/tools",
    ".tmp",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "deps",
}
WORD_RE = re.compile(r"[A-Za-z0-9_./:-]+")
RESULT_STATUSES = {"ok", "skipped", "degraded", "unavailable", "error"}
EVIDENCE_PLANES = ("source", "skills", "preference", "graph", "local")
PLANE_PRIORITY = {
    "source": 0,
    "graph": 1,
    "skills": 2,
    "recent": 3,
    "preference": 4,
    "local": 5,
    "instructions": 6,
}


def python_command() -> list[str]:
    python = shutil.which("python")
    if python:
        return [python]
    py = shutil.which("py")
    if py:
        return [py, "-3"]
    python3 = shutil.which("python3")
    if python3:
        return [python3]
    raise SystemExit("Python is required but was not found in PATH.")


def find_root(start: Path, markers: tuple[Path, ...]) -> Path | None:
    resolved = start.expanduser().resolve()
    probe = resolved if resolved.is_dir() else resolved.parent
    for candidate in (probe, *probe.parents):
        if all((candidate / marker).exists() for marker in markers):
            return candidate
    return None


def resolve_packet_root(explicit: str | None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    env_root = os.getenv("LLM_WIKI_PACKET_ROOT")
    if env_root:
        candidates.append(Path(env_root))
    candidates.extend([Path(__file__).resolve(), Path.cwd()])

    seen: set[Path] = set()
    for candidate in candidates:
        root = find_root(candidate, PACKET_ROOT_MARKERS)
        if root and root not in seen:
            seen.add(root)
            return root
    return None


def resolve_workspace_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()

    for candidate in (Path.cwd(), Path(__file__).resolve()):
        root = find_root(candidate, WORKSPACE_ROOT_MARKERS)
        if root:
            return root
    return Path.cwd().resolve()


def run_command(command: list[str], *, cwd: Path | None = None) -> int:
    completed = subprocess.run(command, cwd=str(cwd) if cwd else None, check=False)
    return completed.returncode


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_slug(value: str, fallback: str = "run") -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-").lower()
    return slug[:80] or fallback


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def read_text(path: Path, limit: int = 8000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:limit]
    except OSError:
        return ""


def tokenize(text: str) -> set[str]:
    return {token.lower() for token in WORD_RE.findall(text)}


def lexical_score(query: str, text: str) -> float:
    query_terms = tokenize(query)
    if not query_terms:
        return 0.0
    text_terms = tokenize(text)
    if not text_terms:
        return 0.0
    overlap = len(query_terms & text_terms)
    return overlap / max(1, len(query_terms))


def confidence_for_score(score: float) -> str:
    if score >= 0.5:
        return "high"
    if score >= 0.2:
        return "medium"
    return "low"


def matched_terms(query: str, text: str) -> list[str]:
    query_terms = set(tokenize(query))
    if not query_terms:
        return []
    text_terms = set(tokenize(text))
    return sorted(query_terms & text_terms)


def confidence_reason(record: dict[str, Any]) -> str:
    status = str(record.get("status") or "ok")
    if status != "ok":
        return f"{status} retrieval status"
    confidence = str(record.get("confidence") or "")
    score = record.get("score", 0.0)
    return f"{confidence or 'low'} confidence from score {score}"


def source_precedence_reason(record: dict[str, Any]) -> str:
    plane = str(record.get("plane") or "")
    if plane == "source":
        return "current source evidence outranks memory"
    if plane == "graph":
        return "graph evidence supports topology and API relationships after source evidence"
    if plane == "preference":
        return "preference memory cannot override current source evidence"
    if plane == "local":
        return "local fallback is used when richer retrieval is unavailable or unnecessary"
    return "ranked by retrieval plane priority and score"


def result_record(
    *,
    plane: str,
    retrieval: str,
    status: str = "ok",
    source: str = "",
    locator: str = "",
    title: str = "",
    snippet: str = "",
    score: float = 0.0,
    confidence: str = "",
    last_modified: str = "",
    provenance: str = "",
    stale: bool = False,
    contradicts: list[str] | None = None,
    error: str = "",
    **extra: Any,
) -> dict[str, Any]:
    normalized_status = status if status in RESULT_STATUSES else "error"
    payload: dict[str, Any] = {
        "plane": plane,
        "retrieval": retrieval,
        "status": normalized_status,
        "source": source,
        "locator": locator,
        "title": title,
        "snippet": " ".join(str(snippet).split())[:420],
        "score": round(float(score), 4),
        "confidence": confidence or confidence_for_score(float(score)),
        "last_modified": last_modified,
        "provenance": provenance,
        "stale": stale,
        "contradicts": contradicts or [],
        "error": error,
        "matched_terms": [],
        "confidence_reason": "",
        "source_precedence_reason": "",
    }
    payload.update(extra)
    return payload


def status_record(plane: str, retrieval: str, status: str, message: str, *, source: str = "", confidence: str = "low") -> dict[str, Any]:
    return result_record(
        plane=plane,
        retrieval=retrieval,
        status=status,
        source=source,
        title=f"{plane} {status}",
        snippet=message,
        confidence=confidence,
        error=message if status in {"degraded", "error", "unavailable"} else "",
    )


def workspace_rel(workspace_root: Path, path: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(workspace_root.resolve(strict=False)).as_posix()
    except ValueError:
        return str(path.resolve(strict=False))


def pipeline_root(workspace_root: Path) -> Path:
    return workspace_root / ".llm-wiki" / "skill-pipeline"


def run_root(workspace_root: Path, run_id: str) -> Path:
    return pipeline_root(workspace_root) / "runs" / run_id


def is_search_excluded(path: Path, workspace_root: Path) -> bool:
    rel = workspace_rel(workspace_root, path)
    normalized = rel.replace("\\", "/")
    parts = set(normalized.split("/"))
    if parts & {".git", ".tmp", ".pytest_cache", "__pycache__", "node_modules", "deps"}:
        return True
    return any(normalized.startswith(prefix + "/") for prefix in EXCLUDED_SEARCH_PARTS if "/" in prefix)


def iter_search_files(workspace_root: Path, *, include_raw: bool = False) -> list[Path]:
    roots = [
        workspace_root / "AGENTS.md",
        workspace_root / "LLM_WIKI_MEMORY.md",
        workspace_root / "SYSTEM_CONTRACT.md",
        workspace_root / "SKILL_CREATION_AT_EXPERT_LEVEL.md",
        workspace_root / "kade",
        workspace_root / "wiki",
        workspace_root / "docs",
        workspace_root / "prompts",
        workspace_root / "support",
        workspace_root / "installers",
        workspace_root / "scripts",
        workspace_root / "tests",
    ]
    if include_raw:
        roots.extend(
            [
                workspace_root / "raw",
                workspace_root / ".raw",
                workspace_root / "fixtures",
                workspace_root / "playgrounds",
            ]
        )
    out: list[Path] = []
    for root in roots:
        if root.is_file() and root.suffix.lower() in TEXT_EXTENSIONS:
            out.append(root)
        elif root.is_dir():
            for path in root.rglob("*"):
                if path.is_file() and path.suffix.lower() in TEXT_EXTENSIONS and not is_search_excluded(path, workspace_root):
                    out.append(path)
    return sorted(set(out))


def search_workspace(
    workspace_root: Path,
    query: str,
    *,
    limit: int = 8,
    include_raw: bool = False,
    plane: str = "local",
    retrieval: str = "local-hybrid-lite",
    status: str = "ok",
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for path in iter_search_files(workspace_root, include_raw=include_raw):
        text = read_text(path, limit=50000 if include_raw else 8000)
        score = lexical_score(query, text + " " + workspace_rel(workspace_root, path))
        if score <= 0:
            continue
        snippet = make_snippet(text, query)
        mtime = ""
        try:
            mtime = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        except OSError:
            pass
        rel = workspace_rel(workspace_root, path)
        results.append(
            result_record(
                plane=plane,
                retrieval=retrieval,
                status=status,
                source=rel,
                locator=rel,
                title=path.stem,
                score=score,
                confidence=confidence_for_score(score),
                last_modified=mtime,
                snippet=snippet,
                provenance="workspace-file",
            )
        )
    results.sort(key=lambda item: (item["score"], item["last_modified"]), reverse=True)
    return results[:limit]


def make_snippet(text: str, query: str, max_chars: int = 420) -> str:
    if not text:
        return ""
    lowered = text.lower()
    positions = [lowered.find(term) for term in tokenize(query) if lowered.find(term) >= 0]
    start = max(0, min(positions) - 120) if positions else 0
    snippet = " ".join(text[start : start + max_chars].split())
    return snippet


def resolve_workspace_path(workspace_root: Path, value: str | None) -> Path | None:
    if not value:
        return None
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return candidate.resolve(strict=False)
    return (workspace_root / candidate).resolve(strict=False)


def sort_command_candidates(candidates: list[str]) -> list[str]:
    if os.name != "nt":
        return candidates
    suffix_rank = {".cmd": 0, ".bat": 0, ".exe": 0, ".ps1": 1, ".js": 2, ".mjs": 2, ".cjs": 2}
    return sorted(candidates, key=lambda value: suffix_rank.get(Path(value).suffix.lower(), 3))


def unusable_windows_shell_shim(path: Path) -> bool:
    if os.name != "nt" or path.suffix.lower() not in {"", ".cmd", ".bat", ".ps1"} or not path.exists():
        return False
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")[:3000].lower()
    except OSError:
        return False
    return "/bin/sh" in text or "bin/sh.exe" in text or ("@kingkillery" in text and "bin/qmd" in text)


def append_existing_candidate(candidates: list[str], path: Path | None) -> None:
    if not path or not path.exists() or unusable_windows_shell_shim(path):
        return
    candidates.append(str(path.resolve(strict=False)))


def configured_command_candidates(workspace_root: Path, config: dict[str, Any], section: str, command_key: str = "command") -> list[str]:
    section_payload = config.get(section) if isinstance(config.get(section), dict) else {}
    candidates: list[str] = []
    for item in section_payload.get("local_command_candidates", []):
        if isinstance(item, str) and item.strip():
            resolved = resolve_workspace_path(workspace_root, item)
            if os.name == "nt" and resolved and not resolved.suffix:
                executable_sibling = any(resolved.with_suffix(suffix).exists() for suffix in (".cmd", ".bat", ".exe", ".ps1"))
                if executable_sibling:
                    continue
            append_existing_candidate(candidates, resolved)
    command = section_payload.get(command_key)
    if isinstance(command, str) and command.strip():
        resolved = resolve_workspace_path(workspace_root, command.strip())
        if resolved and resolved.exists():
            append_existing_candidate(candidates, resolved)
        else:
            found = shutil.which(command.strip())
            if found and not unusable_windows_shell_shim(Path(found)):
                candidates.append(found)
            elif not found:
                candidates.append(command.strip())
    return sort_command_candidates(list(dict.fromkeys(candidates)))


def qmd_command_candidates(workspace_root: Path, config: dict[str, Any]) -> list[str]:
    pk_qmd = config.get("pk_qmd") if isinstance(config.get("pk_qmd"), dict) else {}
    candidates: list[str] = []
    append_existing_candidate(candidates, workspace_root / ".llm-wiki" / "tools" / "bin" / "pk-qmd.cmd")
    append_existing_candidate(candidates, workspace_root / ".llm-wiki" / "tools" / "pk-qmd" / "dist" / "cli" / "qmd.js")
    for key in ("checkout_path", "source_checkout_path"):
        configured = resolve_workspace_path(workspace_root, pk_qmd.get(key) if isinstance(pk_qmd.get(key), str) else "")
        append_existing_candidate(candidates, configured / "dist" / "cli" / "qmd.js" if configured else None)
    append_existing_candidate(candidates, workspace_root / ".llm-wiki" / "node_modules" / "@kingkillery" / "pk-qmd" / "dist" / "cli" / "qmd.js")
    candidates.extend(configured_command_candidates(workspace_root, config, "pk_qmd"))
    return list(dict.fromkeys(candidates))


def command_invocation(command_name: str, args: list[str]) -> list[str]:
    path = Path(command_name)
    suffix = path.suffix.lower()
    if suffix in {".js", ".mjs", ".cjs"}:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node is required to execute JavaScript entrypoints")
        return [node, command_name, *args]
    if suffix == ".py":
        return [*python_command(), command_name, *args]
    if suffix == ".ps1":
        powershell = shutil.which("pwsh") or shutil.which("powershell") or "powershell"
        return [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command_name, *args]
    if suffix in {".cmd", ".bat"}:
        return ["cmd", "/c", command_name, *args]
    return [command_name, *args]


def run_capture(command_name: str, args: list[str], *, cwd: Path, timeout_sec: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command_invocation(command_name, args),
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_sec,
        check=False,
    )


def parse_jsonish(text: str) -> Any:
    raw = text.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    for line in reversed(raw.splitlines()):
        stripped = line.strip()
        if not stripped or stripped[0] not in "[{":
            continue
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            continue
    return None


def flatten_json_items(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("results", "items", "hits", "matches", "evidence", "documents", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            nested = flatten_json_items(value)
            if nested:
                return nested
    return [payload]


def records_from_tool_payload(
    payload: Any,
    *,
    plane: str,
    retrieval: str,
    query: str,
    limit: int,
    provenance: str,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for item in flatten_json_items(payload)[:limit]:
        if isinstance(item, str):
            records.append(
                result_record(
                    plane=plane,
                    retrieval=retrieval,
                    source=provenance,
                    snippet=item,
                    score=lexical_score(query, item) or 0.1,
                    provenance=provenance,
                )
            )
            continue
        if not isinstance(item, dict):
            continue
        source = str(
            item.get("source")
            or item.get("path")
            or item.get("file")
            or item.get("url")
            or item.get("id")
            or provenance
        )
        snippet = str(
            item.get("snippet")
            or item.get("text")
            or item.get("content")
            or item.get("summary")
            or item.get("description")
            or ""
        )
        title = str(item.get("title") or item.get("name") or Path(source).stem)
        score_value = item.get("score")
        try:
            score = float(score_value)
        except (TypeError, ValueError):
            score = lexical_score(query, snippet + " " + title + " " + source) or 0.1
        records.append(
            result_record(
                plane=plane,
                retrieval=retrieval,
                source=source,
                locator=str(item.get("locator") or item.get("line") or item.get("url") or source),
                title=title,
                snippet=snippet or json.dumps(item, sort_keys=True)[:420],
                score=score,
                confidence=str(item.get("confidence") or confidence_for_score(score)),
                last_modified=str(item.get("last_modified") or item.get("mtime") or item.get("updated_at") or ""),
                provenance=provenance,
                stale=bool(item.get("stale", False)),
                contradicts=item.get("contradicts") if isinstance(item.get("contradicts"), list) else [],
            )
        )
    return records


def parse_qmd_text_records(text: str, *, query: str, limit: int) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    chunks = [chunk.strip() for chunk in re.split(r"\n\s*\n(?=qmd://)", text.strip()) if chunk.strip()]
    for chunk in chunks[:limit]:
        lines = chunk.splitlines()
        if not lines or not lines[0].startswith("qmd://"):
            continue
        source = lines[0].split()[0]
        title = ""
        score = lexical_score(query, chunk) or 0.1
        for line in lines[1:6]:
            if line.lower().startswith("title:"):
                title = line.split(":", 1)[1].strip()
            elif line.lower().startswith("score:"):
                raw_score = re.sub(r"[^0-9.]+", "", line)
                if raw_score:
                    try:
                        score = float(raw_score) / (100 if "%" in line else 1)
                    except ValueError:
                        pass
        records.append(
            result_record(
                plane="source",
                retrieval="pk-qmd",
                source=source,
                locator=source,
                title=title or Path(source).stem,
                snippet=chunk,
                score=score,
                confidence=confidence_for_score(score),
                provenance="pk-qmd",
            )
        )
    return records


def brv_records_from_payload(payload: Any, *, query: str, limit: int) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return records_from_tool_payload(payload, plane="preference", retrieval="brv", query=query, limit=limit, provenance="brv")
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("result"), str):
        text = data["result"]
        source = "ByteRover Knowledge Base"
        match = re.search(r"(?im)^source:\s*(.+)$", text)
        if match:
            source = match.group(1).strip()
        return [
            result_record(
                plane="preference",
                retrieval="brv",
                source=source,
                locator=source,
                title="BRV query result",
                snippet=text,
                score=lexical_score(query, text) or 0.1,
                confidence="medium",
                provenance="brv",
                brv_status=str(data.get("status") or ""),
                task_id=str(data.get("taskId") or ""),
            )
        ]
    return records_from_tool_payload(payload, plane="preference", retrieval="brv", query=query, limit=limit, provenance="brv")


def parse_status_payload(raw: str) -> Any:
    parsed = parse_jsonish(raw)
    if parsed is None:
        return {}
    return parsed


def retrieval_metadata_from_args(args: argparse.Namespace) -> dict[str, Any]:
    statuses = parse_status_payload(getattr(args, "retrieval_status_json", "") or "")
    if not isinstance(statuses, dict):
        statuses = {"raw": statuses}
    default_context_sufficient = getattr(args, "default_context_sufficient", "unknown")
    return {
        "planes_used": list(getattr(args, "retrieval_plane", []) or []),
        "plane_statuses": statuses,
        "default_context_sufficient": default_context_sufficient,
        "degraded_or_error": [
            f"{plane}: {status}"
            for plane, status in statuses.items()
            if str(status).lower() in {"degraded", "unavailable", "error", "timeout"}
        ],
    }


def provider_connected(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    data = payload.get("data")
    providers = data.get("providers") if isinstance(data, dict) else payload.get("providers")
    if not isinstance(providers, list):
        return False
    return any(isinstance(provider, dict) and provider.get("isConnected") for provider in providers)


def result_sort_key(item: dict[str, Any]) -> tuple[int, int, float]:
    plane = str(item.get("plane") or "")
    status = str(item.get("status") or "ok")
    try:
        score = float(item.get("score") or 0.0)
    except (TypeError, ValueError):
        score = 0.0
    status_penalty = 0 if status == "ok" else 1
    return (status_penalty, PLANE_PRIORITY.get(plane, 99), -score)


def rank_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(results, key=result_sort_key)


def annotate_results(results: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    for result in results:
        item = dict(result)
        haystack = " ".join(
            str(item.get(key) or "")
            for key in ("title", "source", "locator", "snippet", "provenance")
        )
        item["matched_terms"] = matched_terms(query, haystack)
        item["confidence_reason"] = item.get("confidence_reason") or confidence_reason(item)
        item["source_precedence_reason"] = item.get("source_precedence_reason") or source_precedence_reason(item)
        annotated.append(item)
    return annotated


def dedupe_results(results: list[dict[str, Any]], limit: int | None = None) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for result in rank_results(results):
        source = str(result.get("source") or result.get("locator") or "")
        snippet = str(result.get("snippet") or "")
        digest = hashlib.sha1(snippet.encode("utf-8", errors="ignore")).hexdigest()[:12]
        key = f"{source.lower()}::{digest}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(result)
        if limit and len(deduped) >= limit:
            break
    return deduped


def trim_results_to_budget(results: list[dict[str, Any]], token_budget: int) -> list[dict[str, Any]]:
    if token_budget <= 0:
        return results
    char_budget = max(1000, token_budget * 4)
    used = 0
    kept: list[dict[str, Any]] = []
    for result in results:
        item = dict(result)
        snippet = str(item.get("snippet") or "")
        remaining = char_budget - used
        if remaining <= 0:
            break
        if len(snippet) > remaining:
            item["snippet"] = snippet[: max(0, remaining)]
        used += len(str(item.get("snippet") or ""))
        kept.append(item)
    return kept


def trim_result_list(results: list[dict[str, Any]], token_budget: int, max_items: int) -> list[dict[str, Any]]:
    return trim_results_to_budget(results[:max(0, max_items)], token_budget)


def context_section_budgets(token_budget: int) -> dict[str, tuple[int, int]]:
    budget = max(token_budget, 1000)
    return {
        "instruction_records": (max(600, int(budget * 0.22)), 4),
        "skills": (max(400, int(budget * 0.16)), 5),
        "evidence": (max(700, int(budget * 0.26)), 8),
        "recent_lessons": (max(300, int(budget * 0.10)), 3),
        "preference_hints": (max(300, int(budget * 0.08)), 3),
        "graph_hints": (max(400, int(budget * 0.12)), 5),
    }


def apply_context_section_budgets(bundle: dict[str, Any], token_budget: int) -> dict[str, Any]:
    budgets = context_section_budgets(token_budget)
    section_budget_report: dict[str, dict[str, int]] = {}
    for section, (section_tokens, max_items) in budgets.items():
        value = bundle.get(section)
        if isinstance(value, list):
            original = len(value)
            trimmed = trim_result_list(value, section_tokens, max_items)
            bundle[section] = trimmed
            section_budget_report[section] = {
                "token_budget": section_tokens,
                "max_items": max_items,
                "original_items": original,
                "kept_items": len(trimmed),
            }
    bundle["section_budgets"] = section_budget_report
    return bundle


def read_task_arg(primary: str, file_path: str) -> str:
    if primary:
        return primary
    if file_path:
        return read_text(Path(file_path), limit=12000)
    return ""


def token_terms(text: str) -> set[str]:
    return {term.lower() for term in re.findall(r"[A-Za-z0-9_+-]{3,}", text)}


def context_gate(task: str, loaded_context: str) -> dict[str, Any]:
    task_terms = token_terms(task)
    context_terms = token_terms(loaded_context)
    if not task_terms or not context_terms:
        return {"sufficient": False, "overlap": 0.0, "matched_terms": []}
    matched = sorted(task_terms & context_terms)
    overlap = len(matched) / max(1, len(task_terms))
    return {"sufficient": overlap >= 0.65, "overlap": round(overlap, 3), "matched_terms": matched[:20]}


def classify_retrieval_tier(task: str, *, structural: bool = False) -> str:
    lowered = task.lower()
    cheap_markers = {"preference", "prior decision", "remember", "did we decide", "previously", "last time"}
    full_markers = {"architecture", "multi-hop", "trace", "impact", "graph", "dependencies", "end-to-end", "across"}
    standard_markers = {"research", "compare", "summarize", "source", "evidence", "docs", "paper"}
    if structural or any(marker in lowered for marker in full_markers):
        return "FULL"
    if any(marker in lowered for marker in cheap_markers):
        return "CHEAP"
    if any(marker in lowered for marker in standard_markers):
        return "STANDARD"
    if "?" in task and len(task.split()) <= 12:
        return "CHEAP"
    return "STANDARD"


def retrieval_route_plan(task: str, *, loaded_context: str = "", structural: bool = False, max_hops: int = 3) -> dict[str, Any]:
    gate = context_gate(task, loaded_context)
    if gate["sufficient"]:
        return {
            "version": 1,
            "task": task,
            "decision": "skip-retrieval",
            "tier": "NONE",
            "reason": "loaded_context_sufficient",
            "context_gate": gate,
            "max_hops": 0,
            "steps": [],
            "stop_rules": ["answer directly from loaded context"],
        }
    tier = classify_retrieval_tier(task, structural=structural)
    if tier == "CHEAP":
        steps = ["durable-memory-search", "escalate-to-standard-on-miss"]
    elif tier == "FULL":
        steps = ["source-retrieval-lex-vec-hyde", "durable-memory-search-parallel", "repo-or-wiki-graph-if-structural"]
    else:
        steps = ["source-retrieval-lex-vec", "durable-memory-search-parallel-if-independent"]
    return {
        "version": 1,
        "task": task,
        "decision": "retrieve",
        "tier": tier,
        "reason": f"{tier.lower()}_routing",
        "context_gate": gate,
        "max_hops": max(1, min(max_hops, 3)),
        "steps": steps,
        "stop_rules": [
            "stop after 3 hops",
            "stop when new results overlap prior results by more than 50%",
            "deduplicate chunks before generation",
        ],
    }


def load_skill_suggestions(workspace_root: Path, task: str, top_n: int = 5) -> list[dict[str, Any]]:
    script_dir = Path(__file__).resolve().parent
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))
    try:
        import skill_index  # type: ignore

        return skill_index.suggest_skills(workspace_root, task, top_n=top_n, threshold=0.01)
    except Exception as exc:
        return [{"error": f"skill suggestions unavailable: {exc}"}]


def retrieve_instruction_records(workspace_root: Path) -> list[dict[str, Any]]:
    paths = [
        "AGENTS.md",
        "LLM_WIKI_MEMORY.md",
        "kade/AGENTS.md",
        "kade/KADE.md",
    ]
    records = []
    for rel in paths:
        path = workspace_root / rel
        if not path.exists():
            continue
        records.append(
            result_record(
                plane="instructions",
                retrieval="workspace-guidance",
                source=rel,
                locator=rel,
                title=rel,
                snippet=make_snippet(read_text(path, limit=4000), rel),
                score=1.0,
                confidence="high",
                provenance="workspace-file",
            )
        )
    return records


def retrieve_skill_records(workspace_root: Path, task: str, *, limit: int) -> list[dict[str, Any]]:
    suggestions = load_skill_suggestions(workspace_root, task, top_n=limit)
    records: list[dict[str, Any]] = []
    for item in suggestions:
        if item.get("error"):
            records.append(status_record("skills", "skill-index", "degraded", str(item["error"])))
            continue
        source = str(item.get("path") or item.get("source") or item.get("id") or item.get("name") or "skill-index")
        title = str(item.get("name") or item.get("title") or item.get("id") or Path(source).stem)
        score_value = item.get("score", item.get("rank_score", 0.1))
        try:
            score = float(score_value)
        except (TypeError, ValueError):
            score = lexical_score(task, title + " " + source) or 0.1
        records.append(
            result_record(
                plane="skills",
                retrieval="skill-index",
                source=source,
                locator=source,
                title=title,
                snippet=str(item.get("snippet") or item.get("summary") or item.get("fast_path") or title),
                score=score,
                confidence=str(item.get("confidence") or confidence_for_score(score)),
                provenance="skill-index",
                **{key: value for key, value in item.items() if key not in {"source", "path", "name", "title", "snippet", "summary", "score", "confidence"}},
            )
        )
    return records


def retrieve_local_records(workspace_root: Path, query: str, *, limit: int, include_raw: bool, status: str = "ok") -> list[dict[str, Any]]:
    return search_workspace(
        workspace_root,
        query,
        limit=limit,
        include_raw=include_raw,
        plane="local",
        retrieval="local-hybrid-lite",
        status=status,
    )


def retrieve_qmd_records(
    workspace_root: Path,
    query: str,
    *,
    limit: int,
    timeout_sec: int,
    include_raw: bool,
) -> list[dict[str, Any]]:
    config = load_json(workspace_root / ".llm-wiki" / "config.json")
    candidates = qmd_command_candidates(workspace_root, config)
    if not candidates:
        fallback = retrieve_local_records(workspace_root, query, limit=limit, include_raw=include_raw, status="degraded")
        if fallback:
            return fallback
        return [status_record("source", "pk-qmd", "unavailable", "pk-qmd command is not configured or not found.")]

    attempts = [
        ["search", query, "--json", "-n", str(limit)],
        ["query", query, "--json", "-n", str(limit), "--no-rerank"],
        ["search", query, "-n", str(limit)],
    ]
    errors: list[str] = []
    for command in candidates:
        for args in attempts:
            try:
                completed = run_capture(command, args, cwd=workspace_root, timeout_sec=timeout_sec)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                errors.append(f"{command} {' '.join(args)}: {exc}")
                continue
            if completed.returncode != 0:
                detail = completed.stderr.strip() or completed.stdout.strip() or f"exit code {completed.returncode}"
                errors.append(f"{command} {' '.join(args)}: {detail[:240]}")
                continue
            parsed = parse_jsonish(completed.stdout)
            if parsed is None:
                records = parse_qmd_text_records(completed.stdout, query=query, limit=limit)
                if records:
                    return records
                errors.append(f"{command} {' '.join(args)}: no JSON or parsable text output")
                continue
            records = records_from_tool_payload(parsed, plane="source", retrieval="pk-qmd", query=query, limit=limit, provenance="pk-qmd")
            if records:
                return records

    fallback = retrieve_local_records(workspace_root, query, limit=limit, include_raw=include_raw, status="degraded")
    if fallback:
        for item in fallback:
            item["plane"] = "source"
            item["retrieval"] = "local-fallback-after-pk-qmd"
            item["error"] = "; ".join(errors[-2:])
        return fallback
    return [status_record("source", "pk-qmd", "error", "; ".join(errors[-3:]) or "pk-qmd returned no usable results")]


def retrieve_preference_file_records(workspace_root: Path, task: str, *, limit: int = 3, status: str = "ok") -> list[dict[str, Any]]:
    candidates = [workspace_root / ".factory" / "memories.md", Path.home() / ".kade" / "HUMAN.md"]
    results = []
    for path in candidates:
        if not path.exists():
            continue
        text = read_text(path)
        score = lexical_score(task, text)
        if score <= 0 and path.name == "HUMAN.md":
            score = 0.05
        results.append(
            result_record(
                plane="preference",
                retrieval="preference-file",
                status=status,
                source=workspace_rel(workspace_root, path) if path.is_relative_to(workspace_root) else str(path),
                locator=str(path),
                title=path.name,
                score=score,
                confidence=confidence_for_score(score),
                snippet=make_snippet(text, task),
                provenance="preference-file",
            )
        )
    return results[:limit]


def retrieve_memory_ledger_records(
    workspace_root: Path,
    query: str,
    *,
    limit: int = 5,
    kinds: set[str] | None = None,
) -> list[dict[str, Any]]:
    config = load_json(workspace_root / ".llm-wiki" / "config.json")
    controller = config.get("memory_controller") if isinstance(config.get("memory_controller"), dict) else {}
    configured_path = str(controller.get("ledger_path") or ".llm-wiki/memory-ledger")
    ledger = Path(configured_path)
    if not ledger.is_absolute():
        ledger = workspace_root / ledger
    approved_dir = ledger / "approved"
    if not approved_dir.exists():
        return []
    ranking = controller.get("ranking") if isinstance(controller.get("ranking"), dict) else {}
    lexical_weight = float(ranking.get("lexical_weight", 0.7))
    confidence_weight = float(ranking.get("confidence_weight", 0.2))
    confidence_values = {"low": 0.35, "medium": 0.65, "high": 0.9}
    active_ids: set[str] = set()
    approved_payloads: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(approved_dir.glob("*.json")):
        item = load_json(path)
        if not item or item.get("status") != "approved" or item.get("valid_to") or item.get("superseded_by"):
            continue
        memory_id = str(item.get("id") or "")
        if memory_id:
            active_ids.add(memory_id)
            approved_payloads.append((path, item))
    results: list[dict[str, Any]] = []
    ranked_index: list[dict[str, Any]] = []
    ranked_at = utc_now()
    for path, item in approved_payloads:
        contradictions = [str(value) for value in item.get("contradicts", []) if str(value) in active_ids]
        if contradictions:
            continue
        kind = str(item.get("kind") or "")
        if kinds and kind not in kinds:
            continue
        claim = str(item.get("claim") or "")
        score = lexical_score(query, " ".join([claim, " ".join(item.get("canonical_keys", []))]))
        if score <= 0:
            score = 0.05 if kind == "preference" else 0.0
        if score <= 0:
            continue
        confidence = str(item.get("confidence") or "low")
        boosted = min(1.0, lexical_weight * score + confidence_weight * confidence_values.get(confidence, 0.35))
        item["last_ranked_at"] = ranked_at
        item["rank_score"] = round(boosted, 4)
        write_json(path, item)
        refs = item.get("source_refs") if isinstance(item.get("source_refs"), list) else []
        ref_text = ", ".join(str(ref.get("ref") or "") for ref in refs if isinstance(ref, dict))
        record = result_record(
            plane="preference",
            retrieval="memory-ledger",
            status="ok",
            source=workspace_rel(workspace_root, path),
            locator=str(path),
            title=f"{kind} memory: {item.get('id')}",
            score=boosted,
            confidence=confidence,
            snippet=claim,
            provenance="memory-ledger",
            memory_id=str(item.get("id") or ""),
            memory_kind=kind,
            source_refs=refs,
            supersedes=item.get("supersedes", []),
            contradicts=item.get("contradicts", []),
            ref_text=ref_text,
        )
        results.append(record)
        ranked_index.append(record)
    if ranked_index:
        write_json(ledger / "index.json", {"version": 1, "generated_at": ranked_at, "query": query, "results": ranked_index})
    results.sort(key=lambda record: float(record.get("score") or 0), reverse=True)
    return results[:limit]


def retrieve_brv_records(workspace_root: Path, query: str, *, limit: int, timeout_sec: int) -> list[dict[str, Any]]:
    config = load_json(workspace_root / ".llm-wiki" / "config.json")
    candidates = configured_command_candidates(workspace_root, config, "byterover")
    if not candidates:
        fallback = retrieve_preference_file_records(workspace_root, query, limit=limit, status="degraded")
        if fallback:
            return fallback
        return [status_record("preference", "brv", "unavailable", "BRV command is not configured or not found.")]

    errors: list[str] = []
    for command in candidates:
        try:
            providers = run_capture(command, ["providers", "list", "--format", "json"], cwd=workspace_root, timeout_sec=min(max(timeout_sec, 10), 20))
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            errors.append(f"{command} providers list: {exc}")
            continue
        if providers.returncode != 0:
            detail = providers.stderr.strip() or providers.stdout.strip() or f"exit code {providers.returncode}"
            errors.append(f"{command} providers list: {detail[:240]}")
            continue
        providers_payload = parse_jsonish(providers.stdout)
        if not provider_connected(providers_payload):
            fallback = retrieve_preference_file_records(workspace_root, query, limit=limit, status="degraded")
            message = "BRV has no connected provider; skipped query and used preference files."
            if fallback:
                for item in fallback:
                    item["error"] = message
                return fallback
            return [status_record("preference", "brv", "degraded", message)]
        try:
            completed = run_capture(command, ["query", query, "--format", "json"], cwd=workspace_root, timeout_sec=max(timeout_sec, 20))
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            errors.append(f"{command} query: {exc}")
            continue
        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip() or f"exit code {completed.returncode}"
            errors.append(detail[:240])
            continue
        parsed = parse_jsonish(completed.stdout)
        records = brv_records_from_payload(parsed, query=query, limit=limit)
        if records:
            return records
    fallback = retrieve_preference_file_records(workspace_root, query, limit=limit, status="degraded")
    if fallback:
        for item in fallback:
            item["error"] = "; ".join(errors[-2:])
        return fallback
    return [status_record("preference", "brv", "degraded", "; ".join(errors[-3:]) or "BRV returned no usable results")]


def http_json(url: str, timeout_sec: int) -> Any:
    with urlopen(url, timeout=timeout_sec) as response:  # noqa: S310 - configured local/dev endpoint
        raw = response.read(200000).decode("utf-8", errors="ignore")
    return parse_jsonish(raw)


def http_form_json(url: str, fields: dict[str, Any], *, timeout_sec: int, authorization: str = "") -> Any:
    data = urlencode({key: str(value) for key, value in fields.items() if value is not None}).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if authorization:
        headers["Authorization"] = authorization
    request = Request(url, data=data, headers=headers, method="POST")  # noqa: S310 - configured local/dev endpoint
    with urlopen(request, timeout=timeout_sec) as response:
        raw = response.read(500000).decode("utf-8", errors="ignore")
    return parse_jsonish(raw)


def gitvizz_authorization(gitvizz: dict[str, Any]) -> str:
    direct = gitvizz.get("authorization")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    authorization_env = str(gitvizz.get("authorization_env") or "LLM_WIKI_GITVIZZ_AUTHORIZATION")
    authorization = os.getenv(authorization_env, "").strip()
    if authorization:
        return authorization
    token_env = str(gitvizz.get("auth_token_env") or "LLM_WIKI_GITVIZZ_TOKEN")
    token = os.getenv(token_env, "").strip()
    if token:
        scheme = str(gitvizz.get("auth_scheme") or "Bearer").strip() or "Bearer"
        return f"{scheme} {token}"
    return ""


def gitvizz_repo_id_from_config_or_log(workspace_root: Path, gitvizz: dict[str, Any]) -> str:
    for key in ("indexed_repo_id", "repo_id", "repository_id"):
        value = gitvizz.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for path in (workspace_root / "wiki" / "syntheses" / "gitvizz-local-indexing-2026-04-24.md", workspace_root / "wiki" / "log.md"):
        text = read_text(path, limit=40000)
        match = re.search(r"repo_id[=:`\s]+([0-9a-f]{12,})", text)
        if match:
            return match.group(1)
    return ""


def gitvizz_context_records(payload: Any, *, query: str, limit: int) -> list[dict[str, Any]]:
    records = records_from_tool_payload(payload, plane="graph", retrieval="gitvizz-context-search", query=query, limit=limit, provenance="gitvizz")
    for record in records:
        record["retrieval"] = "gitvizz-context-search"
        record["plane"] = "graph"
    return records


def retrieve_gitvizz_records(workspace_root: Path, query: str, *, limit: int, timeout_sec: int) -> list[dict[str, Any]]:
    config = load_json(workspace_root / ".llm-wiki" / "config.json")
    gitvizz = config.get("gitvizz", {}) if isinstance(config.get("gitvizz"), dict) else {}
    backend = str(gitvizz.get("backend_url") or "").rstrip("/")
    authorization = gitvizz_authorization(gitvizz)
    records: list[dict[str, Any]] = []
    if not backend:
        records.append(status_record("graph", "gitvizz-config", "unavailable", "GitVizz backend URL is not configured."))
        return records

    repo_id = gitvizz_repo_id_from_config_or_log(workspace_root, gitvizz)
    if repo_id:
        try:
            payload = http_form_json(
                urljoin(backend + "/", "api/backend-chat/context/search"),
                {"repository_id": repo_id, "query": query, "max_results": limit},
                timeout_sec=timeout_sec,
                authorization=authorization,
            )
            records.extend(gitvizz_context_records(payload, query=query, limit=limit))
        except HTTPError as exc:
            status = "degraded" if exc.code in {401, 403, 404, 405, 422} else "error"
            records.append(status_record("graph", "gitvizz-context-search", status, f"GitVizz context search failed with HTTP {exc.code}", source=backend))
        except (OSError, TimeoutError, socket.timeout, URLError, ValueError) as exc:
            records.append(status_record("graph", "gitvizz-context-search", "degraded", f"GitVizz context search unavailable: {exc}", source=backend))
    else:
        records.append(status_record("graph", "gitvizz-context-search", "degraded", "GitVizz repository id is not configured; returning graph hints only.", source=backend))

    records.extend(graph_config_records(workspace_root, query, limit=limit))
    return dedupe_results(records, limit=limit)


def graph_config_records(workspace_root: Path, task: str, *, limit: int) -> list[dict[str, Any]]:
    config = load_json(workspace_root / ".llm-wiki" / "config.json")
    gitvizz = config.get("gitvizz", {}) if isinstance(config.get("gitvizz"), dict) else {}
    hints: list[dict[str, Any]] = []
    if gitvizz:
        hints.append(
            result_record(
                plane="graph",
                retrieval="gitvizz-config",
                source=".llm-wiki/config.json",
                locator=str(gitvizz.get("backend_url") or gitvizz.get("frontend_url") or ""),
                title="GitVizz configuration",
                score=0.2,
                confidence="medium",
                snippet="Use GitVizz when code topology, routes, API surfaces, or repository relationships matter.",
                provenance="config",
                frontend_url=gitvizz.get("frontend_url", ""),
                backend_url=gitvizz.get("backend_url", ""),
                repo_id=gitvizz_repo_id_from_config_or_log(workspace_root, gitvizz),
                repo_path=gitvizz.get("repo_path") or gitvizz.get("checkout_path") or "",
                authorization_env=gitvizz.get("authorization_env", "LLM_WIKI_GITVIZZ_AUTHORIZATION"),
                auth_token_env=gitvizz.get("auth_token_env", "LLM_WIKI_GITVIZZ_TOKEN"),
            )
        )
    code_hits = search_workspace(workspace_root, task, limit=limit, include_raw=False, plane="graph", retrieval="local-graph-hints")
    for hit in code_hits:
        if hit["source"].startswith(("support/", "scripts/", "installers/")):
            hints.append(hit)
    return hints[:limit]


def recent_log_lessons(workspace_root: Path, task: str, limit: int = 5) -> list[dict[str, Any]]:
    log_path = workspace_root / "wiki" / "log.md"
    text = read_text(log_path, limit=50000)
    if not text:
        return []
    chunks = [chunk.strip() for chunk in re.split(r"\n(?=#+\s|\d{4}-\d{2}-\d{2}|- )", text) if chunk.strip()]
    scored = [(lexical_score(task, chunk), chunk) for chunk in chunks]
    scored = [(score, chunk) for score, chunk in scored if score > 0]
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        result_record(
            plane="recent",
            retrieval="wiki-log",
            source="wiki/log.md",
            locator="wiki/log.md",
            title="wiki log lesson",
            score=score,
            confidence=confidence_for_score(score),
            snippet=" ".join(chunk.split())[:420],
            provenance="wiki-log",
        )
        for score, chunk in scored[:limit]
    ]


def planner_policy() -> dict[str, str]:
    return {
        "default_injection": "compact",
        "source_precedence": "current source evidence overrides memory",
        "broad_search": "explicit evidence expansion only",
    }


def expansion_suggestions(task: str) -> list[str]:
    return [
        f"llm-wiki-packet evidence --query {json.dumps(task)}",
        f"llm-wiki-packet context --mode deep --task {json.dumps(task)}",
        f"llm-wiki-packet context --mode graph --task {json.dumps(task)}",
        f"llm-wiki-packet context --mode skills --task {json.dumps(task)}",
        f"llm-wiki-packet context --mode preference --task {json.dumps(task)}",
    ]


def result_statuses(results: list[dict[str, Any]]) -> dict[str, str]:
    statuses: dict[str, str] = {}
    rank = {"error": 5, "unavailable": 4, "degraded": 3, "skipped": 2, "ok": 1}
    for item in results:
        plane = str(item.get("plane") or "unknown")
        status = str(item.get("status") or "ok")
        current = statuses.get(plane)
        if current is None or rank.get(status, 0) > rank.get(current, 0):
            statuses[plane] = status
    return statuses


def build_context_bundle(
    workspace_root: Path,
    task: str,
    *,
    mode: str = "default",
    token_budget: int = 4000,
    timeout_sec: int = 20,
    max_results_per_plane: int = 5,
) -> dict[str, Any]:
    include_raw = mode in {"deep", "evidence"}
    evidence_limit = max_results_per_plane * 2 if mode in {"deep", "evidence"} else max_results_per_plane
    instruction_records = retrieve_instruction_records(workspace_root)
    skills = retrieve_skill_records(workspace_root, task, limit=max_results_per_plane) if mode in {"default", "deep", "skills"} else []
    recent = recent_log_lessons(workspace_root, task, limit=3) if mode in {"default", "deep"} else []

    if mode in {"deep", "evidence"}:
        evidence = retrieve_qmd_records(workspace_root, task, limit=evidence_limit, timeout_sec=timeout_sec, include_raw=include_raw)
    elif mode == "graph":
        evidence = retrieve_local_records(workspace_root, task, limit=max_results_per_plane, include_raw=False)
    elif mode == "default":
        evidence = retrieve_local_records(workspace_root, task, limit=evidence_limit, include_raw=False)
    else:
        evidence = []

    preferences = []
    if mode in {"deep", "preference"}:
        preferences = retrieve_brv_records(workspace_root, task, limit=max_results_per_plane, timeout_sec=timeout_sec)
    elif mode == "default":
        preferences = retrieve_preference_file_records(workspace_root, task, limit=3)
    ledger_preferences = retrieve_memory_ledger_records(workspace_root, task, limit=max_results_per_plane)
    preferences = dedupe_results([*ledger_preferences, *preferences], limit=max_results_per_plane)

    graph = retrieve_gitvizz_records(workspace_root, task, limit=max_results_per_plane, timeout_sec=timeout_sec) if mode in {"deep", "graph"} else []
    if mode == "default":
        graph = graph_config_records(workspace_root, task, limit=max_results_per_plane)

    instruction_records = annotate_results(instruction_records, task)
    skills = annotate_results(skills, task)
    evidence = annotate_results(evidence, task)
    recent = annotate_results(recent, task)
    preferences = annotate_results(preferences, task)
    graph = annotate_results(graph, task)
    all_records = dedupe_results([*instruction_records, *skills, *evidence, *recent, *preferences, *graph])
    all_records = trim_results_to_budget(all_records, token_budget)
    bundle = {
        "version": 1,
        "generated_at": utc_now(),
        "workspace": str(workspace_root),
        "task": task,
        "mode": mode,
        "token_budget": token_budget,
        "policy": planner_policy(),
        "retrieval_status": result_statuses(all_records),
        "instructions": [item["source"] for item in instruction_records],
        "instruction_records": instruction_records,
        "skills": skills,
        "evidence": evidence,
        "recent_lessons": recent,
        "preference_hints": preferences,
        "graph_hints": graph,
        "results": all_records,
        "expansion_suggestions": expansion_suggestions(task),
    }
    return apply_context_section_budgets(bundle, token_budget)


def preference_hints(workspace_root: Path, task: str) -> list[dict[str, Any]]:
    return dedupe_results(
        [
            *retrieve_memory_ledger_records(workspace_root, task, limit=5),
            *retrieve_preference_file_records(workspace_root, task),
        ],
        limit=5,
    )


def graph_hints(workspace_root: Path, task: str) -> list[dict[str, Any]]:
    return graph_config_records(workspace_root, task, limit=5)


def print_payload(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2))
        return
    print(markdown_payload(payload))


def markdown_payload(payload: dict[str, Any]) -> str:
    lines = [f"# {payload.get('command', 'llm-wiki packet output')}", ""]
    for key in ("task", "query", "run_id", "mode"):
        if payload.get(key):
            lines.append(f"- {key}: `{payload[key]}`")
    if payload.get("policy"):
        lines.extend(["", "## Policy"])
        for key, value in payload["policy"].items():
            lines.append(f"- {key}: {value}")
    for section in (
        "retrieval_status",
        "instructions",
        "skills",
        "evidence",
        "recent_lessons",
        "preference_hints",
        "graph_hints",
        "expansion_suggestions",
        "artifacts",
        "decision",
    ):
        value = payload.get(section)
        if not value:
            continue
        lines.extend(["", f"## {section.replace('_', ' ').title()}"])
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    label = item.get("title") or item.get("source") or item.get("id") or item.get("suggested_next") or "item"
                    detail = item.get("snippet") or item.get("fast_path") or item.get("confidence") or item.get("status") or ""
                    if item.get("status") and item.get("status") != "ok":
                        detail = f"[{item['status']}] {detail}".strip()
                    lines.append(f"- **{label}** {detail}".rstrip())
                else:
                    lines.append(f"- `{item}`" if "/" in str(item) else f"- {item}")
        elif isinstance(value, dict):
            for key, item in value.items():
                lines.append(f"- {key}: {item}")
        else:
            lines.append(str(value))
    return "\n".join(lines) + "\n"


def add_gitvizz_flag(command: list[str], enable_gitvizz: bool) -> None:
    if not enable_gitvizz:
        command.append("--skip-gitvizz")


def packet_script(workspace_root: Path, packet_root: Path | None, relative_path: str) -> Path:
    workspace_candidate = workspace_root / relative_path
    if workspace_candidate.exists():
        return workspace_candidate

    if packet_root is not None:
        source_relative = relative_path
        if relative_path.startswith("scripts" + os.sep):
            source_relative = os.path.join("support", relative_path)
        packet_candidate = packet_root / source_relative
        if packet_candidate.exists():
            return packet_candidate

    raise SystemExit(f"Missing required script: {workspace_candidate}")


def build_evidence_bundle(
    workspace_root: Path,
    query: str,
    *,
    plane: str = "all",
    limit: int = 10,
    deep: bool = False,
    include_raw: bool = False,
    timeout_sec: int = 20,
    max_results_per_plane: int = 5,
) -> dict[str, Any]:
    requested_planes = list(EVIDENCE_PLANES) if plane == "all" else [plane]
    per_plane_limit = max(1, max_results_per_plane)
    raw_enabled = include_raw or deep
    results: list[dict[str, Any]] = []
    for selected in requested_planes:
        if selected == "source":
            results.extend(
                retrieve_qmd_records(
                    workspace_root,
                    query,
                    limit=per_plane_limit,
                    timeout_sec=timeout_sec,
                    include_raw=raw_enabled,
                )
            )
        elif selected == "skills":
            results.extend(retrieve_skill_records(workspace_root, query, limit=per_plane_limit))
        elif selected == "preference":
            results.extend(retrieve_memory_ledger_records(workspace_root, query, limit=per_plane_limit))
            results.extend(retrieve_brv_records(workspace_root, query, limit=per_plane_limit, timeout_sec=timeout_sec))
        elif selected == "graph":
            results.extend(retrieve_gitvizz_records(workspace_root, query, limit=per_plane_limit, timeout_sec=timeout_sec))
        elif selected == "local":
            results.extend(retrieve_local_records(workspace_root, query, limit=per_plane_limit, include_raw=raw_enabled))
    results = annotate_results(dedupe_results(results, limit=limit), query)
    return {
        "command": "llm-wiki-packet evidence",
        "version": 1,
        "generated_at": utc_now(),
        "workspace": str(workspace_root),
        "query": query,
        "mode": "deep" if deep else "evidence",
        "plane": plane,
        "policy": {
            "retrieval": "broad search is explicit",
            "injection": "rerank and inject only cited results needed for the task",
            "source_precedence": "current source evidence overrides memory",
        },
        "retrieval_status": result_statuses(results),
        "evidence": results,
        "results": results,
        "expansion_suggestions": [
            f"llm-wiki-packet context --mode default --task {json.dumps(query)}",
            f"llm-wiki-packet context --mode graph --task {json.dumps(query)}",
            f"llm-wiki-packet evidence --plane source --query {json.dumps(query)}",
            f"llm-wiki-packet evidence --plane preference --query {json.dumps(query)}",
        ],
    }


def record_retrieval_event(workspace_root: Path, run_id: str, command_name: str, payload: dict[str, Any]) -> None:
    if not run_id:
        return
    root = run_root(workspace_root, run_id)
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    manifest = load_json(manifest_path)
    if not manifest:
        manifest = ensure_manifest(workspace_root, run_id, task=str(payload.get("task") or payload.get("query") or ""))
    retrieval = manifest.get("retrieval") if isinstance(manifest.get("retrieval"), dict) else {}
    statuses = payload.get("retrieval_status") if isinstance(payload.get("retrieval_status"), dict) else {}
    planes = sorted(statuses.keys())
    events = retrieval.get("events") if isinstance(retrieval.get("events"), list) else []
    event = {
        "created_at": utc_now(),
        "command": command_name,
        "mode": payload.get("mode", ""),
        "plane": payload.get("plane", "context"),
        "planes_used": planes,
        "plane_statuses": statuses,
        "result_count": len(payload.get("results", [])) if isinstance(payload.get("results"), list) else 0,
        "default_context_sufficient": "unknown",
    }
    events.append(event)
    merged_statuses = dict(retrieval.get("plane_statuses") if isinstance(retrieval.get("plane_statuses"), dict) else {})
    merged_statuses.update(statuses)
    merged_planes = list(dict.fromkeys([*(retrieval.get("planes_used") if isinstance(retrieval.get("planes_used"), list) else []), *planes]))
    retrieval.update(
        {
            "planes_used": merged_planes,
            "plane_statuses": merged_statuses,
            "default_context_sufficient": retrieval.get("default_context_sufficient", "unknown"),
            "degraded_or_error": [
                f"{plane}: {status}"
                for plane, status in merged_statuses.items()
                if str(status).lower() in {"degraded", "unavailable", "error", "timeout"}
            ],
            "last_event": event,
            "events": events[-20:],
        }
    )
    manifest["retrieval"] = retrieval
    write_json(manifest_path, manifest)


def command_init(args: argparse.Namespace) -> int:
    packet_root = resolve_packet_root(args.packet_root)
    if packet_root is None:
        raise SystemExit(
            "Unable to locate the llm_wiki_prompt_packet checkout. "
            "Run this command from the packet repo or pass --packet-root."
        )

    installer = packet_root / "installers" / "install_g_kade_workspace.py"
    project_root = Path(args.project_root).expanduser().resolve()
    if not project_root.exists():
        raise SystemExit(f"Project root does not exist: {project_root}")

    home_root = Path(args.home_root).expanduser()
    home_root_arg = str(home_root.resolve()) if home_root.exists() else str(home_root)

    command = python_command() + [
        str(installer),
        "--workspace",
        str(project_root),
        "--targets",
        args.targets,
        "--home-root",
        home_root_arg,
        "--install-scope",
        args.install_scope,
    ]
    if args.skip_home_skills:
        command.append("--skip-home-skills")
    else:
        command.append("--install-home-skills")
    if args.allow_global_tool_install:
        command.append("--allow-global-tool-install")
    if args.enable_gitvizz:
        command.append("--enable-gitvizz")
    if args.qmd_source_checkout:
        command.extend(["--qmd-source-checkout", args.qmd_source_checkout])
    if args.skip_setup:
        command.append("--skip-setup")
    if args.preflight_only:
        command.append("--preflight-only")
    if args.force:
        command.append("--force")
    return run_command(command)


def command_runtime_helper(args: argparse.Namespace, helper_kind: str) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    runtime_script = packet_script(workspace_root, None, os.path.join("scripts", "llm_wiki_memory_runtime.py"))
    command = python_command() + [str(runtime_script), helper_kind]
    add_gitvizz_flag(command, args.enable_gitvizz)
    if args.allow_global_tool_install:
        command.append("--allow-global-tool-install")
    return run_command(command, cwd=workspace_root)


def command_setup(args: argparse.Namespace) -> int:
    return command_runtime_helper(args, "setup")


def command_check(args: argparse.Namespace) -> int:
    return command_runtime_helper(args, "check")


def command_memory(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    controller = packet_script(workspace_root, None, os.path.join("scripts", "llm_wiki_memory_controller.py"))
    command = python_command() + [str(controller), "--workspace-root", str(workspace_root), *args.memory_args]
    return run_command(command, cwd=workspace_root)


def command_pokemon_benchmark(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    packet_root = resolve_packet_root(args.packet_root)
    adapter = packet_script(workspace_root, packet_root, os.path.join("scripts", "pokemon_benchmark_adapter.py"))
    mode = args.mode_flag or args.mode or "framework"
    if args.mode_flag and args.mode and args.mode_flag != args.mode:
        raise SystemExit("Conflicting Pokemon benchmark modes supplied. Use either the positional mode or --mode.")
    command = python_command() + [
        str(adapter),
        mode,
        "--gym-repo",
        args.gym_repo,
        "--env-dir",
        args.env_dir,
        "--task-json",
        args.task_json,
        "--seed",
        str(args.seed),
    ]
    if args.output_root:
        command.extend(["--output-root", args.output_root])
    if args.keep_session:
        command.append("--keep-session")
    if mode == "framework":
        command.extend(["--agent", args.agent, "--timeout-sec", str(args.timeout_sec)])
    return run_command(command, cwd=workspace_root)


def command_context(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    task = read_task_arg(args.task, args.task_file)
    if not task:
        raise SystemExit("context requires --task or --task-file")
    payload = build_context_bundle(
        workspace_root,
        task,
        mode=args.mode,
        token_budget=args.token_budget,
        timeout_sec=args.timeout_sec,
        max_results_per_plane=args.max_results_per_plane,
    )
    payload["command"] = "llm-wiki-packet context"
    if args.run_id:
        record_retrieval_event(workspace_root, args.run_id, "context", payload)
        payload["run_id"] = args.run_id
    print_payload(payload, args.json)
    return 0


def command_evidence(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    query = read_task_arg(args.query, args.query_file)
    if not query:
        raise SystemExit("evidence requires --query or --query-file")
    payload = build_evidence_bundle(
        workspace_root,
        query,
        plane=args.plane,
        limit=args.limit,
        deep=args.deep,
        include_raw=args.include_raw,
        timeout_sec=args.timeout_sec,
        max_results_per_plane=args.max_results_per_plane,
    )
    if args.run_id:
        record_retrieval_event(workspace_root, args.run_id, "evidence", payload)
        payload["run_id"] = args.run_id
    print_payload(payload, args.json)
    return 0


def command_route(args: argparse.Namespace) -> int:
    task = read_task_arg(args.task, args.task_file)
    if not task:
        raise SystemExit("route requires --task or --task-file")
    loaded_context = read_task_arg(args.loaded_context, args.loaded_context_file)
    payload = retrieval_route_plan(
        task,
        loaded_context=loaded_context,
        structural=args.structural,
        max_hops=args.max_hops,
    )
    payload["command"] = "llm-wiki-packet route"
    print_payload(payload, args.json)
    return 0


def command_manifest(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    seed = args.title or args.task or "agentic-run"
    run_id = args.run_id or f"{safe_slug(seed)}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}"
    root = run_root(workspace_root, run_id)
    manifest = {
        "version": 1,
        "run_id": run_id,
        "created_at": utc_now(),
        "workspace": str(workspace_root),
        "title": args.title or seed,
        "task": args.task,
        "success_criteria": [item for item in args.success_criteria if item],
        "prompt_version": args.prompt_version,
        "tool_version": args.tool_version,
        "model": args.model,
        "skills": args.skill,
        "retrieval": retrieval_metadata_from_args(args),
        "budget": {
            "tokens": args.token_budget,
            "seconds": args.timeout_sec,
        },
        "artifacts": {
            "root": workspace_rel(workspace_root, root),
            "manifest": workspace_rel(workspace_root, root / "manifest.json"),
            "reducer_packet": workspace_rel(workspace_root, root / "reducer_packet.md"),
            "claims": workspace_rel(workspace_root, root / "claims.json"),
            "evaluation": workspace_rel(workspace_root, root / "evaluation.json"),
            "promotion": workspace_rel(workspace_root, root / "promotion_decision.json"),
            "improvement": workspace_rel(workspace_root, root / "improvement_proposal.json"),
        },
    }
    write_json(root / "manifest.json", manifest)
    payload = {"command": "llm-wiki-packet manifest", "run_id": run_id, "artifacts": manifest["artifacts"]}
    print_payload(payload, args.json)
    return 0


def ensure_manifest(workspace_root: Path, run_id: str, task: str = "") -> dict[str, Any]:
    root = run_root(workspace_root, run_id)
    manifest_path = root / "manifest.json"
    manifest = load_json(manifest_path)
    if manifest:
        return manifest
    manifest = {
        "version": 1,
        "run_id": run_id,
        "created_at": utc_now(),
        "workspace": str(workspace_root),
        "title": run_id,
        "task": task,
        "success_criteria": [],
        "prompt_version": "",
        "tool_version": "",
        "model": "",
        "skills": [],
        "retrieval": {
            "planes_used": [],
            "plane_statuses": {},
            "default_context_sufficient": "unknown",
            "degraded_or_error": [],
        },
        "budget": {},
        "artifacts": {
            "root": workspace_rel(workspace_root, root),
            "manifest": workspace_rel(workspace_root, manifest_path),
            "reducer_packet": workspace_rel(workspace_root, root / "reducer_packet.md"),
            "claims": workspace_rel(workspace_root, root / "claims.json"),
            "evaluation": workspace_rel(workspace_root, root / "evaluation.json"),
            "promotion": workspace_rel(workspace_root, root / "promotion_decision.json"),
            "improvement": workspace_rel(workspace_root, root / "improvement_proposal.json"),
        },
    }
    write_json(manifest_path, manifest)
    return manifest


def load_memory_controller_module() -> Any | None:
    controller_path = Path(__file__).resolve().parent / "llm_wiki_memory_controller.py"
    if not controller_path.exists():
        return None
    spec = importlib.util.spec_from_file_location("llm_wiki_memory_controller_runtime", controller_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def auto_extract_memory_for_run(workspace_root: Path, run_id: str, task: str) -> dict[str, Any]:
    module = load_memory_controller_module()
    if module is None:
        return {"status": "unavailable", "message": "memory controller script is unavailable"}
    try:
        raw_path = run_root(workspace_root, run_id) / "raw.txt"
        source_file = str(raw_path) if raw_path.exists() else ""
        extract_args = argparse.Namespace(text="", source_file=source_file, run_id="" if source_file else run_id, task=task)
        payload = module.cmd_extract(workspace_root, extract_args)
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
    return {
        "status": "ok",
        "staged": len(payload.get("staged", [])),
        "approved": len(payload.get("approved", [])),
        "merged": len(payload.get("merged", [])),
        "filtered": len(payload.get("filtered", [])),
        "projection": payload.get("projection", ""),
    }


def command_reduce(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    source_text = args.text or read_text(Path(args.source_file), limit=50000) if args.source_file else args.text
    if not source_text:
        raise SystemExit("reduce requires --text or --source-file")
    run_id = args.run_id or f"reduce-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}"
    manifest = ensure_manifest(workspace_root, run_id, task=args.task or source_text[:240])
    claims = extract_claims(source_text, args.task or manifest.get("task", ""))
    root = run_root(workspace_root, run_id)
    packet = render_reducer_packet(manifest, source_text, claims)
    root.mkdir(parents=True, exist_ok=True)
    (root / "raw.txt").write_text(source_text, encoding="utf-8")
    (root / "reducer_packet.md").write_text(packet, encoding="utf-8")
    write_json(root / "claims.json", {"version": 1, "run_id": run_id, "claims": claims})
    memory_extraction = auto_extract_memory_for_run(workspace_root, run_id, args.task or str(manifest.get("task") or ""))
    manifest = load_json(root / "manifest.json") or manifest
    manifest["memory_extraction"] = memory_extraction
    write_json(root / "manifest.json", manifest)
    payload = {
        "command": "llm-wiki-packet reduce",
        "run_id": run_id,
        "memory_extraction": memory_extraction,
        "artifacts": {
            "raw": workspace_rel(workspace_root, root / "raw.txt"),
            "reducer_packet": workspace_rel(workspace_root, root / "reducer_packet.md"),
            "claims": workspace_rel(workspace_root, root / "claims.json"),
        },
    }
    print_payload(payload, args.json)
    return 0


def extract_claims(text: str, task: str) -> list[dict[str, Any]]:
    sentences = re.split(r"(?<=[.!?])\s+|\n+-\s+", text)
    claims: list[dict[str, Any]] = []
    for sentence in sentences:
        cleaned = " ".join(sentence.strip().split())
        if len(cleaned) < 24:
            continue
        evidence = re.findall(r"https?://[^\s)>\]]+", cleaned)
        confidence = "medium" if evidence else "low"
        claims.append(
            {
                "claim": cleaned[:700],
                "evidence": evidence,
                "confidence": confidence,
                "claim_type": "finding",
                "verification_method": "citation-present" if evidence else "unverified-reducer",
                "source_diversity": len(set(evidence)),
                "cohort_agreement": "",
                "contradictions": [],
            }
        )
        if len(claims) >= 20:
            break
    if not claims and task:
        claims.append(
            {
                "claim": task,
                "evidence": [],
                "confidence": "low",
                "claim_type": "task-summary",
                "verification_method": "manifest-only",
                "source_diversity": 0,
                "cohort_agreement": "",
                "contradictions": [],
            }
        )
    return claims


def render_reducer_packet(manifest: dict[str, Any], source_text: str, claims: list[dict[str, Any]]) -> str:
    run_id = manifest["run_id"]
    lines = [
        f"# Reducer Packet: {run_id}",
        "",
        "## Task",
        "",
        str(manifest.get("task") or manifest.get("title") or run_id),
        "",
        "## Durable Facts",
        "",
    ]
    for claim in claims:
        marker = "[VERIFY]" if claim["confidence"] == "low" else ""
        lines.append(f"- {marker} {claim['claim']}".strip())
    lines.extend(["", "## Evidence", ""])
    for claim in claims:
        for url in claim.get("evidence", []):
            lines.append(f"- {url}")
    if not any(claim.get("evidence") for claim in claims):
        lines.append("- No citations detected; keep claims out of durable memory until verified.")
    lines.extend(
        [
            "",
            "## Contradictions",
            "",
            "- None detected by the reducer.",
            "",
            "## Skill Candidates",
            "",
            "- Promote only if this run reveals a repeated procedure with validation evidence.",
            "",
            "## Open Questions",
            "",
            "- Review low-confidence or uncited claims before promotion.",
            "",
            "## Raw Summary",
            "",
            " ".join(source_text.split())[:1200],
            "",
        ]
    )
    return "\n".join(lines)


def command_promote(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    root = run_root(workspace_root, args.run_id)
    manifest = ensure_manifest(workspace_root, args.run_id)
    packet_path = root / "reducer_packet.md"
    packet = read_text(packet_path, limit=50000)
    if not packet:
        raise SystemExit(f"Missing reducer packet for run: {args.run_id}")
    target = args.target
    actions: list[dict[str, Any]] = []
    if target in {"auto", "semantic"}:
        title = safe_slug(str(manifest.get("title") or args.run_id), fallback=args.run_id)
        wiki_path = workspace_root / "wiki" / "syntheses" / f"{title}.md"
        if args.apply:
            wiki_path.parent.mkdir(parents=True, exist_ok=True)
            wiki_path.write_text(packet, encoding="utf-8")
        actions.append({"target": "semantic", "path": workspace_rel(workspace_root, wiki_path), "applied": args.apply})
    if target in {"auto", "procedural"}:
        proposal_path = pipeline_root(workspace_root) / "proposals" / f"{args.run_id}-skill-candidate.md"
        if args.apply:
            proposal_path.parent.mkdir(parents=True, exist_ok=True)
            proposal_path.write_text(packet, encoding="utf-8")
        actions.append({"target": "procedural", "path": workspace_rel(workspace_root, proposal_path), "applied": args.apply})
    if target in {"auto", "preference"}:
        actions.append({"target": "preference", "path": ".brv via brv curate", "applied": False, "reason": "BRV promotion remains explicit"})
    decision = {
        "version": 1,
        "run_id": args.run_id,
        "created_at": utc_now(),
        "target": target,
        "applied": args.apply,
        "actions": actions,
        "policy": "verified durable facts to wiki; reusable procedures to skill proposals; preferences require explicit BRV curate",
    }
    write_json(root / "promotion_decision.json", decision)
    print_payload({"command": "llm-wiki-packet promote", "run_id": args.run_id, "decision": decision, "artifacts": {"promotion": workspace_rel(workspace_root, root / "promotion_decision.json")}}, args.json)
    return 0


def command_evaluate(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    root = run_root(workspace_root, args.run_id)
    manifest = ensure_manifest(workspace_root, args.run_id)
    claims_payload = load_json(root / "claims.json")
    claims = claims_payload.get("claims", []) if isinstance(claims_payload.get("claims"), list) else []
    criteria = manifest.get("success_criteria", []) if isinstance(manifest.get("success_criteria"), list) else []
    cited = sum(1 for claim in claims if claim.get("evidence"))
    low = sum(1 for claim in claims if claim.get("confidence") == "low")
    score = 0.4
    if claims:
        score += 0.25 * (cited / len(claims))
        score += 0.15 * max(0, 1 - low / len(claims))
    if criteria:
        score += 0.1
    if (root / "reducer_packet.md").exists():
        score += 0.1
    score = round(min(score, 1.0), 4)
    manifest_retrieval = manifest.get("retrieval") if isinstance(manifest.get("retrieval"), dict) else {}
    arg_retrieval = retrieval_metadata_from_args(args)
    retrieval = {
        "planes_used": arg_retrieval["planes_used"] or manifest_retrieval.get("planes_used", []),
        "plane_statuses": arg_retrieval["plane_statuses"] or manifest_retrieval.get("plane_statuses", {}),
        "default_context_sufficient": (
            arg_retrieval["default_context_sufficient"]
            if arg_retrieval["default_context_sufficient"] != "unknown"
            else manifest_retrieval.get("default_context_sufficient", "unknown")
        ),
        "degraded_or_error": arg_retrieval["degraded_or_error"] or manifest_retrieval.get("degraded_or_error", []),
    }
    evaluation = {
        "version": 1,
        "run_id": args.run_id,
        "created_at": utc_now(),
        "score": score,
        "task_success": "unknown" if not args.task_success else args.task_success,
        "citation_quality": "medium" if cited else "low",
        "retrieval_sufficiency": args.retrieval_sufficiency,
        "retrieval": retrieval,
        "contradiction_handling": "not-assessed",
        "regressions": [],
        "recommendation": "promote-with-review" if score >= args.threshold else "do-not-promote",
    }
    write_json(root / "evaluation.json", evaluation)
    print_payload({"command": "llm-wiki-packet evaluate", "run_id": args.run_id, "decision": evaluation, "artifacts": {"evaluation": workspace_rel(workspace_root, root / "evaluation.json")}}, args.json)
    return 0


def command_improve(args: argparse.Namespace) -> int:
    workspace_root = resolve_workspace_root(args.workspace_root)
    root = run_root(workspace_root, args.run_id)
    evaluation = load_json(root / "evaluation.json")
    if not evaluation:
        raise SystemExit(f"Missing evaluation for run: {args.run_id}")
    accepted = bool(args.benchmark_passed and args.no_regression and float(evaluation.get("score", 0.0)) >= args.min_score)
    proposal = {
        "version": 1,
        "run_id": args.run_id,
        "created_at": utc_now(),
        "status": "accepted" if accepted else "blocked",
        "benchmark_passed": args.benchmark_passed,
        "no_regression": args.no_regression,
        "min_score": args.min_score,
        "evaluation_score": evaluation.get("score", 0.0),
        "proposal": args.proposal or "Review reducer packet and failure signals before changing prompts, tools, or skills.",
        "gate": "promotion requires benchmark_passed=true, no_regression=true, and score >= min_score",
    }
    write_json(root / "improvement_proposal.json", proposal)
    print_payload({"command": "llm-wiki-packet improve", "run_id": args.run_id, "decision": proposal, "artifacts": {"improvement": workspace_rel(workspace_root, root / "improvement_proposal.json")}}, args.json)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="llm-wiki-packet",
        description="Packet-owned CLI surface for project init, context/evidence retrieval, run lifecycle artifacts, and benchmarks.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser(
        "init",
        help="Activate a target project with the llm_wiki_prompt_packet harness surfaces.",
    )
    init_parser.add_argument("--project-root", required=True, help="Target repo root to activate.")
    init_parser.add_argument("--packet-root", help="Optional llm_wiki_prompt_packet checkout path.")
    init_parser.add_argument("--targets", default=DEFAULT_TARGETS, help="Comma-separated target surfaces.")
    init_parser.add_argument("--home-root", default=str(Path.home()), help="Home root used for home skill installs.")
    init_parser.add_argument(
        "--qmd-source-checkout",
        help="Optional local pk-qmd checkout to prefer over the managed git fallback.",
    )
    init_parser.add_argument(
        "--install-scope",
        choices=("local", "global"),
        default="local",
        help="Managed tool install scope.",
    )
    init_parser.add_argument("--skip-home-skills", action="store_true", help="Skip home skill installs.")
    init_parser.add_argument(
        "--allow-global-tool-install",
        action="store_true",
        help="Allow setup helpers to fall back to global installs when needed.",
    )
    init_parser.add_argument("--enable-gitvizz", action="store_true", help="Do not skip GitVizz during setup/check.")
    init_parser.add_argument("--skip-setup", action="store_true", help="Install files but skip setup/check.")
    init_parser.add_argument("--preflight-only", action="store_true", help="Print the installer preflight and stop.")
    init_parser.add_argument("--force", action="store_true", help="Overwrite packet-managed files.")
    init_parser.set_defaults(func=command_init)

    for helper_name, helper_func in (("setup", command_setup), ("check", command_check)):
        helper_parser = subparsers.add_parser(helper_name, help=f"Run the workspace {helper_name} helper.")
        helper_parser.add_argument("--workspace-root", help="Workspace root. Defaults to the current repo.")
        helper_parser.add_argument(
            "--allow-global-tool-install",
            action="store_true",
            help="Allow runtime helpers to fall back to global installs when needed.",
        )
        helper_parser.add_argument(
            "--enable-gitvizz",
            action="store_true",
            help="Do not skip GitVizz during the helper run.",
        )
        helper_parser.set_defaults(func=helper_func)

    memory_parser = subparsers.add_parser("memory", help="Run the review-gated semantic/preference memory controller.")
    memory_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    memory_parser.add_argument("memory_args", nargs=argparse.REMAINDER)
    memory_parser.set_defaults(func=command_memory)

    context_parser = subparsers.add_parser(
        "context",
        help="Build a compact task-shaped context bundle with explicit expansion suggestions.",
    )
    context_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    context_parser.add_argument("--run-id", default="", help="Optional run id whose manifest should record retrieval metadata.")
    context_parser.add_argument("--task", default="", help="Task text to plan retrieval for.")
    context_parser.add_argument("--task-file", default="", help="Read task text from a file.")
    context_parser.add_argument(
        "--mode",
        choices=("default", "deep", "evidence", "graph", "skills", "preference"),
        default="default",
        help="Context mode. Default stays compact; deep and evidence expand retrieval.",
    )
    context_parser.add_argument("--token-budget", type=int, default=4000, help="Intended context budget for downstream injection.")
    context_parser.add_argument("--timeout-sec", type=int, default=20, help="Timeout per external retrieval plane.")
    context_parser.add_argument("--max-results-per-plane", type=int, default=5, help="Maximum results to request per retrieval plane.")
    context_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    context_parser.set_defaults(func=command_context)

    evidence_parser = subparsers.add_parser(
        "evidence",
        help="Run explicit broad local hybrid/source-backed evidence search.",
    )
    evidence_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    evidence_parser.add_argument("--run-id", default="", help="Optional run id whose manifest should record retrieval metadata.")
    evidence_parser.add_argument("--query", default="", help="Evidence query.")
    evidence_parser.add_argument("--query-file", default="", help="Read evidence query from a file.")
    evidence_parser.add_argument("--limit", type=int, default=10, help="Maximum result count.")
    evidence_parser.add_argument("--plane", choices=(*EVIDENCE_PLANES, "all"), default="all", help="Retrieval plane to run.")
    evidence_parser.add_argument("--deep", action="store_true", help="Include raw source folders in search.")
    evidence_parser.add_argument("--include-raw", action="store_true", help="Include raw source folders in search.")
    evidence_parser.add_argument("--timeout-sec", type=int, default=20, help="Timeout per external retrieval plane.")
    evidence_parser.add_argument("--max-results-per-plane", type=int, default=5, help="Maximum results to request per retrieval plane.")
    evidence_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    evidence_parser.set_defaults(func=command_evidence)

    route_parser = subparsers.add_parser(
        "route",
        help="Plan adaptive retrieval routing before running retrieval.",
    )
    route_parser.add_argument("--task", default="", help="Task text to route.")
    route_parser.add_argument("--task-file", default="", help="Read task text from a file.")
    route_parser.add_argument("--loaded-context", default="", help="Already-loaded context used for the context gate.")
    route_parser.add_argument("--loaded-context-file", default="", help="Read already-loaded context from a file.")
    route_parser.add_argument("--structural", action="store_true", help="Force structural/FULL routing.")
    route_parser.add_argument("--max-hops", type=int, default=3, help="Maximum retrieval hops, capped at 3.")
    route_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    route_parser.set_defaults(func=command_route)

    manifest_parser = subparsers.add_parser("manifest", help="Create a versioned run manifest.")
    manifest_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    manifest_parser.add_argument("--run-id", default="", help="Optional stable run id.")
    manifest_parser.add_argument("--title", default="", help="Run title.")
    manifest_parser.add_argument("--task", default="", help="Run task.")
    manifest_parser.add_argument("--success-criteria", action="append", default=[], help="Repeatable success criterion.")
    manifest_parser.add_argument("--prompt-version", default="", help="Prompt version id.")
    manifest_parser.add_argument("--tool-version", default="", help="Tool version id.")
    manifest_parser.add_argument("--model", default="", help="Model id.")
    manifest_parser.add_argument("--skill", action="append", default=[], help="Skill id used in the run.")
    manifest_parser.add_argument("--retrieval-plane", action="append", default=[], help="Repeatable retrieval plane used in the run.")
    manifest_parser.add_argument("--retrieval-status-json", default="", help="JSON object mapping retrieval planes to statuses.")
    manifest_parser.add_argument(
        "--default-context-sufficient",
        choices=("yes", "no", "unknown"),
        default="unknown",
        help="Whether default compact context was sufficient before expansion.",
    )
    manifest_parser.add_argument("--token-budget", type=int, default=0, help="Optional token budget.")
    manifest_parser.add_argument("--timeout-sec", type=int, default=0, help="Optional run timeout.")
    manifest_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    manifest_parser.set_defaults(func=command_manifest)

    reduce_parser = subparsers.add_parser("reduce", help="Reduce raw run output into a structured memory packet.")
    reduce_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    reduce_parser.add_argument("--run-id", default="", help="Run id. Created if omitted.")
    reduce_parser.add_argument("--task", default="", help="Task summary.")
    reduce_parser.add_argument("--text", default="", help="Raw text to reduce.")
    reduce_parser.add_argument("--source-file", default="", help="Read raw text from a file.")
    reduce_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    reduce_parser.set_defaults(func=command_reduce)

    promote_parser = subparsers.add_parser("promote", help="Route a reducer packet to the correct memory layer.")
    promote_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    promote_parser.add_argument("--run-id", required=True, help="Run id to promote.")
    promote_parser.add_argument("--target", choices=("auto", "semantic", "procedural", "preference"), default="auto")
    promote_parser.add_argument("--apply", action="store_true", help="Actually write promoted artifacts; default is decision only.")
    promote_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    promote_parser.set_defaults(func=command_promote)

    evaluate_parser = subparsers.add_parser("evaluate", help="Score a run for promotion and improvement gating.")
    evaluate_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    evaluate_parser.add_argument("--run-id", required=True, help="Run id to evaluate.")
    evaluate_parser.add_argument("--task-success", choices=("pass", "fail", "unknown"), default="")
    evaluate_parser.add_argument("--retrieval-sufficiency", choices=("sufficient", "insufficient", "unknown"), default="unknown")
    evaluate_parser.add_argument("--retrieval-plane", action="append", default=[], help="Repeatable retrieval plane used in the run.")
    evaluate_parser.add_argument("--retrieval-status-json", default="", help="JSON object mapping retrieval planes to statuses.")
    evaluate_parser.add_argument(
        "--default-context-sufficient",
        choices=("yes", "no", "unknown"),
        default="unknown",
        help="Whether default compact context was sufficient before expansion.",
    )
    evaluate_parser.add_argument("--threshold", type=float, default=0.7, help="Promotion recommendation threshold.")
    evaluate_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    evaluate_parser.set_defaults(func=command_evaluate)

    improve_parser = subparsers.add_parser("improve", help="Create a gated prompt/tool/skill improvement proposal.")
    improve_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    improve_parser.add_argument("--run-id", required=True, help="Run id to improve from.")
    improve_parser.add_argument("--proposal", default="", help="Optional improvement proposal text.")
    improve_parser.add_argument("--benchmark-passed", action="store_true", help="Required for accepted improvement.")
    improve_parser.add_argument("--no-regression", action="store_true", help="Required for accepted improvement.")
    improve_parser.add_argument("--min-score", type=float, default=0.7, help="Required evaluation score.")
    improve_parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    improve_parser.set_defaults(func=command_improve)

    benchmark_parser = subparsers.add_parser(
        "pokemon-benchmark",
        help="Run the packet-owned Pokemon benchmark surface from an activated workspace.",
    )
    benchmark_parser.add_argument("mode", nargs="?", choices=("smoke", "framework"))
    benchmark_parser.add_argument(
        "--mode",
        dest="mode_flag",
        choices=("smoke", "framework"),
        help="Benchmark run mode. Accepts the same values as the positional mode argument.",
    )
    benchmark_parser.add_argument("--workspace-root", help="Activated workspace root. Defaults to the current repo.")
    benchmark_parser.add_argument("--packet-root", help="Optional packet checkout path for source-repo fallback.")
    benchmark_parser.add_argument("--agent", choices=("claude", "codex", "droid", "pi"), default="codex")
    benchmark_parser.add_argument(
        "--gym-repo",
        default=r"C:\dev\Desktop-Benchmarks\Gym-Anything\gym-anything",
        help="Gym-Anything checkout path.",
    )
    benchmark_parser.add_argument(
        "--env-dir",
        default=r"C:\dev\Desktop-Benchmarks\Gym-Anything\gym-anything\benchmarks\cua_world\environments\pokemon_agent_env",
        help="Pokemon environment directory.",
    )
    benchmark_parser.add_argument(
        "--task-json",
        default=r"C:\dev\Desktop-Benchmarks\Gym-Anything\gym-anything\benchmarks\cua_world\environments\pokemon_agent_env\tasks\start_server_capture_state\task.json",
        help="Pokemon task contract JSON path.",
    )
    benchmark_parser.add_argument("--output-root", default="", help="Optional run artifact directory root.")
    benchmark_parser.add_argument("--seed", type=int, default=42, help="Deterministic benchmark seed.")
    benchmark_parser.add_argument("--timeout-sec", type=int, default=1800, help="Framework mode timeout.")
    benchmark_parser.add_argument("--keep-session", action="store_true", help="Keep the Gym session alive after the run.")
    benchmark_parser.set_defaults(func=command_pokemon_benchmark)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return main_from_args(args)


def main_from_args(args: argparse.Namespace) -> int:
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
