#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


KINDS = {"semantic", "preference"}
STATUSES = {"pending", "approved", "rejected", "invalidated"}
CONFIDENCE_VALUES = {"low": 0.35, "medium": 0.65, "high": 0.9}
CONFIDENCE_ORDER = {"low": 0, "medium": 1, "high": 2}
WORD_RE = re.compile(r"[A-Za-z0-9_/-]+")
STOPWORDS = {
    "about",
    "after",
    "again",
    "also",
    "always",
    "because",
    "before",
    "being",
    "default",
    "during",
    "every",
    "from",
    "have",
    "into",
    "memory",
    "must",
    "never",
    "only",
    "prefer",
    "should",
    "that",
    "their",
    "there",
    "this",
    "when",
    "with",
    "without",
    "workflow",
}
PREFERENCE_RE = re.compile(
    r"\b(i prefer|prefer\b|preference\b|my preferred|i like|i want|remember(?: that)? i|remember:|always\b|never\b|default to|by default)\b",
    re.IGNORECASE,
)
SEMANTIC_RE = re.compile(
    r"\b(decision|decided|source of truth|implemented|added|fixed|verified|current|is now|now use|use .* instead|contract|status|task outcome|durable fact)\b",
    re.IGNORECASE,
)
SUPERSESSION_RE = re.compile(r"\b(now|current|instead|replaces|supersedes|no longer|from now on)\b", re.IGNORECASE)
NEGATION_RE = re.compile(r"\b(no|not|never|avoid|stop|disable|without|no longer)\b", re.IGNORECASE)
SENSITIVE_RE = re.compile(r"\b(api[_ -]?key|token|password|secret|credential|private key|bearer\s+[A-Za-z0-9._-]+)\b", re.IGNORECASE)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(read_text(path))
    except json.JSONDecodeError:
        return {}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\n")


def load_config(workspace_root: Path) -> dict[str, Any]:
    return read_json(workspace_root / ".llm-wiki" / "config.json")


def controller_config(workspace_root: Path) -> dict[str, Any]:
    config = load_config(workspace_root)
    configured = config.get("memory_controller") if isinstance(config.get("memory_controller"), dict) else {}
    return {
        "ledger_path": configured.get("ledger_path", ".llm-wiki/memory-ledger"),
        "generated_wiki_path": configured.get("generated_wiki_path", "wiki/syntheses/memory-ledger-approved.md"),
        "review_gate": configured.get("review_gate", True),
        "min_confidence": configured.get("min_confidence", "low"),
        "ranking": configured.get(
            "ranking",
            {"lexical_weight": 0.7, "confidence_weight": 0.2, "recency_weight": 0.1},
        ),
    }


def ledger_root(workspace_root: Path) -> Path:
    configured = str(controller_config(workspace_root).get("ledger_path") or ".llm-wiki/memory-ledger")
    path = Path(configured)
    return path if path.is_absolute() else workspace_root / path


def ensure_ledger(workspace_root: Path) -> Path:
    root = ledger_root(workspace_root)
    for rel in ("", "candidates", "approved"):
        directory = root / rel if rel else root
        directory.mkdir(parents=True, exist_ok=True)
        (directory / ".gitkeep").touch()
    if not (root / "index.json").exists():
        write_json(root / "index.json", {"version": 1, "generated_at": utc_now(), "results": []})
    (root / "events.jsonl").touch()
    return root


def workspace_rel(workspace_root: Path, path: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(workspace_root.resolve(strict=False)).as_posix()
    except ValueError:
        return str(path.resolve(strict=False))


def words(text: str) -> list[str]:
    return [w.lower() for w in WORD_RE.findall(text) if len(w) > 2 and w.lower() not in STOPWORDS]


def canonical_keys(claim: str, kind: str) -> list[str]:
    seen: list[str] = []
    for word in words(claim):
        if word not in seen:
            seen.append(word)
    return [f"{kind}:{word}" for word in seen[:8]]


def normalized_claim(claim: str) -> str:
    return " ".join(words(claim))


def lexical_overlap(left: str, right: str) -> float:
    left_words = set(words(left))
    right_words = set(words(right))
    if not left_words or not right_words:
        return 0.0
    return len(left_words & right_words) / len(left_words | right_words)


def hash_id(kind: str, claim: str) -> str:
    digest = hashlib.sha256(f"{kind}:{' '.join(claim.lower().split())}".encode("utf-8")).hexdigest()[:10]
    slug = "-".join(words(claim)[:5]) or "memory"
    return f"mem-{kind}-{slug[:48]}-{digest}"


def clean_claim(text: str) -> str:
    cleaned = re.sub(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+", "", text.strip())
    cleaned = re.sub(r"^#+\s*", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -")
    return cleaned


def confidence_for_claim(claim: str, kind: str) -> str:
    if re.search(r"\b(remember|source of truth|decision|decided|verified)\b", claim, re.IGNORECASE):
        return "high"
    if kind == "preference" or re.search(r"\b(implemented|added|fixed|current|now)\b", claim, re.IGNORECASE):
        return "medium"
    return "low"


def sensitivity_for_claim(claim: str, kind: str) -> str:
    if SENSITIVE_RE.search(claim):
        return "credential"
    if kind == "preference" and re.search(r"\b(i|my|me)\b", claim, re.IGNORECASE):
        return "personal"
    return "normal"


def confidence_allowed(confidence: str, minimum: str) -> bool:
    return CONFIDENCE_ORDER.get(confidence, 0) >= CONFIDENCE_ORDER.get(minimum, 0)


def memory_path(root: Path, memory: dict[str, Any]) -> Path:
    status = str(memory.get("status") or "pending")
    bucket = "approved" if status in {"approved", "invalidated"} else "candidates"
    return root / bucket / f"{memory['id']}.json"


def iter_memories(workspace_root: Path, *, statuses: set[str] | None = None) -> list[dict[str, Any]]:
    root = ensure_ledger(workspace_root)
    items: list[dict[str, Any]] = []
    for bucket in ("candidates", "approved"):
        for path in sorted((root / bucket).glob("*.json")):
            memory = read_json(path)
            if not memory:
                continue
            memory["_path"] = str(path)
            if statuses and memory.get("status") not in statuses:
                continue
            items.append(memory)
    return items


def save_memory(workspace_root: Path, memory: dict[str, Any], *, old_path: str = "") -> Path:
    root = ensure_ledger(workspace_root)
    path = memory_path(root, memory)
    if old_path:
        old = Path(old_path)
        if old != path and old.exists():
            old.unlink()
    memory.pop("_path", None)
    write_json(path, memory)
    return path


def append_event(workspace_root: Path, action: str, memory: dict[str, Any] | None = None, **extra: Any) -> None:
    payload = {
        "created_at": utc_now(),
        "action": action,
        "memory_id": memory.get("id") if memory else "",
        "kind": memory.get("kind") if memory else "",
        "status": memory.get("status") if memory else "",
        **extra,
    }
    append_jsonl(ensure_ledger(workspace_root) / "events.jsonl", payload)


def source_text_from_args(workspace_root: Path, args: argparse.Namespace) -> tuple[str, list[dict[str, str]]]:
    refs: list[dict[str, str]] = []
    parts: list[str] = []
    if args.text:
        parts.append(args.text)
        refs.append({"type": "inline", "ref": "cli:text"})
    if args.source_file:
        path = Path(args.source_file)
        if not path.is_absolute():
            path = workspace_root / path
        parts.append(read_text(path))
        refs.append({"type": "file", "ref": workspace_rel(workspace_root, path)})
    if args.run_id:
        run_dir = workspace_root / ".llm-wiki" / "skill-pipeline" / "runs" / args.run_id
        for name in ("reducer_packet.md", "auto_reducer_draft.md", "manifest.json", "raw.txt", "claims.json"):
            path = run_dir / name
            if path.exists():
                parts.append(read_text(path))
                refs.append({"type": "run", "run_id": args.run_id, "ref": workspace_rel(workspace_root, path)})
    return "\n".join(parts), refs


def candidate_from_claim(claim: str, kind: str, task: str, source_refs: list[dict[str, str]]) -> dict[str, Any]:
    now = utc_now()
    return {
        "id": hash_id(kind, claim),
        "kind": kind,
        "claim": claim,
        "status": "pending",
        "confidence": confidence_for_claim(claim, kind),
        "source_refs": source_refs,
        "provenance": {"created_at": now, "updated_at": now, "task": task, "extractor": "rule-based-v1"},
        "canonical_keys": canonical_keys(claim, kind),
        "valid_from": now,
        "valid_to": "",
        "supersedes": [],
        "contradicts": [],
        "sensitivity": sensitivity_for_claim(claim, kind),
        "last_ranked_at": "",
        "rank_score": 0.0,
    }


def extract_candidates(text: str, *, task: str, source_refs: list[dict[str, str]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for raw in re.split(r"[\n\r]+|(?<=[.!?])\s+", text):
        claim = clean_claim(raw)
        if len(claim) < 12 or claim.lower() in seen:
            continue
        kind = ""
        if PREFERENCE_RE.search(claim):
            kind = "preference"
        elif SEMANTIC_RE.search(claim):
            kind = "semantic"
        if not kind:
            continue
        seen.add(claim.lower())
        candidates.append(candidate_from_claim(claim, kind, task, source_refs))
    return candidates


def confidence_max(left: str, right: str) -> str:
    return left if CONFIDENCE_VALUES.get(left, 0) >= CONFIDENCE_VALUES.get(right, 0) else right


def reconcile_candidate(workspace_root: Path, candidate: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    approved = iter_memories(workspace_root, statuses={"approved"})
    candidate_keys = set(candidate.get("canonical_keys") or [])
    best: dict[str, Any] | None = None
    best_overlap = 0.0
    for existing in approved:
        if existing.get("kind") != candidate.get("kind"):
            continue
        key_overlap = bool(candidate_keys & set(existing.get("canonical_keys") or []))
        overlap = lexical_overlap(str(candidate.get("claim") or ""), str(existing.get("claim") or ""))
        if overlap > best_overlap or (key_overlap and best is None):
            best = existing
            best_overlap = overlap

    if best and (best_overlap >= 0.82 or normalized_claim(best.get("claim", "")) == normalized_claim(candidate.get("claim", ""))):
        if NEGATION_RE.search(str(candidate.get("claim") or "")) != NEGATION_RE.search(str(best.get("claim") or "")):
            candidate["contradicts"] = [best["id"]]
            return "staged", candidate
        old_path = str(best.get("_path") or "")
        best["confidence"] = confidence_max(str(best.get("confidence") or "low"), str(candidate.get("confidence") or "low"))
        best["source_refs"] = [*best.get("source_refs", []), *candidate.get("source_refs", [])]
        provenance = best.get("provenance") if isinstance(best.get("provenance"), dict) else {}
        provenance["updated_at"] = utc_now()
        provenance.setdefault("merged_candidates", []).append(candidate["id"])
        best["provenance"] = provenance
        save_memory(workspace_root, best, old_path=old_path)
        append_event(workspace_root, "reconcile-duplicate", best, merged_candidate=candidate["id"])
        return "merged", best

    if best and candidate_keys & set(best.get("canonical_keys") or []):
        if SUPERSESSION_RE.search(str(candidate.get("claim") or "")):
            candidate["supersedes"] = [best["id"]]
        if NEGATION_RE.search(str(candidate.get("claim") or "")) != NEGATION_RE.search(str(best.get("claim") or "")):
            candidate["contradicts"] = [best["id"]]
    return "staged", candidate


def project_semantic_memories(workspace_root: Path) -> Path:
    config = controller_config(workspace_root)
    out_path = Path(str(config.get("generated_wiki_path") or "wiki/syntheses/memory-ledger-approved.md"))
    if not out_path.is_absolute():
        out_path = workspace_root / out_path
    memories = [
        item
        for item in iter_memories(workspace_root, statuses={"approved"})
        if item.get("kind") == "semantic" and not item.get("valid_to")
    ]
    memories.sort(key=lambda item: str(item.get("valid_from") or ""))
    lines = [
        "# Approved Memory Ledger Synthesis",
        "",
        "> Generated from `.llm-wiki/memory-ledger/approved/`. Do not hand-edit durable memory facts here; edit the ledger object instead.",
        "",
    ]
    if not memories:
        lines.append("_No approved semantic memories yet._")
    for item in memories:
        refs = ", ".join(ref.get("ref", "") for ref in item.get("source_refs", []) if isinstance(ref, dict))
        lines.extend(
            [
                f"## {item['id']}",
                "",
                f"- kind: `{item.get('kind')}`",
                f"- confidence: `{item.get('confidence')}`",
                f"- valid_from: `{item.get('valid_from')}`",
                f"- source_refs: {refs or '_none_'}",
                f"- claim: {item.get('claim')}",
                "",
            ]
        )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return out_path


def refresh_semantic_projection_if_needed(workspace_root: Path, *memories: dict[str, Any]) -> str:
    if not any(memory.get("kind") == "semantic" for memory in memories if memory):
        return ""
    return workspace_rel(workspace_root, project_semantic_memories(workspace_root))


def find_memory(workspace_root: Path, memory_id: str) -> dict[str, Any]:
    for item in iter_memories(workspace_root):
        if item.get("id") == memory_id:
            return item
    raise SystemExit(f"Memory not found: {memory_id}")


def expire_superseded_memories(workspace_root: Path, memory: dict[str, Any], *, timestamp: str) -> list[str]:
    expired: list[str] = []
    for superseded_id in memory.get("supersedes", []) or []:
        try:
            superseded = find_memory(workspace_root, str(superseded_id))
        except SystemExit:
            continue
        if superseded.get("status") != "approved" or superseded.get("valid_to"):
            continue
        old_path = str(superseded.get("_path") or "")
        superseded["valid_to"] = timestamp
        superseded["superseded_by"] = memory["id"]
        provenance = superseded.get("provenance") if isinstance(superseded.get("provenance"), dict) else {}
        provenance["updated_at"] = timestamp
        provenance["superseded_at"] = timestamp
        provenance["superseded_by"] = memory["id"]
        superseded["provenance"] = provenance
        save_memory(workspace_root, superseded, old_path=old_path)
        append_event(workspace_root, "supersede", superseded, superseded_by=memory["id"])
        expired.append(str(superseded_id))
    return expired


def unresolved_active_contradictions(workspace_root: Path, memory: dict[str, Any]) -> list[str]:
    active: list[str] = []
    for contradicted_id in memory.get("contradicts", []) or []:
        try:
            contradicted = find_memory(workspace_root, str(contradicted_id))
        except SystemExit:
            continue
        if contradicted.get("status") == "approved" and not contradicted.get("valid_to") and not contradicted.get("superseded_by"):
            active.append(str(contradicted_id))
    return active


def rank_memories(workspace_root: Path, query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    config = controller_config(workspace_root)
    weights = config.get("ranking") if isinstance(config.get("ranking"), dict) else {}
    lexical_weight = float(weights.get("lexical_weight", 0.7))
    confidence_weight = float(weights.get("confidence_weight", 0.2))
    recency_weight = float(weights.get("recency_weight", 0.1))
    now = utc_now()
    ranked: list[dict[str, Any]] = []
    for item in iter_memories(workspace_root, statuses={"approved"}):
        if item.get("valid_to") or item.get("superseded_by"):
            continue
        if unresolved_active_contradictions(workspace_root, item):
            continue
        lexical = lexical_overlap(query, str(item.get("claim") or ""))
        if lexical <= 0:
            continue
        confidence = CONFIDENCE_VALUES.get(str(item.get("confidence") or "low"), 0.35)
        age_bonus = 0.0
        valid_from = str(item.get("valid_from") or "")
        if valid_from:
            age_bonus = 1.0 / (1.0 + math.log10(1 + max(0, (datetime.now(timezone.utc) - parse_time(valid_from)).days)))
        score = lexical_weight * lexical + confidence_weight * confidence + recency_weight * age_bonus
        item["last_ranked_at"] = now
        item["rank_score"] = round(score, 4)
        save_memory(workspace_root, item, old_path=str(item.get("_path") or ""))
        ranked.append(item)
    ranked.sort(key=lambda item: float(item.get("rank_score") or 0), reverse=True)
    results = ranked[:limit]
    write_json(ensure_ledger(workspace_root) / "index.json", {"version": 1, "generated_at": now, "query": query, "results": results})
    append_event(workspace_root, "rank", None, query=query, result_count=len(results))
    return results


def parse_time(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


def cmd_extract(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    text, refs = source_text_from_args(workspace_root, args)
    if not text.strip():
        raise SystemExit("No extraction input was provided.")
    extracted = extract_candidates(text, task=args.task, source_refs=refs)
    config = controller_config(workspace_root)
    review_gate = bool(config.get("review_gate", True))
    min_confidence = str(config.get("min_confidence") or "low")
    staged: list[dict[str, Any]] = []
    merged: list[dict[str, Any]] = []
    approved: list[dict[str, Any]] = []
    filtered: list[dict[str, Any]] = []
    for candidate in extracted:
        if not confidence_allowed(str(candidate.get("confidence") or "low"), min_confidence):
            append_event(workspace_root, "extract-filtered", candidate, task=args.task, min_confidence=min_confidence)
            filtered.append(candidate)
            continue
        if candidate.get("sensitivity") == "credential":
            provenance = candidate.get("provenance") if isinstance(candidate.get("provenance"), dict) else {}
            provenance["review_warning"] = "credential-like memory requires explicit review"
            candidate["provenance"] = provenance
        action, memory = reconcile_candidate(workspace_root, candidate)
        if action == "merged":
            merged.append(memory)
            continue
        if not review_gate and memory.get("sensitivity") != "credential" and not memory.get("contradicts"):
            approved_at = utc_now()
            memory["status"] = "approved"
            provenance = memory.get("provenance") if isinstance(memory.get("provenance"), dict) else {}
            provenance["updated_at"] = approved_at
            provenance["approved_at"] = approved_at
            provenance["approval_mode"] = "auto"
            memory["provenance"] = provenance
            save_memory(workspace_root, memory)
            expire_superseded_memories(workspace_root, memory, timestamp=approved_at)
            append_event(workspace_root, "extract-auto-approve", memory, task=args.task)
            approved.append(memory)
            continue
        save_memory(workspace_root, memory)
        append_event(workspace_root, "extract", memory, task=args.task)
        staged.append(memory)
    projection = refresh_semantic_projection_if_needed(workspace_root, *approved)
    return {
        "command": "memory-controller extract",
        "staged": staged,
        "merged": merged,
        "approved": approved,
        "filtered": filtered,
        "count": len(staged),
        "projection": projection,
    }


def cmd_list(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    statuses = {args.status} if args.status else None
    items = iter_memories(workspace_root, statuses=statuses)
    items.sort(key=lambda item: str(item.get("valid_from") or ""), reverse=True)
    return {"command": "memory-controller list", "memories": items}


def cmd_show(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    return {"command": "memory-controller show", "memory": find_memory(workspace_root, args.memory_id)}


def cmd_approve(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    memory = find_memory(workspace_root, args.memory_id)
    if memory.get("sensitivity") == "credential" and not args.force_sensitive:
        raise SystemExit("Credential-like memories require explicit --force-sensitive approval.")
    active_contradictions = unresolved_active_contradictions(workspace_root, memory)
    if active_contradictions and not args.force_contradiction:
        raise SystemExit(
            "Memory has unresolved active contradictions. "
            f"Resolve/invalidate {', '.join(active_contradictions)} or pass --force-contradiction."
        )
    old_path = str(memory.get("_path") or "")
    approved_at = utc_now()
    memory["status"] = "approved"
    memory.setdefault("valid_from", approved_at)
    provenance = memory.get("provenance") if isinstance(memory.get("provenance"), dict) else {}
    provenance["updated_at"] = approved_at
    provenance["approved_at"] = approved_at
    memory["provenance"] = provenance
    save_memory(workspace_root, memory, old_path=old_path)
    expired_superseded = expire_superseded_memories(workspace_root, memory, timestamp=approved_at)
    append_event(workspace_root, "approve", memory, applied=bool(args.apply))
    expired_memories = []
    for expired_id in expired_superseded:
        try:
            expired_memories.append(find_memory(workspace_root, expired_id))
        except SystemExit:
            pass
    projection = refresh_semantic_projection_if_needed(workspace_root, memory, *expired_memories)
    return {"command": "memory-controller approve", "memory": memory, "projection": projection, "expired_superseded": expired_superseded}


def cmd_reject(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    memory = find_memory(workspace_root, args.memory_id)
    old_path = str(memory.get("_path") or "")
    memory["status"] = "rejected"
    provenance = memory.get("provenance") if isinstance(memory.get("provenance"), dict) else {}
    provenance["updated_at"] = utc_now()
    memory["provenance"] = provenance
    save_memory(workspace_root, memory, old_path=old_path)
    append_event(workspace_root, "reject", memory)
    return {"command": "memory-controller reject", "memory": memory}


def cmd_edit(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    if args.kind not in KINDS:
        raise SystemExit(f"Unsupported kind: {args.kind}")
    memory = find_memory(workspace_root, args.memory_id)
    old_path = str(memory.get("_path") or "")
    memory["claim"] = args.claim
    memory["kind"] = args.kind
    memory["canonical_keys"] = canonical_keys(args.claim, args.kind)
    memory["confidence"] = args.confidence or memory.get("confidence") or confidence_for_claim(args.claim, args.kind)
    memory["sensitivity"] = sensitivity_for_claim(args.claim, args.kind)
    provenance = memory.get("provenance") if isinstance(memory.get("provenance"), dict) else {}
    provenance["updated_at"] = utc_now()
    provenance.setdefault("edits", []).append({"created_at": utc_now(), "claim": args.claim, "kind": args.kind})
    memory["provenance"] = provenance
    save_memory(workspace_root, memory, old_path=old_path)
    append_event(workspace_root, "edit", memory)
    projection = refresh_semantic_projection_if_needed(workspace_root, memory)
    return {"command": "memory-controller edit", "memory": memory, "projection": projection}


def cmd_invalidate(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    memory = find_memory(workspace_root, args.memory_id)
    old_path = str(memory.get("_path") or "")
    memory["status"] = "invalidated"
    memory["valid_to"] = utc_now()
    provenance = memory.get("provenance") if isinstance(memory.get("provenance"), dict) else {}
    provenance["updated_at"] = utc_now()
    provenance["invalidated_at"] = utc_now()
    provenance["invalidation_reason"] = args.reason
    memory["provenance"] = provenance
    save_memory(workspace_root, memory, old_path=old_path)
    append_event(workspace_root, "invalidate", memory, reason=args.reason)
    projection = refresh_semantic_projection_if_needed(workspace_root, memory)
    return {"command": "memory-controller invalidate", "memory": memory, "projection": projection}


def cmd_rank(workspace_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    return {"command": "memory-controller rank", "query": args.query, "results": rank_memories(workspace_root, args.query, limit=args.limit)}


def render_markdown(payload: dict[str, Any]) -> str:
    command = payload.get("command", "memory-controller")
    lines = [f"# {command}", ""]
    for key in ("count", "query", "projection"):
        if payload.get(key) not in (None, ""):
            lines.append(f"- {key}: {payload[key]}")
    collections = []
    for key in ("staged", "approved", "merged", "filtered", "memories", "results"):
        if isinstance(payload.get(key), list):
            collections.extend(payload[key])
    if isinstance(payload.get("memory"), dict):
        collections.append(payload["memory"])
    if collections:
        lines.extend(["", "## Memories"])
        for item in collections:
            lines.append(f"- `{item.get('id')}` [{item.get('status')}/{item.get('kind')}] {item.get('claim')} ({item.get('confidence')}, score={item.get('rank_score', 0)})")
    return "\n".join(lines) + "\n"


def print_payload(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(render_markdown(payload))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Review-gated semantic/preference memory controller.")
    parser.add_argument("--workspace-root", default=".", help="Workspace root containing .llm-wiki.")
    parser.add_argument("--json", action="store_true", help="Emit JSON.")
    sub = parser.add_subparsers(dest="command", required=True)

    extract = sub.add_parser("extract", help="Extract pending memory candidates from usage text.")
    source = extract.add_mutually_exclusive_group(required=True)
    source.add_argument("--run-id", default="")
    source.add_argument("--source-file", default="")
    source.add_argument("--text", default="")
    extract.add_argument("--task", required=True)
    extract.set_defaults(func=cmd_extract)

    list_parser = sub.add_parser("list", help="List memory objects.")
    list_parser.add_argument("--status", choices=sorted(STATUSES), default="")
    list_parser.set_defaults(func=cmd_list)

    show = sub.add_parser("show", help="Show one memory object.")
    show.add_argument("memory_id")
    show.set_defaults(func=cmd_show)

    approve = sub.add_parser("approve", help="Approve a pending memory object.")
    approve.add_argument("memory_id")
    approve.add_argument("--apply", action="store_true", help="Apply semantic projection after approval.")
    approve.add_argument("--force-contradiction", action="store_true", help="Approve even when active contradictions remain.")
    approve.add_argument("--force-sensitive", action="store_true", help="Approve credential-like sensitive memories.")
    approve.set_defaults(func=cmd_approve)

    reject = sub.add_parser("reject", help="Reject a pending memory object.")
    reject.add_argument("memory_id")
    reject.set_defaults(func=cmd_reject)

    edit = sub.add_parser("edit", help="Edit memory claim and kind.")
    edit.add_argument("memory_id")
    edit.add_argument("--claim", required=True)
    edit.add_argument("--kind", choices=sorted(KINDS), required=True)
    edit.add_argument("--confidence", choices=sorted(CONFIDENCE_VALUES), default="")
    edit.set_defaults(func=cmd_edit)

    invalidate = sub.add_parser("invalidate", help="Invalidate an approved memory object.")
    invalidate.add_argument("memory_id")
    invalidate.add_argument("--reason", required=True)
    invalidate.set_defaults(func=cmd_invalidate)

    rank = sub.add_parser("rank", help="Rank approved memory objects for a query.")
    rank.add_argument("--query", required=True)
    rank.add_argument("--limit", type=int, default=10)
    rank.set_defaults(func=cmd_rank)
    return parser


def main_from_args(args: argparse.Namespace) -> int:
    workspace_root = Path(args.workspace_root).expanduser().resolve()
    ensure_ledger(workspace_root)
    payload = args.func(workspace_root, args)
    print_payload(payload, args.json)
    return 0


def main(argv: list[str] | None = None) -> int:
    return main_from_args(build_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
