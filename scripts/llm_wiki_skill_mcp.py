#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SERVER_NAME = "llm-wiki-skills"
SERVER_VERSION = "0.3.0"
DEFAULT_KINDS = {"ui", "http", "workflow", "prompt"}
CONFIDENCE_ORDER = {"low": 1, "medium": 2, "high": 3}
MEMORY_SCOPES = {"working", "episodic", "semantic", "procedural", "hybrid"}
MEMORY_STRATEGIES = {"flat", "hierarchical", "knowledge_object"}
UPDATE_STRATEGIES = {"append_only", "merge_append", "replace_on_validation", "deprecate_on_conflict"}
ROUTE_DECISIONS = {
    "complete",
    "retry_same_worker",
    "reroute_to_sibling",
    "escalate_to_parent",
    "stop_insufficient_evidence",
}
EVOLUTION_ACTIONS = {"create_skill", "edit_skill", "discard"}
SURROGATE_VERDICTS = {"pass", "revise", "fail"}
FRONTIER_ACCEPTED_ORACLE_VERDICTS = {"pass", "accepted", "improved", "win", "better"}
VERIFICATION_MODES = {"heuristic", "objective", "subjective_pairwise"}
PAIRWISE_OPTION_CHOICES = {"a", "b"}
DEFAULT_SUBJECTIVE_RUBRIC = [
    "Honor the user's explicit constraints, required format, and completion criteria.",
    "Any core-fact or safety-critical error loses immediately, even if the rest is stronger.",
    "Prefer the response with clearer structure, stronger logical sequence, and easier scanability.",
    "Prefer more supporting detail only when it adds informational value without redundancy.",
    "Prefer the response that better matches the user's likely implicit intent, not just the literal wording.",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_day() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def slugify(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.strip().lower())
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value or f"skill-{uuid.uuid4().hex[:8]}"


def ensure_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (list, tuple, set)):
        return "\n".join(str(item).strip() for item in value if str(item).strip())
    return str(value).strip()


def ensure_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        if stripped.startswith("[") and stripped.endswith("]"):
            try:
                decoded = json.loads(stripped)
                if isinstance(decoded, list):
                    return [str(item).strip() for item in decoded if str(item).strip()]
            except json.JSONDecodeError:
                pass
        if "\n" in stripped:
            return [line.strip() for line in stripped.splitlines() if line.strip()]
        return [stripped]
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value).strip()]


def ensure_int(value: Any, default: int = 0) -> int:
    if value in (None, ""):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def unique_list(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        stripped = item.strip()
        if not stripped:
            continue
        key = stripped.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(stripped)
    return result


def tokenize(*parts: str) -> set[str]:
    text = " ".join(part for part in parts if part)
    return {token.lower() for token in re.findall(r"[A-Za-z0-9]{3,}", text)}


def jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def safe_stem(value: str) -> str:
    base = slugify(value) or uuid.uuid4().hex[:8]
    return base[:80]


def normalize_ab_choice(value: Any) -> str:
    text = ensure_text(value).lower()
    aliases = {
        "a": "a",
        "option a": "a",
        "option_a": "a",
        "response a": "a",
        "response_a": "a",
        "first": "a",
        "1": "a",
        "b": "b",
        "option b": "b",
        "option_b": "b",
        "response b": "b",
        "response_b": "b",
        "second": "b",
        "2": "b",
    }
    return aliases.get(text, "")


def deterministic_coin_flip(*parts: Any) -> bool:
    seed = "||".join(ensure_text(part) for part in parts if ensure_text(part))
    if not seed:
        return True
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    return int(digest[:2], 16) % 2 == 0


def infer_memory_scope(kind: str, source_type: str, long_task: bool) -> str:
    kind_key = ensure_text(kind).lower()
    source_key = ensure_text(source_type).lower()
    if kind_key == "prompt":
        return "semantic"
    if kind_key in {"ui", "http"}:
        return "procedural"
    if long_task and source_key == "trajectory":
        return "hybrid"
    if kind_key == "workflow":
        return "episodic" if source_key == "trajectory" else "procedural"
    return "episodic" if long_task else "procedural"


def derive_durable_facts(
    trigger: str,
    outcome: str,
    observations: list[str],
    risks: list[str],
    limit: int = 6,
) -> list[str]:
    facts = unique_list(
        ([f"Trigger: {trigger}"] if ensure_text(trigger) else [])
        + ([f"Outcome: {outcome}"] if ensure_text(outcome) else [])
        + observations[:3]
        + [f"Risk: {item}" for item in risks[:2]]
    )
    return facts[: max(1, limit)]


def derive_retrieval_hints(title: str, kind: str, applies_to: list[str], trigger: str, limit: int = 8) -> list[str]:
    hints = unique_list(
        [f"kind:{ensure_text(kind).lower()}"]
        + [f"applies:{item}" for item in applies_to[:3]]
        + [f"term:{token.lower()}" for token in re.findall(r"[A-Za-z0-9]{4,}", f"{title} {trigger}")[:4]]
    )
    return hints[: max(1, limit)]


def derive_canonical_keys(title: str, kind: str, applies_to: list[str], trigger: str, limit: int = 6) -> list[str]:
    base = slugify(title)
    keys = [f"skill:{base}", f"kind:{ensure_text(kind).lower()}"]
    keys.extend(f"applies:{item}" for item in applies_to[:2])
    trigger_tokens = [token.lower() for token in re.findall(r"[A-Za-z0-9]{5,}", trigger)[:2]]
    keys.extend(f"trigger:{token}" for token in trigger_tokens)
    return unique_list(keys)[: max(1, limit)]


def file_stamp(timestamp: str) -> str:
    return timestamp.replace(":", "").replace("-", "").replace("T", "-").replace("Z", "")


def yaml_quote(value: str) -> str:
    return json.dumps(ensure_text(value))


def merge_text(existing: str, incoming: str) -> str:
    existing_text = ensure_text(existing)
    incoming_text = ensure_text(incoming)
    if not existing_text:
        return incoming_text
    if not incoming_text:
        return existing_text
    if incoming_text.lower() in existing_text.lower():
        return existing_text

    merged = [line.rstrip() for line in existing_text.splitlines() if line.strip()]
    if not merged:
        merged = [existing_text]
    seen = {line.strip().lower() for line in merged if line.strip()}
    for line in [line.rstrip() for line in incoming_text.splitlines() if line.strip()]:
        key = line.strip().lower()
        if key not in seen:
            merged.append(line)
            seen.add(key)
    return "\n".join(merged)


def detect_pii(*parts: str) -> list[str]:
    text = "\n".join(part for part in parts if part)
    checks = {
        "email": r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        "api_key": r"\b(?:sk|rk|pk)_[A-Za-z0-9_-]{12,}\b",
        "bearer_token": r"Bearer\s+[A-Za-z0-9._-]{12,}",
        "cookie_like": r"\b(?:session|token|cookie|secret|password)[=:][^\s]{6,}",
        "long_hex": r"\b[a-f0-9]{32,}\b",
        "phone_like": r"\+?\d[\d\s().-]{8,}\d",
    }
    hits: list[str] = []
    for label, pattern in checks.items():
        if re.search(pattern, text, re.IGNORECASE):
            hits.append(label)
    return hits


class SkillStore:
    def __init__(self, workspace: str | Path) -> None:
        self.workspace = Path(workspace).resolve()
        config = self._load_config()
        skill_cfg = config.get("skills", {})
        pipeline_cfg = skill_cfg.get("pipeline", {})

        self.registry_path = self.workspace / skill_cfg.get("registry_path", ".llm-wiki/skills-registry.json")
        self.index_path = self.workspace / skill_cfg.get("index_path", "wiki/skills/index.md")
        self.log_path = self.workspace / skill_cfg.get("log_path", "wiki/log.md")
        self.active_dir = self.workspace / skill_cfg.get("active_dir", "wiki/skills/active")
        self.feedback_dir = self.workspace / skill_cfg.get("feedback_dir", "wiki/skills/feedback")
        self.retired_dir = self.workspace / skill_cfg.get("retired_dir", "wiki/skills/retired")
        self.retire_below_score = int(skill_cfg.get("retire_below_score", -3))

        self.pipeline_dir = self.workspace / pipeline_cfg.get("pipeline_dir", ".llm-wiki/skill-pipeline")
        self.brief_dir = self.workspace / pipeline_cfg.get("brief_dir", ".llm-wiki/skill-pipeline/briefs")
        self.delta_dir = self.workspace / pipeline_cfg.get("delta_dir", ".llm-wiki/skill-pipeline/deltas")
        self.validation_dir = self.workspace / pipeline_cfg.get("validation_dir", ".llm-wiki/skill-pipeline/validations")
        self.packet_dir = self.workspace / pipeline_cfg.get("packet_dir", ".llm-wiki/skill-pipeline/packets")
        self.proposal_dir = self.workspace / pipeline_cfg.get("proposal_dir", ".llm-wiki/skill-pipeline/proposals")
        self.surrogate_review_dir = self.workspace / pipeline_cfg.get("surrogate_review_dir", ".llm-wiki/skill-pipeline/surrogate-reviews")
        self.evolution_run_dir = self.workspace / pipeline_cfg.get("evolution_run_dir", ".llm-wiki/skill-pipeline/evolution-runs")
        self.frontier_path = self.workspace / pipeline_cfg.get("frontier_path", ".llm-wiki/skill-pipeline/frontier.json")
        self.min_validation_score = int(pipeline_cfg.get("min_validation_score", 7))
        self.dedupe_similarity_threshold = float(pipeline_cfg.get("dedupe_similarity_threshold", 0.72))
        self.auto_merge_duplicates = bool(pipeline_cfg.get("auto_merge_duplicates", True))
        self.long_task_brief_min_chars = int(pipeline_cfg.get("long_task_brief_min_chars", 280))
        self.max_hops_default = int(pipeline_cfg.get("max_hops_default", 2))
        self.max_retries_default = int(pipeline_cfg.get("max_retries_default", 1))
        self.enforce_summary_only = bool(pipeline_cfg.get("enforce_summary_only", True))
        self.frontier_size = int(pipeline_cfg.get("frontier_size", 3))
        self.min_frontier_delta = int(pipeline_cfg.get("min_frontier_delta", 1))
        self.surrogate_fail_blocks = bool(pipeline_cfg.get("surrogate_fail_blocks", True))

        for path in [
            self.registry_path.parent,
            self.index_path.parent,
            self.log_path.parent,
            self.active_dir,
            self.feedback_dir,
            self.retired_dir,
            self.pipeline_dir,
            self.brief_dir,
            self.delta_dir,
            self.validation_dir,
            self.packet_dir,
            self.proposal_dir,
            self.surrogate_review_dir,
            self.evolution_run_dir,
            self.frontier_path.parent,
        ]:
            path.mkdir(parents=True, exist_ok=True)

        self.data = self._load_registry()
        self._write_frontier_snapshot()

    def _load_config(self) -> dict[str, Any]:
        config_path = self.workspace / ".llm-wiki" / "config.json"
        if config_path.exists():
            return json.loads(config_path.read_text(encoding="utf-8"))
        return {}

    def _load_registry(self) -> dict[str, Any]:
        if self.registry_path.exists():
            loaded = json.loads(self.registry_path.read_text(encoding="utf-8"))
        else:
            loaded = {}
        loaded.setdefault("skills", {})
        loaded.setdefault("feedback", [])
        loaded.setdefault("briefs", [])
        loaded.setdefault("deltas", [])
        loaded.setdefault("validations", [])
        loaded.setdefault("packets", [])
        loaded.setdefault("proposals", [])
        loaded.setdefault("surrogate_reviews", [])
        loaded.setdefault("evolution_runs", [])
        loaded.setdefault("frontier", [])
        loaded.setdefault("events", [])
        loaded["skills"] = {
            skill_id: self._normalize_loaded_skill(skill_id, skill)
            for skill_id, skill in loaded["skills"].items()
            if isinstance(skill, dict)
        }
        return loaded

    def _normalize_loaded_skill(self, skill_id: str, skill: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(skill)
        normalized.setdefault("id", skill_id)
        normalized.setdefault("title", normalized["id"])
        normalized.setdefault("status", "active")
        normalized.setdefault("kind", "workflow")
        normalized.setdefault("memory_scope", "")
        normalized.setdefault("memory_strategy", "")
        normalized.setdefault("update_strategy", "")
        normalized.setdefault("problem", "")
        normalized.setdefault("trigger", "")
        normalized.setdefault("preconditions", "")
        normalized.setdefault("fast_path", "")
        normalized.setdefault("failure_modes", "")
        normalized.setdefault("evidence", "")
        normalized.setdefault("validation_status", "")
        normalized.setdefault("validation_score", 0)
        normalized.setdefault("score", ensure_int(normalized.get("feedback_score"), 0))
        normalized.setdefault("applies_to", [])
        normalized["applies_to"] = ensure_list(normalized.get("applies_to"))
        normalized.setdefault("canonical_keys", [])
        normalized["canonical_keys"] = ensure_list(normalized.get("canonical_keys"))
        normalized.setdefault("created_at", "")
        normalized.setdefault("updated_at", normalized.get("created_at") or "")
        return normalized

    def _save(self) -> None:
        self.registry_path.write_text(json.dumps(self.data, indent=2) + "\n", encoding="utf-8")
        self._write_frontier_snapshot()

    def _relative(self, path: Path) -> str:
        return path.relative_to(self.workspace).as_posix()

    def _append_log(self, entry_type: str, subject: str, lines: list[str]) -> None:
        if not self.log_path.exists():
            self.log_path.write_text("# Wiki Log\n\n", encoding="utf-8")
        entry_lines = [f"## {utc_now()} - {entry_type}: {subject}", ""]
        entry_lines.extend(f"- {line}" for line in lines if line)
        entry_lines.append("")
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write("\n".join(entry_lines))

    def _record_registry_event(self, kind: str, payload: dict[str, Any]) -> None:
        self.data["events"].append({"id": f"event-{uuid.uuid4().hex[:10]}", "kind": kind, "created_at": utc_now(), "payload": payload})

    def get_skill(self, skill_id: str) -> dict[str, Any] | None:
        return self.data["skills"].get(skill_id)

    def list_feedback(self, skill_id: str) -> list[dict[str, Any]]:
        return [row for row in self.data["feedback"] if row["skill_id"] == skill_id]

    def list_briefs(self, skill_id: str) -> list[dict[str, Any]]:
        return [row for row in self.data["briefs"] if row.get("skill_id") == skill_id or skill_id in row.get("related_skill_ids", [])]

    def list_packets(self, skill_id: str) -> list[dict[str, Any]]:
        return [row for row in self.data["packets"] if row.get("skill_id") == skill_id or skill_id in row.get("related_skill_ids", [])]

    def list_proposals(self, skill_id: str) -> list[dict[str, Any]]:
        return [
            row
            for row in self.data["proposals"]
            if row.get("skill_id") == skill_id
            or row.get("candidate_skill_id") == skill_id
            or skill_id in row.get("related_skill_ids", [])
        ]

    def list_surrogate_reviews(self, skill_id: str) -> list[dict[str, Any]]:
        return [
            row
            for row in self.data["surrogate_reviews"]
            if row.get("skill_id") == skill_id or skill_id in row.get("related_skill_ids", [])
        ]

    def list_evolution_runs(self, skill_id: str) -> list[dict[str, Any]]:
        return [
            row
            for row in self.data["evolution_runs"]
            if row.get("skill_id") == skill_id
            or row.get("target_skill_id") == skill_id
            or skill_id in row.get("related_skill_ids", [])
        ]

    def list_frontier(self, limit: int = 5, skill_id: str = "") -> list[dict[str, Any]]:
        rows = self.data["frontier"]
        if skill_id:
            rows = [row for row in rows if row.get("skill_id") == skill_id or skill_id in row.get("related_skill_ids", [])]
        return rows[: max(0, limit)]

    def _write_frontier_snapshot(self) -> None:
        self.frontier_path.write_text(json.dumps(self.data.get("frontier", []), indent=2) + "\n", encoding="utf-8")

    def _build_similarity_matches(self, candidate: dict[str, Any], exclude_id: str | None = None) -> list[dict[str, Any]]:
        matches: list[dict[str, Any]] = []
        cand_meta = tokenize(candidate.get("title", ""), candidate.get("problem", ""), candidate.get("trigger", ""))
        cand_fast = tokenize(candidate.get("fast_path", ""), candidate.get("failure_modes", ""), candidate.get("evidence", ""))
        cand_apply = {item.lower() for item in candidate.get("applies_to", [])}
        cand_keys = {item.lower() for item in ensure_list(candidate.get("canonical_keys"))}

        for skill in self.data["skills"].values():
            if skill.get("status") != "active":
                continue
            if exclude_id and skill.get("id") == exclude_id:
                continue

            skill_meta = tokenize(skill.get("title", ""), skill.get("problem", ""), skill.get("trigger", ""))
            skill_fast = tokenize(skill.get("fast_path", ""), skill.get("failure_modes", ""), skill.get("evidence", ""))
            skill_apply = {item.lower() for item in skill.get("applies_to", [])}
            skill_keys = {item.lower() for item in ensure_list(skill.get("canonical_keys"))}

            apply_overlap = 0.0
            if cand_apply and skill_apply:
                if cand_apply & skill_apply:
                    apply_overlap = 1.0
                else:
                    for left in cand_apply:
                        for right in skill_apply:
                            if left.rstrip("*") and left.rstrip("*") in right:
                                apply_overlap = max(apply_overlap, 0.75)
                            if right.rstrip("*") and right.rstrip("*") in left:
                                apply_overlap = max(apply_overlap, 0.75)

            canonical_overlap = 1.0 if cand_keys and skill_keys and (cand_keys & skill_keys) else 0.0
            kind_match = 1.0 if candidate.get("kind", "").lower() == skill.get("kind", "").lower() else 0.0
            similarity = (
                0.30 * jaccard(cand_meta, skill_meta)
                + 0.20 * jaccard(cand_fast, skill_fast)
                + 0.20 * apply_overlap
                + 0.15 * kind_match
                + 0.15 * canonical_overlap
            )
            if similarity >= 0.45:
                matches.append(
                    {
                        "skill_id": skill["id"],
                        "title": skill["title"],
                        "similarity": round(similarity, 3),
                        "kind": skill["kind"],
                        "applies_to": skill["applies_to"],
                        "score": skill["score"],
                        "canonical_keys": ensure_list(skill.get("canonical_keys")),
                    }
                )

        matches.sort(key=lambda item: (item["similarity"], item["score"]), reverse=True)
        return matches

    def lookup(
        self,
        url_pattern: str = "",
        task_type: str = "",
        goal: str = "",
        context: str = "",
        limit: int = 5,
    ) -> dict[str, Any]:
        terms = [term.lower() for term in re.findall(r"[A-Za-z0-9]{3,}", f"{goal} {context}")]
        matches: list[tuple[int, dict[str, Any]]] = []
        for skill in self.data["skills"].values():
            if skill.get("status") != "active":
                continue
            score = max(int(skill.get("score", 0)), 0)
            if task_type and task_type.lower() == ensure_text(skill.get("kind")).lower():
                score += 4
            haystack = " ".join(
                [
                    ensure_text(skill.get("title")),
                    ensure_text(skill.get("problem")),
                    ensure_text(skill.get("trigger")),
                    ensure_text(skill.get("preconditions")),
                    ensure_text(skill.get("fast_path")),
                    ensure_text(skill.get("failure_modes")),
                    ensure_text(skill.get("validation_status")),
                ]
            ).lower()
            for term in terms:
                if term in haystack:
                    score += 1
            if url_pattern:
                for pattern in ensure_list(skill.get("applies_to")):
                    if fnmatch.fnmatch(url_pattern, pattern):
                        score += 10
                    elif pattern.rstrip("*") and pattern.rstrip("*") in url_pattern:
                        score += 6
            if score > 0:
                item = dict(skill)
                item["match_score"] = score
                matches.append((score, item))
        matches.sort(key=lambda item: (item[0], ensure_text(item[1].get("updated_at"))), reverse=True)
        return {"matches": [item for _, item in matches[:limit]], "count": min(limit, len(matches))}

    def _normalize_candidate(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = ensure_text(payload.get("title")) or ensure_text(payload.get("goal")) or ensure_text(payload.get("problem"))
        kind = ensure_text(payload.get("kind") or payload.get("task_type") or "workflow").lower()
        applies_to = ensure_list(payload.get("applies_to"))
        if not applies_to and ensure_text(payload.get("url_pattern")):
            applies_to = [ensure_text(payload.get("url_pattern"))]

        observations = unique_list(
            ensure_list(payload.get("observations"))
            + ensure_list(payload.get("trajectory"))
            + ensure_list(payload.get("lessons"))
        )
        risks = unique_list(ensure_list(payload.get("risks")))
        next_actions = unique_list(ensure_list(payload.get("next_actions")))
        files = unique_list(ensure_list(payload.get("files")))
        references = unique_list(ensure_list(payload.get("references")))
        important_context = ensure_text(payload.get("important_context") or payload.get("context"))
        outcome = ensure_text(payload.get("outcome"))
        evidence_text = ensure_text(payload.get("evidence"))
        if outcome:
            evidence_text = merge_text(evidence_text, f"Outcome: {outcome}")
        if files:
            evidence_text = merge_text(evidence_text, "Files involved:\n" + "\n".join(f"- {item}" for item in files))
        if references:
            evidence_text = merge_text(evidence_text, "References:\n" + "\n".join(f"- {item}" for item in references))

        fast_path = ensure_text(payload.get("fast_path"))
        if not fast_path and observations:
            fast_path = "\n".join(f"{idx}. {item}" for idx, item in enumerate(observations[:5], start=1))
        if not fast_path and next_actions:
            fast_path = "\n".join(f"{idx}. {item}" for idx, item in enumerate(next_actions[:5], start=1))

        failure_modes = ensure_text(payload.get("failure_modes"))
        if not failure_modes and risks:
            failure_modes = "\n".join(f"- {item}" for item in risks)

        skip_steps_estimate = payload.get("skip_steps_estimate")
        if skip_steps_estimate in (None, "") or ensure_int(skip_steps_estimate) <= 0:
            derived = 0
            if observations:
                derived = max(2, min(12, len(observations) * 2))
            elif important_context:
                derived = 3
            skip_steps_estimate = derived

        long_task = bool(payload.get("long_task"))
        if not long_task:
            long_task = len(important_context) >= self.long_task_brief_min_chars or len(observations) >= 4

        route_decision = ensure_text(payload.get("route_decision")).lower()
        if not route_decision and not long_task:
            route_decision = "complete"

        memory_scope = ensure_text(payload.get("memory_scope")).lower() or infer_memory_scope(kind, ensure_text(payload.get("source_type") or ("trajectory" if observations else "summary")), long_task)
        memory_strategy = ensure_text(payload.get("memory_strategy")).lower() or ("knowledge_object" if ensure_text(payload.get("source_type") or ("trajectory" if observations else "summary")).lower() == "summary" else "hierarchical")
        update_strategy = ensure_text(payload.get("update_strategy")).lower() or "merge_append"
        durable_facts = unique_list(ensure_list(payload.get("durable_facts"))) or derive_durable_facts(
            ensure_text(payload.get("trigger") or payload.get("goal") or title),
            outcome,
            observations,
            risks,
        )
        provenance_refs = unique_list(
            ensure_list(payload.get("provenance_refs"))
            + files
            + references
            + ensure_list(payload.get("brief_refs"))
            + ensure_list(payload.get("artifact_refs"))
        )
        retrieval_hints = unique_list(ensure_list(payload.get("retrieval_hints"))) or derive_retrieval_hints(
            title,
            kind,
            applies_to,
            ensure_text(payload.get("trigger") or payload.get("goal") or title),
        )
        canonical_keys = unique_list(ensure_list(payload.get("canonical_keys"))) or derive_canonical_keys(
            title,
            kind,
            applies_to,
            ensure_text(payload.get("trigger") or payload.get("goal") or title),
        )

        proposal_action = ensure_text(payload.get("proposal_action")).lower()
        surrogate_verdict = ensure_text(payload.get("surrogate_verdict")).lower()
        oracle_verdict = ensure_text(payload.get("oracle_verdict")).lower()
        verification_mode = ensure_text(payload.get("verification_mode")).lower()
        judge_choice_raw = ensure_text(payload.get("judge_choice") or payload.get("selected_option") or payload.get("subjective_winner"))
        iteration_raw = payload.get("iteration")
        baseline_validation_raw = payload.get("baseline_validation_score")

        return {
            "skill_id": ensure_text(payload.get("skill_id")),
            "target_skill_id": ensure_text(payload.get("target_skill_id")),
            "parent_skill_id": ensure_text(payload.get("parent_skill_id")),
            "title": title,
            "kind": kind,
            "applies_to": applies_to,
            "problem": ensure_text(payload.get("problem") or payload.get("goal") or title),
            "trigger": ensure_text(payload.get("trigger") or payload.get("goal") or title),
            "preconditions": ensure_text(payload.get("preconditions") or important_context),
            "fast_path": fast_path,
            "failure_modes": failure_modes,
            "evidence": evidence_text,
            "http_candidate": bool(payload.get("http_candidate", False)),
            "source_type": ensure_text(payload.get("source_type") or ("trajectory" if observations else "summary")),
            "memory_scope": memory_scope,
            "memory_strategy": memory_strategy,
            "update_strategy": update_strategy,
            "durable_facts": durable_facts,
            "provenance_refs": provenance_refs,
            "retrieval_hints": retrieval_hints,
            "canonical_keys": canonical_keys,
            "skip_steps_estimate": int(skip_steps_estimate or 0),
            "confidence": ensure_text(payload.get("confidence") or ("high" if len(observations) >= 4 else "medium")).lower(),
            "last_validated": ensure_text(payload.get("last_validated")),
            "important_context": important_context,
            "observations": observations,
            "risks": risks,
            "next_actions": next_actions,
            "files": files,
            "references": references,
            "outcome": outcome,
            "brief_refs": unique_list(ensure_list(payload.get("brief_refs"))),
            "route_decision": route_decision,
            "route_reason": ensure_text(payload.get("route_reason")),
            "unresolved_questions": unique_list(ensure_list(payload.get("unresolved_questions"))),
            "artifact_refs": unique_list(ensure_list(payload.get("artifact_refs")) + ensure_list(payload.get("brief_refs"))),
            "assigned_target": ensure_text(payload.get("assigned_target")),
            "parent_packet_id": ensure_text(payload.get("parent_packet_id")),
            "hop_count": max(0, ensure_int(payload.get("hop_count"), 0)),
            "retry_count": max(0, ensure_int(payload.get("retry_count"), 0)),
            "long_task": long_task,
            "proposal_action": proposal_action,
            "proposal_reason": ensure_text(payload.get("proposal_reason")),
            "failure_summary": ensure_text(payload.get("failure_summary")),
            "benchmark": ensure_text(payload.get("benchmark")),
            "iteration": None if iteration_raw in (None, "") else max(0, ensure_int(iteration_raw, 0)),
            "baseline_validation_score": None if baseline_validation_raw in (None, "") else ensure_int(baseline_validation_raw, 0),
            "surrogate_verdict": surrogate_verdict,
            "surrogate_summary": ensure_text(payload.get("surrogate_summary")),
            "surrogate_findings": unique_list(ensure_list(payload.get("surrogate_findings"))),
            "oracle_verdict": oracle_verdict,
            "history_refs": unique_list(ensure_list(payload.get("history_refs"))),
            "program_id": ensure_text(payload.get("program_id")),
            "parent_program_id": ensure_text(payload.get("parent_program_id")),
            "verification_mode": verification_mode,
            "subjective_task": ensure_text(payload.get("subjective_task") or payload.get("evaluation_prompt") or payload.get("goal") or payload.get("problem") or title),
            "subjective_rubric": unique_list(ensure_list(payload.get("subjective_rubric"))),
            "baseline_output": ensure_text(payload.get("baseline_output") or payload.get("baseline_response") or payload.get("control_output")),
            "candidate_output": ensure_text(payload.get("candidate_output") or payload.get("candidate_response") or payload.get("mutated_output")),
            "judge_choice_raw": judge_choice_raw,
            "judge_choice": normalize_ab_choice(judge_choice_raw),
            "judge_summary": ensure_text(payload.get("judge_summary") or payload.get("subjective_summary")),
            "judge_findings": unique_list(
                ensure_list(payload.get("judge_findings"))
                + ensure_list(payload.get("subjective_findings"))
            ),
        }

    def _build_executive_summary(self, candidate: dict[str, Any], goal: str) -> str:
        return (
            f"{candidate['title']}: {goal or candidate['problem']}. "
            f"Outcome: {candidate['outcome'] or 'pending'}. "
            f"Future agent shortcut: solve in {max(candidate['skip_steps_estimate'], 1)} fewer steps by reusing the fast path."
        ).strip()

    def _resolve_verification_mode(self, candidate: dict[str, Any]) -> str:
        requested = ensure_text(candidate.get("verification_mode")).lower()
        if requested in VERIFICATION_MODES:
            return requested
        if ensure_text(candidate.get("oracle_verdict")):
            return "objective"
        if ensure_text(candidate.get("baseline_output")) and ensure_text(candidate.get("candidate_output")):
            return "subjective_pairwise"
        return "heuristic"

    def _default_subjective_rubric(self, candidate: dict[str, Any]) -> list[str]:
        rubric = unique_list(candidate.get("subjective_rubric", []))
        if rubric:
            return rubric
        custom_rules: list[str] = []
        if ensure_text(candidate.get("trigger")):
            custom_rules.append("Favor the option that more directly resolves the repeated failure or trigger condition.")
        if ensure_text(candidate.get("outcome")):
            custom_rules.append("Favor the option that better reaches the intended outcome with fewer unnecessary steps.")
        return unique_list(DEFAULT_SUBJECTIVE_RUBRIC + custom_rules)

    def _build_subjective_judge_prompt(self, task: str, rubric: list[str], options: list[dict[str, str]]) -> str:
        rubric_text = "\n".join(f"- {item}" for item in rubric)
        option_blocks = "\n\n".join(
            f"Option {option['label']} ({option['source']}):\n{option['content']}"
            for option in options
        )
        return (
            "You are an expert evaluator. Given a task and two candidate outputs, decide which option is better.\n\n"
            f"Task:\n{task}\n\n"
            f"Rubric:\n{rubric_text}\n\n"
            f"{option_blocks}\n\n"
            "Output requirement: return only `A` or `B`."
        )

    def _build_subjective_surrogate_review(
        self,
        candidate: dict[str, Any],
        proposal: dict[str, Any],
        validation: dict[str, Any],
        now: str,
    ) -> dict[str, Any]:
        baseline_output = ensure_text(candidate.get("baseline_output"))
        candidate_output = ensure_text(candidate.get("candidate_output"))
        task = ensure_text(candidate.get("subjective_task") or candidate.get("problem") or candidate.get("title"))
        baseline_first = deterministic_coin_flip(
            candidate.get("title"),
            candidate.get("benchmark"),
            candidate.get("iteration"),
            candidate.get("program_id"),
            candidate.get("target_skill_id"),
            candidate.get("skill_id"),
        )
        if baseline_first:
            options = [
                {"label": "A", "source": "baseline", "content": baseline_output},
                {"label": "B", "source": "candidate", "content": candidate_output},
            ]
            baseline_option = "A"
            candidate_option = "B"
        else:
            options = [
                {"label": "A", "source": "candidate", "content": candidate_output},
                {"label": "B", "source": "baseline", "content": baseline_output},
            ]
            baseline_option = "B"
            candidate_option = "A"

        judge_choice = normalize_ab_choice(candidate.get("judge_choice"))
        winner_source = next(
            (option["source"] for option in options if option["label"].lower() == judge_choice),
            "",
        )
        provided_surrogate_verdict = ensure_text(candidate.get("surrogate_verdict")).lower()
        if winner_source == "candidate":
            verdict = "pass"
        elif winner_source == "baseline":
            verdict = "fail"
        elif provided_surrogate_verdict in SURROGATE_VERDICTS:
            verdict = provided_surrogate_verdict
        else:
            verdict = "revise"

        rubric = self._default_subjective_rubric(candidate)
        findings = unique_list(
            candidate.get("judge_findings", [])
            + candidate.get("surrogate_findings", [])
            + validation.get("blockers", [])
            + validation.get("warnings", [])
        )
        findings.append(f"Candidate output was presented as option {candidate_option}; baseline output was presented as option {baseline_option}.")
        if judge_choice and winner_source:
            findings.append(f"Judge selected option {judge_choice.upper()}, which maps to the {winner_source} variant.")
        else:
            findings.append("Awaiting an A/B decision from the subjective verifier.")
        summary = ensure_text(candidate.get("judge_summary") or candidate.get("surrogate_summary"))
        if not summary:
            if winner_source == "candidate":
                summary = "The adapted VMR-style verifier preferred the candidate output over the baseline."
            elif winner_source == "baseline":
                summary = "The adapted VMR-style verifier preferred the baseline output over the candidate."
            else:
                summary = "Built a VMR-style pairwise verifier packet for this subjective task; no A/B decision has been recorded yet."

        return {
            "id": f"surrogate-{slugify(candidate['title'])}-{uuid.uuid4().hex[:8]}",
            "title": candidate["title"],
            "proposal_id": proposal["id"],
            "skill_id": ensure_text(proposal.get("skill_id")),
            "related_skill_ids": proposal["related_skill_ids"],
            "verdict": verdict,
            "summary": summary,
            "findings": unique_list(findings),
            "validation_status": validation["status"],
            "validation_score": validation["score"],
            "created_at": now,
            "verification_mode": "subjective_pairwise",
            "verifier_process": "vmr_pairwise_adapted",
            "task": task,
            "rubric": rubric,
            "randomized_option_order": True,
            "candidate_option": candidate_option,
            "baseline_option": baseline_option,
            "judge_choice": judge_choice.upper() if judge_choice else "",
            "winner_source": winner_source,
            "judge_prompt": self._build_subjective_judge_prompt(task, rubric, options),
            "options": options,
        }

    def _build_surrogate_review(
        self,
        candidate: dict[str, Any],
        proposal: dict[str, Any],
        validation: dict[str, Any],
        now: str,
    ) -> dict[str, Any]:
        verification_mode = self._resolve_verification_mode(candidate)
        if verification_mode == "subjective_pairwise":
            return self._build_subjective_surrogate_review(candidate, proposal, validation, now)

        provided_surrogate_verdict = ensure_text(candidate.get("surrogate_verdict")).lower()
        oracle_verdict = ensure_text(candidate.get("oracle_verdict")).lower()
        if verification_mode == "objective" and oracle_verdict:
            surrogate_verdict = "pass" if oracle_verdict in FRONTIER_ACCEPTED_ORACLE_VERDICTS else "fail"
        elif provided_surrogate_verdict in SURROGATE_VERDICTS:
            surrogate_verdict = provided_surrogate_verdict
        elif validation["status"] == "blocked":
            surrogate_verdict = "fail"
        elif validation["status"] in {"needs_revision", "merge_recommended"}:
            surrogate_verdict = "revise"
        else:
            surrogate_verdict = "pass"

        surrogate_findings = unique_list(
            candidate.get("surrogate_findings", [])
            + validation.get("blockers", [])
            + validation.get("warnings", [])
        )
        surrogate_summary = ensure_text(candidate.get("surrogate_summary"))
        if not surrogate_summary:
            if verification_mode == "objective" and oracle_verdict:
                if surrogate_verdict == "pass":
                    surrogate_summary = "The objective verifier accepted the candidate against the supplied oracle signal."
                else:
                    surrogate_summary = "The objective verifier rejected the candidate against the supplied oracle signal."
            elif surrogate_verdict == "fail":
                surrogate_summary = "The surrogate verifier found blocking issues in the proposed mutation."
            elif surrogate_verdict == "revise":
                surrogate_summary = "The surrogate verifier found a plausible mutation, but it still needs refinement."
            else:
                surrogate_summary = "The surrogate verifier found the mutation reusable enough to test against the frontier."
        return {
            "id": f"surrogate-{slugify(candidate['title'])}-{uuid.uuid4().hex[:8]}",
            "title": candidate["title"],
            "proposal_id": proposal["id"],
            "skill_id": ensure_text(proposal.get("skill_id")),
            "related_skill_ids": proposal["related_skill_ids"],
            "verdict": surrogate_verdict,
            "summary": surrogate_summary,
            "findings": surrogate_findings,
            "validation_status": validation["status"],
            "validation_score": validation["score"],
            "created_at": now,
            "verification_mode": verification_mode,
            "verifier_process": "oracle_gate" if verification_mode == "objective" else "heuristic_gate",
            "oracle_verdict": oracle_verdict,
        }

    def _build_packet(self, candidate: dict[str, Any], payload: dict[str, Any], created_at: str) -> dict[str, Any]:
        goal = ensure_text(payload.get("goal") or candidate.get("problem"))
        route_decision = ensure_text(candidate.get("route_decision")).lower()
        if not route_decision and not candidate.get("long_task"):
            route_decision = "complete"

        return {
            "id": ensure_text(payload.get("packet_id")) or f"packet-{slugify(candidate['title'])}-{uuid.uuid4().hex[:8]}",
            "skill_id": ensure_text(candidate.get("skill_id")),
            "title": candidate["title"],
            "task_type": candidate["kind"],
            "goal": goal,
            "executive_summary": self._build_executive_summary(candidate, goal),
            "important_context": candidate["important_context"],
            "outcome": candidate["outcome"],
            "observations": candidate["observations"],
            "risks": candidate["risks"],
            "next_actions": candidate["next_actions"],
            "confidence": candidate["confidence"],
            "route_decision": route_decision,
            "route_reason": ensure_text(candidate.get("route_reason")),
            "unresolved_questions": unique_list(ensure_list(candidate.get("unresolved_questions"))),
            "artifact_refs": unique_list(ensure_list(candidate.get("artifact_refs"))),
            "assigned_target": ensure_text(candidate.get("assigned_target")),
            "parent_packet_id": ensure_text(candidate.get("parent_packet_id")),
            "hop_count": max(0, ensure_int(candidate.get("hop_count"), 0)),
            "retry_count": max(0, ensure_int(candidate.get("retry_count"), 0)),
            "long_task": bool(candidate.get("long_task")),
            "related_skill_ids": [candidate["skill_id"]] if candidate.get("skill_id") else [],
            "created_at": created_at,
            "updated_at": created_at,
        }

    def _write_packet(self, packet: dict[str, Any]) -> str:
        path = self.packet_dir / f"{file_stamp(packet['created_at'])}--{safe_stem(packet['title'])}.json"
        rel = self._relative(path)
        packet["path"] = rel
        path.write_text(json.dumps(packet, indent=2) + "\n", encoding="utf-8")
        existing_idx = next((idx for idx, row in enumerate(self.data["packets"]) if row.get("id") == packet["id"]), None)
        if existing_idx is None:
            self.data["packets"].append(dict(packet))
            action = "created"
        else:
            self.data["packets"][existing_idx] = dict(packet)
            action = "updated"
        self._record_registry_event("skill_packet", {"packet_id": packet["id"], "path": rel, "action": action, "route_decision": packet.get("route_decision", "")})
        self._save()
        return rel

    def _refresh_packet(
        self,
        packet: dict[str, Any],
        *,
        artifact_refs: list[str] | None = None,
        related_skill_id: str = "",
        validation_status: str = "",
        pipeline_status: str = "",
    ) -> tuple[dict[str, Any], str]:
        updated = dict(packet)
        if artifact_refs:
            updated["artifact_refs"] = unique_list(ensure_list(updated.get("artifact_refs")) + artifact_refs)
        if related_skill_id:
            updated["skill_id"] = related_skill_id
            updated["related_skill_ids"] = unique_list(ensure_list(updated.get("related_skill_ids")) + [related_skill_id])
        if validation_status:
            updated["validation_status"] = validation_status
        if pipeline_status:
            updated["pipeline_status"] = pipeline_status
        updated["updated_at"] = utc_now()
        path = self._write_packet(updated)
        return updated, path

    def _write_brief(self, brief: dict[str, Any]) -> str:
        path = self.brief_dir / f"{file_stamp(brief['created_at'])}--{safe_stem(brief['title'])}.md"
        observations = "\n".join(f"- {item}" for item in brief["observations"]) or "- No detailed observations captured yet."
        risks = "\n".join(f"- {item}" for item in brief["risks"]) or "- No explicit risks captured."
        next_actions = "\n".join(f"- {item}" for item in brief["next_actions"]) or "- No next actions recorded."
        files = "\n".join(f"- {item}" for item in brief["files"]) or "- No files recorded."
        references = "\n".join(f"- {item}" for item in brief["references"]) or "- No references recorded."
        body = f"""---
id: {brief["id"]}
title: {yaml_quote(brief["title"])}
task_type: {brief["task_type"]}
created_at: {brief["created_at"]}
long_task: {"true" if brief["long_task"] else "false"}
related_skill_ids: {json.dumps(brief["related_skill_ids"])}
---

## Goal

{brief["goal"] or "Goal not captured."}

## Outcome

{brief["outcome"] or "Outcome not captured yet."}

## Important Context

{brief["important_context"] or "No important context supplied."}

## Executive Summary

{brief["executive_summary"]}

## Key Observations

{observations}

## Risks

{risks}

## Next Actions

{next_actions}

## Files

{files}

## References

{references}
"""
        path.write_text(body, encoding="utf-8")
        rel = self._relative(path)
        brief["path"] = rel
        self.data["briefs"].append(brief)
        self._record_registry_event("skill_brief", {"brief_id": brief["id"], "path": rel})
        self._save()
        return rel

    def reflect(self, payload: dict[str, Any]) -> dict[str, Any]:
        candidate = self._normalize_candidate(payload)
        if not candidate["title"]:
            return {"status": "blocked", "reason": "missing_title"}
        brief_pii_hits = detect_pii(
            ensure_text(payload.get("goal")),
            candidate["important_context"],
            ensure_text(payload.get("outcome")),
            ensure_text(payload.get("evidence")),
            "\n".join(candidate["observations"]),
        )
        if brief_pii_hits:
            return {"status": "blocked", "reason": "pii_detected", "matches": brief_pii_hits}
        now = utc_now()
        goal = ensure_text(payload.get("goal") or candidate["problem"])
        brief = {
            "id": f"brief-{slugify(candidate['title'])}-{uuid.uuid4().hex[:8]}",
            "title": candidate["title"],
            "created_at": now,
            "task_type": candidate["kind"],
            "goal": goal,
            "outcome": candidate["outcome"],
            "important_context": candidate["important_context"],
            "executive_summary": self._build_executive_summary(candidate, goal),
            "observations": candidate["observations"],
            "risks": candidate["risks"],
            "next_actions": candidate["next_actions"],
            "files": candidate["files"],
            "references": candidate["references"],
            "long_task": candidate["long_task"],
            "related_skill_ids": [candidate["skill_id"]] if candidate["skill_id"] else [],
        }
        persist_brief = payload.get("persist_brief", True)
        if persist_brief:
            brief_path = self._write_brief(brief)
            candidate["brief_refs"] = unique_list(candidate["brief_refs"] + [brief_path])
            candidate["artifact_refs"] = unique_list(candidate["artifact_refs"] + [brief_path])
        else:
            brief_path = ""
        packet = self._build_packet(candidate, payload, now)
        persist_packet = payload.get("persist_packet", True)
        if persist_packet:
            packet_path = self._write_packet(packet)
        else:
            packet_path = ""
        return {
            "status": "ok",
            "brief": brief,
            "brief_path": brief_path,
            "candidate": candidate,
            "packet": packet,
            "packet_path": packet_path,
        }

    def validate(self, payload: dict[str, Any]) -> dict[str, Any]:
        existing: dict[str, Any] | None = None
        skill_id = ensure_text(payload.get("skill_id"))
        if skill_id:
            existing = self.get_skill(skill_id)
            if not existing:
                return {"status": "missing", "skill_id": skill_id}
            merged_payload = dict(existing)
            merged_payload.update({key: value for key, value in payload.items() if value not in (None, "", [], {})})
            candidate = self._normalize_candidate(merged_payload)
            candidate["skill_id"] = skill_id
        else:
            candidate = self._normalize_candidate(payload)
        candidate["verification_mode"] = self._resolve_verification_mode(candidate)
        packet = payload.get("packet") if isinstance(payload.get("packet"), dict) else self._build_packet(candidate, payload, utc_now())

        blockers: list[str] = []
        warnings: list[str] = []
        checks: list[dict[str, str]] = []
        score = 0

        def add_check(name: str, passed: bool, detail: str, *, weight: int = 1, blocker: bool = False, warning: bool = False) -> None:
            nonlocal score
            status = "pass" if passed else "fail" if blocker else "warn" if warning else "fail"
            checks.append({"name": name, "status": status, "detail": detail})
            if passed:
                score += weight
            elif blocker:
                blockers.append(detail)
            elif warning:
                warnings.append(detail)

        pii_hits = detect_pii(
            candidate["title"],
            candidate["problem"],
            candidate["trigger"],
            candidate["preconditions"],
            candidate["fast_path"],
            candidate["failure_modes"],
            candidate["evidence"],
            candidate["important_context"],
        )
        add_check("privacy", not pii_hits, "No obvious PII detected." if not pii_hits else f"Potential PII detected: {', '.join(pii_hits)}", weight=2, blocker=bool(pii_hits))
        add_check("title", len(candidate["title"].split()) >= 2, "Skill title is specific enough." if len(candidate["title"].split()) >= 2 else "Skill title is too terse.", warning=True)
        add_check("kind", candidate["kind"] in DEFAULT_KINDS, f"Kind `{candidate['kind']}` matches the recommended taxonomy." if candidate["kind"] in DEFAULT_KINDS else f"Kind `{candidate['kind']}` is allowed but outside the recommended set {sorted(DEFAULT_KINDS)}.", warning=True)
        add_check("memory_scope", candidate["memory_scope"] in MEMORY_SCOPES, f"memory_scope `{candidate['memory_scope']}` is supported." if candidate["memory_scope"] in MEMORY_SCOPES else f"memory_scope must be one of {sorted(MEMORY_SCOPES)}.", weight=1, blocker=candidate["memory_scope"] not in MEMORY_SCOPES)
        add_check("memory_strategy", candidate["memory_strategy"] in MEMORY_STRATEGIES, f"memory_strategy `{candidate['memory_strategy']}` is supported." if candidate["memory_strategy"] in MEMORY_STRATEGIES else f"memory_strategy must be one of {sorted(MEMORY_STRATEGIES)}.", weight=1, blocker=candidate["memory_strategy"] not in MEMORY_STRATEGIES)
        add_check("update_strategy", candidate["update_strategy"] in UPDATE_STRATEGIES, f"update_strategy `{candidate['update_strategy']}` is supported." if candidate["update_strategy"] in UPDATE_STRATEGIES else f"update_strategy must be one of {sorted(UPDATE_STRATEGIES)}.", weight=1, blocker=candidate["update_strategy"] not in UPDATE_STRATEGIES)
        add_check("applies_to", bool(candidate["applies_to"]), "Applies-to patterns supplied." if candidate["applies_to"] else "At least one applies-to pattern is required.", weight=1, blocker=not candidate["applies_to"])
        add_check("trigger", len(candidate["trigger"]) >= 18, "Trigger is concrete." if len(candidate["trigger"]) >= 18 else "Trigger needs to be more explicit.", weight=1, blocker=len(candidate["trigger"]) < 18)
        add_check("problem", len(candidate["problem"]) >= 24, "Problem statement is grounded." if len(candidate["problem"]) >= 24 else "Problem statement is too thin.", weight=1, warning=True)
        add_check("preconditions", len(candidate["preconditions"]) >= 16, "Preconditions captured." if len(candidate["preconditions"]) >= 16 else "Preconditions are missing or too short.", weight=1, warning=True)
        add_check(
            "proposal_action",
            (not candidate["proposal_action"]) or candidate["proposal_action"] in EVOLUTION_ACTIONS,
            "Proposal action is valid." if (not candidate["proposal_action"]) or candidate["proposal_action"] in EVOLUTION_ACTIONS else f"proposal_action must be one of {sorted(EVOLUTION_ACTIONS)}.",
            weight=1,
            blocker=bool(candidate["proposal_action"]) and candidate["proposal_action"] not in EVOLUTION_ACTIONS,
        )
        add_check(
            "surrogate_verdict",
            (not candidate["surrogate_verdict"]) or candidate["surrogate_verdict"] in SURROGATE_VERDICTS,
            "Surrogate verdict is valid." if (not candidate["surrogate_verdict"]) or candidate["surrogate_verdict"] in SURROGATE_VERDICTS else f"surrogate_verdict must be one of {sorted(SURROGATE_VERDICTS)}.",
            weight=1,
            blocker=bool(candidate["surrogate_verdict"]) and candidate["surrogate_verdict"] not in SURROGATE_VERDICTS,
        )
        add_check(
            "verification_mode",
            candidate["verification_mode"] in VERIFICATION_MODES,
            f"Verification mode `{candidate['verification_mode']}` is supported." if candidate["verification_mode"] in VERIFICATION_MODES else f"verification_mode must be one of {sorted(VERIFICATION_MODES)}.",
            weight=1,
            blocker=candidate["verification_mode"] not in VERIFICATION_MODES,
        )
        add_check(
            "judge_choice",
            (not candidate["judge_choice_raw"]) or bool(candidate["judge_choice"]),
            "Judge choice is normalized to A/B." if (not candidate["judge_choice_raw"]) or bool(candidate["judge_choice"]) else "judge_choice must be `A` or `B` when supplied.",
            weight=1,
            blocker=bool(candidate["judge_choice_raw"]) and not bool(candidate["judge_choice"]),
        )
        add_check("fast_path", len(candidate["fast_path"]) >= 24, "Fast path is present." if len(candidate["fast_path"]) >= 24 else "Fast path is required and should be reusable.", weight=2, blocker=len(candidate["fast_path"]) < 24)
        add_check("failure_modes", len(candidate["failure_modes"]) >= 16, "Failure modes captured." if len(candidate["failure_modes"]) >= 16 else "Failure modes need more detail.", weight=1, warning=True)
        add_check("evidence", len(candidate["evidence"]) >= 40, "Evidence is substantive." if len(candidate["evidence"]) >= 40 else "Evidence is too short to validate the skill.", weight=2, blocker=len(candidate["evidence"]) < 40)
        add_check("durable_facts", bool(candidate.get("durable_facts")), "Durable facts were extracted for the skill memory object." if candidate.get("durable_facts") else "Add at least one durable_fact so the skill carries reusable memory, not just prose.", weight=1, warning=True)
        add_check("provenance_refs", bool(candidate.get("provenance_refs")), "Provenance refs were captured for later audit and deprecation." if candidate.get("provenance_refs") else "Capture at least one provenance_ref (file, reference, brief, or artifact) for durable skill memory.", weight=1, warning=True)
        add_check("canonical_keys", bool(candidate.get("canonical_keys")), "Canonical reconciliation keys were captured for write-time merge/update decisions." if candidate.get("canonical_keys") else "Capture canonical_keys so similar skills reconcile instead of duplicating.", weight=1, warning=True)
        add_check("hierarchical_memory", (not candidate["long_task"]) or candidate["memory_strategy"] != "flat", "Long-task candidates use a non-flat memory strategy." if (not candidate["long_task"]) or candidate["memory_strategy"] != "flat" else "Long tasks should use hierarchical or knowledge_object memory, not flat storage.", weight=1, warning=candidate["long_task"])
        add_check("skip_steps", candidate["skip_steps_estimate"] > 0, "Exploration cost savings estimated." if candidate["skip_steps_estimate"] > 0 else "skip_steps_estimate should be positive.", weight=1, warning=True)
        if candidate["verification_mode"] == "subjective_pairwise":
            pairwise_ready = bool(candidate["subjective_task"] and candidate["baseline_output"] and candidate["candidate_output"])
            add_check(
                "subjective_pairwise_inputs",
                pairwise_ready,
                "Subjective pairwise verification has the task plus baseline and candidate outputs." if pairwise_ready else "subjective_pairwise verification needs subjective_task, baseline_output, and candidate_output.",
                weight=1,
                warning=not pairwise_ready,
            )
        add_check(
            "briefing",
            (not candidate["long_task"]) or bool(candidate["brief_refs"]) or len(candidate["important_context"]) >= self.long_task_brief_min_chars,
            "Long-task context was captured with a reducer packet and supporting brief." if (not candidate["long_task"]) or bool(candidate["brief_refs"]) or len(candidate["important_context"]) >= self.long_task_brief_min_chars else "Long tasks should capture a stronger important-context reducer packet.",
            weight=1,
            warning=candidate["long_task"],
        )
        add_check(
            "route_decision_present",
            (not candidate["long_task"]) or bool(packet.get("route_decision")),
            "Long-task context includes an explicit route decision." if (not candidate["long_task"]) or bool(packet.get("route_decision")) else "Long tasks must set an explicit route_decision.",
            weight=1,
            blocker=bool(candidate["long_task"]) and not bool(packet.get("route_decision")),
        )
        add_check(
            "route_decision_valid",
            (not packet.get("route_decision")) or packet.get("route_decision") in ROUTE_DECISIONS,
            "Route decision omitted; non-long-task payloads default to `complete`." if not packet.get("route_decision") else f"Route decision `{packet.get('route_decision', '')}` is valid." if packet.get("route_decision") in ROUTE_DECISIONS else f"Route decision must be one of {sorted(ROUTE_DECISIONS)}.",
            weight=1,
            blocker=bool(packet.get("route_decision")) and packet.get("route_decision") not in ROUTE_DECISIONS,
        )
        add_check(
            "hop_budget",
            ensure_int(packet.get("hop_count"), 0) <= self.max_hops_default,
            f"hop_count is within the configured limit ({self.max_hops_default})." if ensure_int(packet.get("hop_count"), 0) <= self.max_hops_default else f"hop_count exceeds max_hops_default ({self.max_hops_default}).",
            weight=1,
            blocker=ensure_int(packet.get("hop_count"), 0) > self.max_hops_default,
        )
        add_check(
            "retry_budget",
            ensure_int(packet.get("retry_count"), 0) <= self.max_retries_default,
            f"retry_count is within the configured limit ({self.max_retries_default})." if ensure_int(packet.get("retry_count"), 0) <= self.max_retries_default else f"retry_count exceeds max_retries_default ({self.max_retries_default}).",
            weight=1,
            blocker=ensure_int(packet.get("retry_count"), 0) > self.max_retries_default,
        )
        packet_route = ensure_text(packet.get("route_decision")).lower()
        if packet_route == "complete":
            add_check(
                "route_complete",
                len(candidate["outcome"]) >= 16 or len(candidate["fast_path"]) >= 24,
                "Complete packets include a substantive outcome or reusable fast path." if len(candidate["outcome"]) >= 16 or len(candidate["fast_path"]) >= 24 else "Complete route requires a substantive outcome or reusable fast_path.",
                weight=1,
                blocker=True,
            )
        elif packet_route == "retry_same_worker":
            add_check(
                "route_retry",
                bool(packet.get("route_reason")) and bool(packet.get("unresolved_questions")),
                "Retry packet includes the reason and unresolved questions." if bool(packet.get("route_reason")) and bool(packet.get("unresolved_questions")) else "retry_same_worker requires route_reason and at least one unresolved question.",
                weight=1,
                blocker=True,
            )
        elif packet_route == "reroute_to_sibling":
            add_check(
                "route_reroute",
                bool(packet.get("route_reason")) and bool(packet.get("unresolved_questions")) and bool(packet.get("assigned_target")),
                "Sibling reroute packet includes the reason, target, and unresolved questions." if bool(packet.get("route_reason")) and bool(packet.get("unresolved_questions")) and bool(packet.get("assigned_target")) else "reroute_to_sibling requires assigned_target, route_reason, and at least one unresolved question.",
                weight=1,
                blocker=True,
            )
        elif packet_route == "escalate_to_parent":
            add_check(
                "route_escalate",
                bool(packet.get("route_reason")) and bool(packet.get("artifact_refs")),
                "Escalation packet includes the reason and artifact refs." if bool(packet.get("route_reason")) and bool(packet.get("artifact_refs")) else "escalate_to_parent requires route_reason and at least one artifact_ref.",
                weight=1,
                blocker=True,
            )
        elif packet_route == "stop_insufficient_evidence":
            add_check(
                "route_stop",
                bool(packet.get("route_reason")),
                "Stop packet includes the stopping reason." if bool(packet.get("route_reason")) else "stop_insufficient_evidence requires route_reason.",
                weight=1,
                blocker=True,
            )
        add_check(
            "summary_only",
            (not self.enforce_summary_only) or ("evidence" not in packet and "fast_path" not in packet and "failure_modes" not in packet),
            "Packet stays summary-only and references artifacts for raw detail." if (not self.enforce_summary_only) or ("evidence" not in packet and "fast_path" not in packet and "failure_modes" not in packet) else "Packets must remain summary-only when enforce_summary_only is enabled.",
            weight=1,
            blocker=self.enforce_summary_only and ("evidence" in packet or "fast_path" in packet or "failure_modes" in packet),
        )

        duplicate_matches = self._build_similarity_matches(candidate, exclude_id=skill_id or None)
        merge_target = ""
        if duplicate_matches and duplicate_matches[0]["similarity"] >= self.dedupe_similarity_threshold:
            merge_target = duplicate_matches[0]["skill_id"]
            add_check(
                "dedupe",
                False,
                f"Candidate overlaps with `{merge_target}` at similarity {duplicate_matches[0]['similarity']:.3f}; merge is recommended.",
                warning=True,
            )
        else:
            add_check("dedupe", True, "No strong duplicate detected.", weight=1)

        requested_target = ensure_text(candidate.get("target_skill_id") or skill_id)
        if candidate["proposal_action"] == "edit_skill":
            add_check(
                "proposal_target",
                bool(requested_target or merge_target),
                "Edit proposal can be attached to an existing skill." if bool(requested_target or merge_target) else "proposal_action=edit_skill requires target_skill_id, skill_id, or a dedupe merge target.",
                weight=1,
                blocker=not bool(requested_target or merge_target),
            )

        status = "validated"
        if blockers:
            status = "blocked"
        elif merge_target:
            status = "merge_recommended"
        elif score < self.min_validation_score:
            status = "needs_revision"

        report = {
            "status": status,
            "score": score,
            "min_validation_score": self.min_validation_score,
            "blockers": blockers,
            "warnings": warnings,
            "checks": checks,
            "candidate": candidate,
            "packet": packet,
            "packet_path": ensure_text(payload.get("packet_path") or packet.get("path")),
            "duplicate_matches": duplicate_matches[:5],
            "merge_target": merge_target,
            "validated_at": utc_now(),
        }
        if payload.get("persist_report", True):
            report["validation_path"] = self._write_validation_report(report)
        return report

    def _write_validation_report(self, report: dict[str, Any]) -> str:
        title = report["candidate"]["title"] or report["candidate"].get("skill_id") or "skill"
        path = self.validation_dir / f"{file_stamp(report['validated_at'])}--{safe_stem(title)}.json"
        path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        rel = self._relative(path)
        self.data["validations"].append({"id": f"validation-{uuid.uuid4().hex[:10]}", "created_at": report["validated_at"], "status": report["status"], "skill_id": report["candidate"].get("skill_id", ""), "path": rel})
        self._record_registry_event("skill_validation", {"path": rel, "status": report["status"], "title": title})
        self._save()
        return rel

    def _write_delta(self, payload: dict[str, Any]) -> str:
        created_at = payload.get("created_at") or utc_now()
        title = payload.get("candidate", {}).get("title") or payload.get("title") or "skill"
        path = self.delta_dir / f"{file_stamp(created_at)}--{safe_stem(title)}.json"
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        rel = self._relative(path)
        self.data["deltas"].append({"id": f"delta-{uuid.uuid4().hex[:10]}", "created_at": created_at, "path": rel, "title": title})
        self._record_registry_event("skill_delta", {"path": rel, "title": title})
        self._save()
        return rel

    def _derive_proposal_action(self, candidate: dict[str, Any], validation: dict[str, Any]) -> str:
        requested = ensure_text(candidate.get("proposal_action")).lower()
        if requested in EVOLUTION_ACTIONS:
            return requested
        if candidate.get("target_skill_id") or candidate.get("skill_id") or validation.get("merge_target"):
            return "edit_skill"
        return "create_skill"

    def _write_proposal(self, proposal: dict[str, Any]) -> str:
        path = self.proposal_dir / f"{file_stamp(proposal['created_at'])}--{safe_stem(proposal['title'])}.json"
        path.write_text(json.dumps(proposal, indent=2) + "\n", encoding="utf-8")
        rel = self._relative(path)
        proposal["path"] = rel
        self.data["proposals"].append(dict(proposal))
        self._record_registry_event(
            "skill_proposal",
            {
                "proposal_id": proposal["id"],
                "path": rel,
                "action": proposal["action"],
                "skill_id": proposal.get("skill_id", ""),
            },
        )
        self._save()
        return rel

    def _write_surrogate_review(self, review: dict[str, Any]) -> str:
        path = self.surrogate_review_dir / f"{file_stamp(review['created_at'])}--{safe_stem(review['title'])}.json"
        path.write_text(json.dumps(review, indent=2) + "\n", encoding="utf-8")
        rel = self._relative(path)
        review["path"] = rel
        self.data["surrogate_reviews"].append(dict(review))
        self._record_registry_event(
            "skill_surrogate_review",
            {
                "review_id": review["id"],
                "path": rel,
                "verdict": review["verdict"],
                "proposal_id": review["proposal_id"],
            },
        )
        self._save()
        return rel

    def _update_frontier(self, entry: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        frontier = [dict(row) for row in self.data.get("frontier", []) if row.get("status") == "accepted"]
        if entry.get("status") == "accepted":
            replaced = False
            for idx, row in enumerate(frontier):
                same_skill = row.get("skill_id") and row.get("skill_id") == entry.get("skill_id")
                same_program = row.get("program_id") and row.get("program_id") == entry.get("program_id")
                if same_skill or same_program:
                    frontier[idx] = dict(entry)
                    replaced = True
                    break
            if not replaced:
                frontier.append(dict(entry))
            frontier.sort(
                key=lambda row: (
                    int(row.get("validation_score", 0)),
                    int(row.get("score_delta", 0)),
                    row.get("updated_at", ""),
                ),
                reverse=True,
            )
            frontier = frontier[: max(1, self.frontier_size)]
        self.data["frontier"] = frontier
        self._record_registry_event(
            "skill_frontier",
            {
                "entry_id": entry["id"],
                "status": entry["status"],
                "skill_id": entry.get("skill_id", ""),
                "size": len(frontier),
            },
        )
        self._save()
        return entry, frontier

    def _write_evolution_run(self, run: dict[str, Any]) -> str:
        path = self.evolution_run_dir / f"{file_stamp(run['created_at'])}--{safe_stem(run['title'])}.json"
        path.write_text(json.dumps(run, indent=2) + "\n", encoding="utf-8")
        rel = self._relative(path)
        run["path"] = rel
        self.data["evolution_runs"].append(dict(run))
        self._record_registry_event(
            "skill_evolution_run",
            {
                "run_id": run["id"],
                "path": rel,
                "decision": run["decision"],
                "skill_id": run.get("skill_id", ""),
            },
        )
        self._save()
        return rel

    def _stamp_evolution_metadata(
        self,
        skill_id: str,
        *,
        frontier_status: str,
        proposal_id: str,
        run_id: str,
        proposal_path: str,
        run_path: str,
        parent_skill_id: str = "",
        lineage_note: str = "",
    ) -> dict[str, Any] | None:
        skill = self.get_skill(skill_id)
        if not skill:
            return None
        updated = dict(skill)
        updated["evolution_count"] = int(skill.get("evolution_count", 0)) + 1
        updated["last_evolved_at"] = utc_now()
        updated["frontier_status"] = frontier_status or ensure_text(skill.get("frontier_status") or "inactive")
        updated["parent_skill_id"] = ensure_text(parent_skill_id or skill.get("parent_skill_id"))
        updated["proposal_refs"] = unique_list(ensure_list(skill.get("proposal_refs")) + [proposal_id, proposal_path])
        updated["evolution_run_refs"] = unique_list(ensure_list(skill.get("evolution_run_refs")) + [run_id, run_path])
        updated["lineage"] = unique_list(ensure_list(skill.get("lineage")) + ([lineage_note] if lineage_note else []))
        updated["updated_at"] = updated["last_evolved_at"]
        self.data["skills"][skill_id] = updated
        self._save()
        self._write_skill(updated)
        self._sync_index()
        return updated

    def _max_confidence(self, left: str, right: str) -> str:
        left_rank = CONFIDENCE_ORDER.get(left.lower(), 0)
        right_rank = CONFIDENCE_ORDER.get(right.lower(), 0)
        return left if left_rank >= right_rank else right

    def _merge_skill(self, target_skill_id: str, candidate: dict[str, Any], validation: dict[str, Any]) -> dict[str, Any]:
        skill = dict(self.get_skill(target_skill_id) or {})
        if not skill:
            return {"status": "missing", "skill_id": target_skill_id}

        merged = dict(skill)
        merged["applies_to"] = unique_list(skill.get("applies_to", []) + candidate.get("applies_to", []))
        merged["problem"] = merge_text(skill.get("problem", ""), candidate.get("problem", ""))
        merged["trigger"] = merge_text(skill.get("trigger", ""), candidate.get("trigger", ""))
        merged["preconditions"] = merge_text(skill.get("preconditions", ""), candidate.get("preconditions", ""))
        merged["fast_path"] = merge_text(skill.get("fast_path", ""), candidate.get("fast_path", ""))
        merged["failure_modes"] = merge_text(skill.get("failure_modes", ""), candidate.get("failure_modes", ""))
        merged["evidence"] = merge_text(skill.get("evidence", ""), candidate.get("evidence", ""))
        merged["skip_steps_estimate"] = max(int(skill.get("skip_steps_estimate", 0)), int(candidate.get("skip_steps_estimate", 0)))
        merged["confidence"] = self._max_confidence(skill.get("confidence", "medium"), candidate.get("confidence", "medium"))
        merged["http_candidate"] = bool(skill.get("http_candidate", False) or candidate.get("http_candidate", False))
        merged["source_type"] = skill.get("source_type", candidate.get("source_type", "trajectory"))
        merged["memory_scope"] = candidate.get("memory_scope") or skill.get("memory_scope") or infer_memory_scope(merged["kind"], merged["source_type"], False)
        merged["memory_strategy"] = candidate.get("memory_strategy") or skill.get("memory_strategy") or "hierarchical"
        merged["update_strategy"] = candidate.get("update_strategy") or skill.get("update_strategy") or "merge_append"
        merged["durable_facts"] = unique_list(ensure_list(skill.get("durable_facts")) + ensure_list(candidate.get("durable_facts")))
        merged["provenance_refs"] = unique_list(ensure_list(skill.get("provenance_refs")) + ensure_list(candidate.get("provenance_refs")))
        merged["retrieval_hints"] = unique_list(ensure_list(skill.get("retrieval_hints")) + ensure_list(candidate.get("retrieval_hints")))
        merged["canonical_keys"] = unique_list(ensure_list(skill.get("canonical_keys")) + ensure_list(candidate.get("canonical_keys")))
        merged["last_validated"] = utc_day()
        merged["updated_at"] = utc_now()
        merged["validation_status"] = "validated"
        merged["validation_score"] = max(int(skill.get("validation_score", 0)), int(validation.get("score", 0)))
        merged["validation_notes"] = unique_list(ensure_list(skill.get("validation_notes")) + validation.get("warnings", []))
        merged["brief_refs"] = unique_list(ensure_list(skill.get("brief_refs")) + candidate.get("brief_refs", []))
        merged["evolution_count"] = int(skill.get("evolution_count", 0))
        merged["frontier_status"] = ensure_text(skill.get("frontier_status") or "inactive")
        merged["parent_skill_id"] = ensure_text(skill.get("parent_skill_id") or candidate.get("parent_skill_id"))
        merged["proposal_refs"] = unique_list(ensure_list(skill.get("proposal_refs")))
        merged["evolution_run_refs"] = unique_list(ensure_list(skill.get("evolution_run_refs")))
        merged["lineage"] = unique_list(ensure_list(skill.get("lineage")))
        merge_history = ensure_list(skill.get("merge_history"))
        merge_history.append(f"{utc_now()}: merged pipeline delta from {candidate['title']}")
        merged["merge_history"] = unique_list(merge_history)

        self.data["skills"][target_skill_id] = merged
        self._save()
        self._write_skill(merged)
        self._sync_index()
        self._append_log(
            "skill",
            f"merged `{candidate['title']}` into `{target_skill_id}`",
            [
                f"validation: {validation['status']} ({validation['score']})",
                f"brief refs: {', '.join(candidate.get('brief_refs', [])) or 'none'}",
            ],
        )
        return {"status": "merged", "skill": merged, "target_skill_id": target_skill_id}

    def propose(self, payload: dict[str, Any]) -> dict[str, Any]:
        validation = self.validate({**payload, "persist_report": payload.get("persist_report", True)})
        if validation["status"] == "blocked":
            return {"status": "blocked", "validation": validation}
        if validation["status"] == "merge_recommended" and not payload.get("allow_duplicate"):
            return {"status": "needs_review", "reason": "duplicate_skill_detected", "validation": validation}

        candidate = validation["candidate"]
        now = utc_now()
        skill_id = candidate["skill_id"] or slugify(f"skill-{candidate['title']}")
        existing = self.get_skill(skill_id) or {}
        skill = {
            "id": skill_id,
            "title": candidate["title"],
            "status": "active",
            "kind": candidate["kind"],
            "applies_to": candidate["applies_to"],
            "score": int(existing.get("score", 0)),
            "helpful_count": int(existing.get("helpful_count", 0)),
            "harmful_count": int(existing.get("harmful_count", 0)),
            "skip_steps_estimate": int(candidate.get("skip_steps_estimate", existing.get("skip_steps_estimate", 0))),
            "confidence": candidate.get("confidence", existing.get("confidence", "medium")),
            "pii_review": "passed",
            "validation_status": "validated" if validation["status"] == "validated" else validation["status"],
            "validation_score": int(validation["score"]),
            "validation_notes": validation["warnings"],
            "http_candidate": bool(candidate.get("http_candidate", existing.get("http_candidate", False))),
            "source_type": candidate.get("source_type", existing.get("source_type", "trajectory")),
            "memory_scope": candidate.get("memory_scope", existing.get("memory_scope", infer_memory_scope(candidate.get("kind", "workflow"), candidate.get("source_type", "trajectory"), bool(candidate.get("long_task"))))),
            "memory_strategy": candidate.get("memory_strategy", existing.get("memory_strategy", "hierarchical")),
            "update_strategy": candidate.get("update_strategy", existing.get("update_strategy", "merge_append")),
            "durable_facts": unique_list(ensure_list(existing.get("durable_facts")) + ensure_list(candidate.get("durable_facts"))),
            "provenance_refs": unique_list(ensure_list(existing.get("provenance_refs")) + ensure_list(candidate.get("provenance_refs"))),
            "retrieval_hints": unique_list(ensure_list(existing.get("retrieval_hints")) + ensure_list(candidate.get("retrieval_hints"))),
            "canonical_keys": unique_list(ensure_list(existing.get("canonical_keys")) + ensure_list(candidate.get("canonical_keys"))),
            "last_validated": candidate.get("last_validated") or utc_day(),
            "problem": candidate.get("problem", ""),
            "trigger": candidate.get("trigger", ""),
            "preconditions": candidate.get("preconditions", ""),
            "fast_path": candidate.get("fast_path", ""),
            "failure_modes": candidate.get("failure_modes", ""),
            "evidence": candidate.get("evidence", ""),
            "brief_refs": unique_list(ensure_list(existing.get("brief_refs")) + candidate.get("brief_refs", [])),
            "merge_history": ensure_list(existing.get("merge_history")),
            "evolution_count": int(existing.get("evolution_count", 0)),
            "frontier_status": ensure_text(existing.get("frontier_status") or "inactive"),
            "parent_skill_id": ensure_text(existing.get("parent_skill_id") or candidate.get("parent_skill_id")),
            "proposal_refs": unique_list(ensure_list(existing.get("proposal_refs"))),
            "evolution_run_refs": unique_list(ensure_list(existing.get("evolution_run_refs"))),
            "lineage": unique_list(ensure_list(existing.get("lineage"))),
            "created_at": existing.get("created_at", now),
            "updated_at": now,
        }
        self.data["skills"][skill_id] = skill
        self._save()
        self._write_skill(skill)
        self._sync_index()
        self._append_log(
            "skill",
            f"saved `{skill_id}`",
            [
                f"validation: {skill['validation_status']} ({skill['validation_score']})",
                f"kind: {skill['kind']}",
                f"brief refs: {', '.join(skill['brief_refs']) or 'none'}",
            ],
        )
        return {"status": "saved", "skill": skill, "validation": validation}

    def pipeline_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        reflection = self.reflect(payload)
        if reflection["status"] != "ok":
            return reflection
        persist_packet = payload.get("persist_packet", True)

        validation_payload = dict(payload)
        validation_payload.update(reflection["candidate"])
        validation_payload["packet"] = reflection["packet"]
        validation_payload["packet_path"] = reflection.get("packet_path", "")
        validation_payload["persist_report"] = payload.get("persist_report", True)
        validation = self.validate(validation_payload)

        delta = {
            "created_at": utc_now(),
            "brief": reflection["brief"],
            "brief_path": reflection.get("brief_path", ""),
            "packet": validation["packet"],
            "packet_path": reflection.get("packet_path", ""),
            "candidate": validation["candidate"],
            "validation": {
                "status": validation["status"],
                "score": validation["score"],
                "blockers": validation["blockers"],
                "warnings": validation["warnings"],
                "merge_target": validation["merge_target"],
                "validation_path": validation.get("validation_path", ""),
            },
        }
        delta_path = self._write_delta(delta)
        packet = dict(validation["packet"])
        packet_path = reflection.get("packet_path", "")
        if persist_packet:
            packet, packet_path = self._refresh_packet(
                validation["packet"],
                artifact_refs=[
                    reflection.get("brief_path", ""),
                    validation.get("validation_path", ""),
                    delta_path,
                ],
                validation_status=validation["status"],
                pipeline_status=validation["status"],
            )
        else:
            packet["artifact_refs"] = unique_list(
                ensure_list(packet.get("artifact_refs"))
                + [item for item in [reflection.get("brief_path", ""), validation.get("validation_path", ""), delta_path] if item]
            )
            packet["validation_status"] = validation["status"]
            packet["pipeline_status"] = validation["status"]
        reflection["packet"] = packet
        reflection["packet_path"] = packet_path
        validation["packet"] = packet
        validation["packet_path"] = packet_path

        if validation["status"] == "blocked":
            self._append_log(
                "skill",
                f"blocked `{validation['candidate']['title']}`",
                [f"blockers: {', '.join(validation['blockers'])}", f"delta: {delta_path}"],
            )
            return {"status": "blocked", "reflection": reflection, "validation": validation, "packet": packet, "packet_path": packet_path, "delta_path": delta_path}

        persist = payload.get("persist", True)
        if not persist:
            return {"status": validation["status"], "reflection": reflection, "validation": validation, "packet": packet, "packet_path": packet_path, "delta_path": delta_path}

        if packet.get("route_decision") and packet["route_decision"] != "complete":
            routed_status = packet["route_decision"]
            if persist_packet:
                packet, packet_path = self._refresh_packet(packet, pipeline_status=routed_status)
            else:
                packet["pipeline_status"] = routed_status
            reflection["packet"] = packet
            reflection["packet_path"] = packet_path
            validation["packet"] = packet
            validation["packet_path"] = packet_path
            self._append_log(
                "skill",
                f"routed `{validation['candidate']['title']}`",
                [
                    f"route decision: {routed_status}",
                    f"route reason: {packet.get('route_reason') or 'none'}",
                    f"delta: {delta_path}",
                ],
            )
            return {
                "status": routed_status,
                "reflection": reflection,
                "validation": validation,
                "packet": packet,
                "packet_path": packet_path,
                "delta_path": delta_path,
            }

        auto_merge = payload.get("auto_merge")
        if auto_merge is None:
            auto_merge = self.auto_merge_duplicates

        if validation["merge_target"] and auto_merge:
            merged = self._merge_skill(validation["merge_target"], validation["candidate"], validation)
            if persist_packet:
                packet, packet_path = self._refresh_packet(packet, related_skill_id=validation["merge_target"], pipeline_status=merged["status"])
            else:
                packet["skill_id"] = validation["merge_target"]
                packet["related_skill_ids"] = unique_list(ensure_list(packet.get("related_skill_ids")) + [validation["merge_target"]])
                packet["pipeline_status"] = merged["status"]
            reflection["packet"] = packet
            reflection["packet_path"] = packet_path
            validation["packet"] = packet
            validation["packet_path"] = packet_path
            return {
                "status": merged["status"],
                "reflection": reflection,
                "validation": validation,
                "packet": packet,
                "packet_path": packet_path,
                "skill": merged.get("skill"),
                "delta_path": delta_path,
                "target_skill_id": validation["merge_target"],
            }

        saved = self.propose({**validation["candidate"], "allow_duplicate": payload.get("allow_duplicate", False), "persist_report": False})
        related_skill_id = ensure_text((saved.get("skill") or {}).get("id"))
        if persist_packet:
            packet, packet_path = self._refresh_packet(packet, related_skill_id=related_skill_id, pipeline_status=saved["status"])
        else:
            if related_skill_id:
                packet["skill_id"] = related_skill_id
                packet["related_skill_ids"] = unique_list(ensure_list(packet.get("related_skill_ids")) + [related_skill_id])
            packet["pipeline_status"] = saved["status"]
        reflection["packet"] = packet
        reflection["packet_path"] = packet_path
        validation["packet"] = packet
        validation["packet_path"] = packet_path
        return {
            "status": saved["status"],
            "reflection": reflection,
            "validation": validation,
            "packet": packet,
            "packet_path": packet_path,
            "skill": saved.get("skill"),
            "delta_path": delta_path,
        }

    def evolve(self, payload: dict[str, Any]) -> dict[str, Any]:
        reflection = self.reflect(payload)
        if reflection["status"] != "ok":
            return reflection

        persist_packet = payload.get("persist_packet", True)
        validation_payload = dict(payload)
        validation_payload.update(reflection["candidate"])
        validation_payload["packet"] = reflection["packet"]
        validation_payload["packet_path"] = reflection.get("packet_path", "")
        validation_payload["persist_report"] = payload.get("persist_report", True)
        validation = self.validate(validation_payload)

        delta = {
            "created_at": utc_now(),
            "brief": reflection["brief"],
            "brief_path": reflection.get("brief_path", ""),
            "packet": validation["packet"],
            "packet_path": reflection.get("packet_path", ""),
            "candidate": validation["candidate"],
            "validation": {
                "status": validation["status"],
                "score": validation["score"],
                "blockers": validation["blockers"],
                "warnings": validation["warnings"],
                "merge_target": validation["merge_target"],
                "validation_path": validation.get("validation_path", ""),
            },
            "evolution_requested": True,
        }
        delta_path = self._write_delta(delta)
        packet = dict(validation["packet"])
        packet_path = reflection.get("packet_path", "")
        if persist_packet:
            packet, packet_path = self._refresh_packet(
                validation["packet"],
                artifact_refs=[
                    reflection.get("brief_path", ""),
                    validation.get("validation_path", ""),
                    delta_path,
                ],
                validation_status=validation["status"],
                pipeline_status=validation["status"],
            )
        else:
            packet["artifact_refs"] = unique_list(
                ensure_list(packet.get("artifact_refs"))
                + [item for item in [reflection.get("brief_path", ""), validation.get("validation_path", ""), delta_path] if item]
            )
            packet["validation_status"] = validation["status"]
            packet["pipeline_status"] = validation["status"]
        reflection["packet"] = packet
        reflection["packet_path"] = packet_path
        validation["packet"] = packet
        validation["packet_path"] = packet_path

        candidate = validation["candidate"]
        proposal_action = self._derive_proposal_action(candidate, validation)
        target_skill_id = ensure_text(candidate.get("target_skill_id") or candidate.get("skill_id") or validation.get("merge_target"))
        baseline_skill = self.get_skill(target_skill_id) if target_skill_id else None
        baseline_score = ensure_int(candidate.get("baseline_validation_score"), int((baseline_skill or {}).get("validation_score", 0)))
        benchmark = ensure_text(candidate.get("benchmark"))
        iteration = ensure_int(candidate.get("iteration"), len(self.data["evolution_runs"]) + 1)
        now = utc_now()

        proposal = {
            "id": f"proposal-{slugify(candidate['title'])}-{uuid.uuid4().hex[:8]}",
            "title": candidate["title"],
            "action": proposal_action,
            "reason": ensure_text(candidate.get("proposal_reason"))
            or ("Improve an existing reusable skill after repeated failure evidence." if proposal_action == "edit_skill" else "Create a new reusable skill from a novel failure pattern." if proposal_action == "create_skill" else "Discard the proposed mutation."),
            "failure_summary": ensure_text(candidate.get("failure_summary"))
            or candidate["outcome"]
            or candidate["evidence"],
            "skill_id": target_skill_id,
            "candidate_skill_id": candidate.get("skill_id", ""),
            "related_skill_ids": unique_list(
                [item for item in [target_skill_id, candidate.get("skill_id", ""), validation.get("merge_target", "")] if item]
            ),
            "duplicate_matches": validation.get("duplicate_matches", [])[:3],
            "history_refs": unique_list(candidate.get("history_refs", [])),
            "benchmark": benchmark,
            "iteration": iteration,
            "packet_id": packet.get("id", ""),
            "packet_path": packet_path,
            "validation_status": validation["status"],
            "validation_score": validation["score"],
            "validation_path": validation.get("validation_path", ""),
            "delta_path": delta_path,
            "created_at": now,
        }
        proposal_path = self._write_proposal(proposal)

        surrogate_review = self._build_surrogate_review(candidate, proposal, validation, now)
        surrogate_verdict = ensure_text(surrogate_review.get("verdict")).lower()
        verification_mode = ensure_text(surrogate_review.get("verification_mode") or candidate.get("verification_mode") or "heuristic")
        surrogate_review_path = self._write_surrogate_review(surrogate_review)
        if persist_packet:
            packet, packet_path = self._refresh_packet(
                packet,
                artifact_refs=[proposal_path, surrogate_review_path],
                validation_status=validation["status"],
                pipeline_status=packet.get("pipeline_status", validation["status"]),
            )
        else:
            packet["artifact_refs"] = unique_list(ensure_list(packet.get("artifact_refs")) + [proposal_path, surrogate_review_path])
        reflection["packet"] = packet
        reflection["packet_path"] = packet_path
        validation["packet"] = packet
        validation["packet_path"] = packet_path

        routed_status = ensure_text(packet.get("route_decision")).lower()
        oracle_verdict = ensure_text(candidate.get("oracle_verdict")).lower()
        decision = "accepted"
        if proposal_action == "discard":
            decision = "discarded"
        elif routed_status and routed_status != "complete":
            decision = routed_status
        elif validation["status"] == "blocked":
            decision = "discarded"
        elif surrogate_verdict == "fail" and self.surrogate_fail_blocks:
            decision = "discarded"
        elif surrogate_verdict == "revise":
            decision = "needs_revision"
        elif validation["status"] in {"needs_revision"}:
            decision = "needs_revision"
        elif oracle_verdict and oracle_verdict not in FRONTIER_ACCEPTED_ORACLE_VERDICTS:
            decision = "discarded"

        saved_skill: dict[str, Any] | None = None
        resolved_skill_id = target_skill_id
        if decision == "accepted":
            if proposal_action == "edit_skill":
                merge_target = target_skill_id or validation.get("merge_target", "")
                if not merge_target:
                    decision = "needs_revision"
                else:
                    merged = self._merge_skill(merge_target, candidate, validation)
                    if merged["status"] == "missing":
                        decision = "needs_revision"
                    else:
                        saved_skill = merged.get("skill")
                        resolved_skill_id = merge_target
            else:
                saved = self.propose(
                    {
                        **candidate,
                        "allow_duplicate": True,
                        "persist_report": False,
                    }
                )
                if saved["status"] in {"blocked", "missing", "needs_review"}:
                    decision = "needs_revision"
                else:
                    saved_skill = saved.get("skill")
                    resolved_skill_id = ensure_text((saved.get("skill") or {}).get("id"))

        candidate_score = int((saved_skill or {}).get("validation_score", validation["score"]))
        score_delta = candidate_score - baseline_score
        frontier_status = "discarded"
        if decision == "accepted":
            if proposal_action == "create_skill" or score_delta >= self.min_frontier_delta or oracle_verdict in FRONTIER_ACCEPTED_ORACLE_VERDICTS:
                frontier_status = "accepted"
            else:
                frontier_status = "candidate"

        frontier_entry = {
            "id": f"frontier-{uuid.uuid4().hex[:10]}",
            "proposal_id": proposal["id"],
            "run_iteration": iteration,
            "skill_id": resolved_skill_id,
            "title": candidate["title"],
            "action": proposal_action,
            "benchmark": benchmark,
            "program_id": ensure_text(candidate.get("program_id")) or proposal["id"],
            "parent_program_id": ensure_text(candidate.get("parent_program_id")),
            "related_skill_ids": unique_list(
                [item for item in [resolved_skill_id, target_skill_id, candidate.get("parent_skill_id", "")] if item]
            ),
            "validation_score": candidate_score,
            "baseline_score": baseline_score,
            "score_delta": score_delta,
            "oracle_verdict": oracle_verdict,
            "surrogate_verdict": surrogate_verdict,
            "verification_mode": verification_mode,
            "winner_source": ensure_text(surrogate_review.get("winner_source")),
            "status": frontier_status,
            "updated_at": utc_now(),
        }
        frontier_entry, frontier = self._update_frontier(frontier_entry)

        evolution_run = {
            "id": f"evolution-{slugify(candidate['title'])}-{uuid.uuid4().hex[:8]}",
            "title": candidate["title"],
            "decision": decision,
            "skill_id": resolved_skill_id,
            "target_skill_id": target_skill_id,
            "related_skill_ids": unique_list(
                [item for item in [resolved_skill_id, target_skill_id, candidate.get("parent_skill_id", "")] if item]
            ),
            "proposal_id": proposal["id"],
            "proposal_path": proposal_path,
            "surrogate_review_id": surrogate_review["id"],
            "surrogate_review_path": surrogate_review_path,
            "packet_id": packet.get("id", ""),
            "packet_path": packet_path,
            "validation_path": validation.get("validation_path", ""),
            "delta_path": delta_path,
            "frontier_entry_id": frontier_entry["id"],
            "frontier_status": frontier_status,
            "action": proposal_action,
            "benchmark": benchmark,
            "iteration": iteration,
            "baseline_validation_score": baseline_score,
            "candidate_validation_score": candidate_score,
            "score_delta": score_delta,
            "oracle_verdict": oracle_verdict,
            "surrogate_verdict": surrogate_verdict,
            "verification_mode": verification_mode,
            "winner_source": ensure_text(surrogate_review.get("winner_source")),
            "program_id": frontier_entry["program_id"],
            "parent_program_id": frontier_entry["parent_program_id"],
            "created_at": utc_now(),
        }
        evolution_run_path = self._write_evolution_run(evolution_run)
        if persist_packet:
            packet, packet_path = self._refresh_packet(
                packet,
                artifact_refs=[evolution_run_path],
                related_skill_id=resolved_skill_id,
                pipeline_status=decision,
                validation_status=validation["status"],
            )
        else:
            packet["artifact_refs"] = unique_list(ensure_list(packet.get("artifact_refs")) + [evolution_run_path])
            if resolved_skill_id:
                packet["skill_id"] = resolved_skill_id
                packet["related_skill_ids"] = unique_list(ensure_list(packet.get("related_skill_ids")) + [resolved_skill_id])
            packet["pipeline_status"] = decision
        reflection["packet"] = packet
        reflection["packet_path"] = packet_path
        validation["packet"] = packet
        validation["packet_path"] = packet_path

        if decision == "accepted" and resolved_skill_id:
            lineage_note = (
                f"{utc_now()}: EvoSkill {proposal_action} via {proposal['id']} "
                f"(baseline={baseline_score}, candidate={candidate_score}, delta={score_delta:+d})"
            )
            saved_skill = self._stamp_evolution_metadata(
                resolved_skill_id,
                frontier_status=frontier_status,
                proposal_id=proposal["id"],
                run_id=evolution_run["id"],
                proposal_path=proposal_path,
                run_path=evolution_run_path,
                parent_skill_id=target_skill_id or candidate.get("parent_skill_id", ""),
                lineage_note=lineage_note,
            ) or saved_skill

        self._append_log(
            "skill",
            f"evolved `{candidate['title']}`",
            [
                f"decision: {decision}",
                f"proposal: {proposal_action}",
                f"surrogate: {surrogate_verdict}",
                f"validation: {validation['status']} ({validation['score']})",
                f"frontier: {frontier_status}",
                f"delta path: {delta_path}",
            ],
        )
        return {
            "status": decision,
            "reflection": reflection,
            "validation": validation,
            "packet": packet,
            "packet_path": packet_path,
            "delta_path": delta_path,
            "proposal": proposal,
            "proposal_path": proposal_path,
            "surrogate_review": surrogate_review,
            "surrogate_review_path": surrogate_review_path,
            "frontier_entry": frontier_entry,
            "frontier": frontier,
            "evolution_run": evolution_run,
            "evolution_run_path": evolution_run_path,
            "skill": saved_skill,
        }

    def feedback(
        self,
        skill_id: str,
        verdict: str,
        reason: str,
        evidence: str = "",
        score_delta: int | None = None,
    ) -> dict[str, Any]:
        skill = self.get_skill(skill_id)
        if not skill:
            return {"status": "missing", "skill_id": skill_id}
        pii = detect_pii(reason, evidence)
        if pii:
            return {"status": "blocked", "reason": "pii_detected", "matches": pii}
        if score_delta is None:
            score_delta = 1 if verdict == "upvote" else -1 if verdict == "downvote" else 0
        row = {
            "id": f"feedback-{uuid.uuid4().hex[:12]}",
            "skill_id": skill_id,
            "verdict": verdict,
            "score_delta": int(score_delta),
            "reason": ensure_text(reason),
            "evidence": ensure_text(evidence),
            "created_at": utc_now(),
        }
        self.data["feedback"].append(row)

        skill["score"] = int(skill.get("score", 0)) + int(score_delta)
        if verdict == "upvote":
            skill["helpful_count"] = int(skill.get("helpful_count", 0)) + abs(int(score_delta))
            skill["last_validated"] = utc_day()
            if evidence:
                skill["evidence"] = merge_text(skill.get("evidence", ""), evidence)
        elif verdict == "downvote":
            skill["harmful_count"] = int(skill.get("harmful_count", 0)) + abs(int(score_delta))
            amendment = f"- Feedback downgrade: {reason}"
            if evidence:
                amendment = f"{amendment}\n- Evidence: {evidence}"
            skill["failure_modes"] = merge_text(skill.get("failure_modes", ""), amendment)
            skill["validation_status"] = "needs_revision"
        elif verdict == "amend":
            skill["last_validated"] = utc_day()
            amendment = f"- Feedback amendment: {reason}"
            if evidence:
                amendment = f"{amendment}\n- Evidence: {evidence}"
            skill["failure_modes"] = merge_text(skill.get("failure_modes", ""), amendment)

        skill["updated_at"] = row["created_at"]
        self._write_feedback(row)

        retired = False
        if skill["score"] < self.retire_below_score:
            retired = True
            self.retire(skill_id, f"Auto-retired after score fell below {self.retire_below_score}")
        else:
            self._save()
            self._write_skill(skill)
            self._sync_index()
            self._append_log(
                "skill",
                f"feedback for `{skill_id}`",
                [f"verdict: {verdict}", f"score delta: {score_delta:+d}", f"reason: {reason}"],
            )
        return {"status": "saved", "feedback": row, "retired": retired, "skill": self.get_skill(skill_id)}

    def retire(self, skill_id: str, reason: str) -> dict[str, Any]:
        skill = self.get_skill(skill_id)
        if not skill:
            return {"status": "missing", "skill_id": skill_id}
        pii = detect_pii(reason)
        if pii:
            return {"status": "blocked", "reason": "pii_detected", "matches": pii}
        skill["status"] = "retired"
        skill["validation_status"] = "retired"
        skill["updated_at"] = utc_now()
        self._save()
        active_path = self.active_dir / f"{skill_id}.md"
        if active_path.exists():
            active_path.unlink()
        self._write_skill(skill, retirement_reason=reason)
        self._sync_index()
        self._append_log("skill", f"retired `{skill_id}`", [f"reason: {reason}"])
        return {"status": "retired", "skill": skill, "reason": reason}

    def _write_skill(self, skill: dict[str, Any], retirement_reason: str = "") -> None:
        target_dir = self.retired_dir if skill["status"] == "retired" else self.active_dir
        feedback_summary = "\n".join(
            f"- {row['created_at']}: {row['verdict']} ({row['score_delta']:+d}) - {row['reason']}"
            for row in self.list_feedback(skill["id"])[-5:]
        ) or "- No feedback yet"
        validation_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("validation_notes"))) or "- No validation warnings recorded."
        brief_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("brief_refs"))) or "- No brief references recorded."
        durable_facts_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("durable_facts"))) or "- No durable facts recorded."
        provenance_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("provenance_refs"))) or "- No provenance refs recorded."
        retrieval_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("retrieval_hints"))) or "- No retrieval hints recorded."
        canonical_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("canonical_keys"))) or "- No canonical reconciliation keys recorded."
        merge_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("merge_history"))) or "- No merge history."
        proposal_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("proposal_refs"))) or "- No proposal history."
        evolution_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("evolution_run_refs"))) or "- No evolution runs."
        lineage_summary = "\n".join(f"- {item}" for item in ensure_list(skill.get("lineage"))) or "- No lineage notes."
        applies = "\n".join(f"  - {yaml_quote(item)}" for item in skill["applies_to"]) or "  - \"<fill in>\""
        body = f"""---
id: {skill["id"]}
title: {yaml_quote(skill["title"])}
status: {skill["status"]}
kind: {skill["kind"]}
applies_to:
{applies}
score: {skill["score"]}
helpful_count: {skill.get("helpful_count", 0)}
harmful_count: {skill.get("harmful_count", 0)}
skip_steps_estimate: {skill["skip_steps_estimate"]}
confidence: {skill["confidence"]}
pii_review: passed
validation_status: {skill.get("validation_status", "unknown")}
validation_score: {skill.get("validation_score", 0)}
http_candidate: {"true" if skill["http_candidate"] else "false"}
source_type: {skill["source_type"]}
memory_scope: {yaml_quote(ensure_text(skill.get("memory_scope") or infer_memory_scope(skill.get("kind", "workflow"), skill.get("source_type", "trajectory"), False)))}
memory_strategy: {yaml_quote(ensure_text(skill.get("memory_strategy") or "hierarchical"))}
update_strategy: {yaml_quote(ensure_text(skill.get("update_strategy") or "merge_append"))}
durable_facts: {json.dumps(ensure_list(skill.get("durable_facts")))}
provenance_refs: {json.dumps(ensure_list(skill.get("provenance_refs")))}
retrieval_hints: {json.dumps(ensure_list(skill.get("retrieval_hints")))}
canonical_keys: {json.dumps(ensure_list(skill.get("canonical_keys")))}
last_validated: {skill["last_validated"]}
brief_refs: {json.dumps(ensure_list(skill.get("brief_refs")))}
evolution_count: {skill.get("evolution_count", 0)}
frontier_status: {yaml_quote(ensure_text(skill.get("frontier_status") or "inactive"))}
parent_skill_id: {yaml_quote(ensure_text(skill.get("parent_skill_id")))}
proposal_refs: {json.dumps(ensure_list(skill.get("proposal_refs")))}
evolution_run_refs: {json.dumps(ensure_list(skill.get("evolution_run_refs")))}
created_at: {skill["created_at"]}
updated_at: {skill["updated_at"]}
---

## Problem

{skill["problem"] or "Describe the repeated problem."}

## Trigger

{skill["trigger"] or "Describe when to apply this skill."}

## Preconditions

{skill["preconditions"] or "List the preconditions."}

## Memory Role

- Scope: `{ensure_text(skill.get("memory_scope") or infer_memory_scope(skill.get("kind", "workflow"), skill.get("source_type", "trajectory"), False))}`
- Strategy: `{ensure_text(skill.get("memory_strategy") or "hierarchical")}`
- Update strategy: `{ensure_text(skill.get("update_strategy") or "merge_append")}`

## Durable Facts

{durable_facts_summary}

## Retrieval Hints

{retrieval_summary}

## Provenance

{provenance_summary}

## Reconciliation Keys

{canonical_summary}

## Fast Path

{skill["fast_path"] or "Describe the short reusable recipe."}

## Failure Modes

{skill["failure_modes"] or "Record edge cases and failure modes."}

## Feedback Summary

{feedback_summary}

## Validation Summary

{validation_summary}

## Brief References

{brief_summary}

## Merge History

{merge_summary}

## EvoSkill Lineage

Frontier status: `{ensure_text(skill.get("frontier_status") or "inactive")}`

Evolution count: {skill.get("evolution_count", 0)}

Parent skill: `{ensure_text(skill.get("parent_skill_id")) or "none"}`

### Proposal References

{proposal_summary}

### Evolution Runs

{evolution_summary}

### Lineage Notes

{lineage_summary}

## HTTP Upgrade Candidate

{"Yes" if skill["http_candidate"] else "No"}

## Evidence

{skill["evidence"] or "Record the grounding evidence."}
"""
        if retirement_reason:
            body += f"\n## Retirement Reason\n\n{retirement_reason}\n"
        (target_dir / f"{skill['id']}.md").write_text(body, encoding="utf-8")

    def _write_feedback(self, row: dict[str, Any]) -> None:
        path = self.feedback_dir / f"{row['created_at'][:10]}--{row['skill_id']}--{row['id']}.md"
        path.write_text(
            f"""---
id: {row["id"]}
skill_id: {row["skill_id"]}
verdict: {row["verdict"]}
score_delta: {row["score_delta"]}
created_at: {row["created_at"]}
---

## Reason

{row["reason"]}

## Evidence

{row["evidence"] or "No additional evidence supplied."}
""",
            encoding="utf-8",
        )

    def _sync_index(self) -> None:
        active = [skill for skill in self.data["skills"].values() if skill["status"] == "active"]
        retired = [skill for skill in self.data["skills"].values() if skill["status"] == "retired"]
        active.sort(key=lambda skill: (skill["score"], skill["updated_at"]), reverse=True)
        retired.sort(key=lambda skill: skill["updated_at"], reverse=True)

        def lines_for(skills: list[dict[str, Any]]) -> list[str]:
            if not skills:
                return ["| _none_ | _none_ | _none_ | _none_ | 0 | _none_ | _none_ | _none_ |"]
            return [
                (
                    f"| `{skill['id']}` | {skill['title']} | `{skill['kind']}` | `{ensure_text(skill.get('memory_scope') or infer_memory_scope(skill.get('kind', 'workflow'), skill.get('source_type', 'trajectory'), False))}` | {skill['score']} "
                    f"| {skill.get('validation_status', 'unknown')} ({skill.get('validation_score', 0)}) "
                    f"| `{ensure_text(skill.get('frontier_status') or 'inactive')}` | `{', '.join(skill['applies_to'])}` | {skill['updated_at']} |"
                )
                for skill in skills
            ]

        lines = [
            "# Skill Index",
            "",
            "## Active Skills",
            "",
            "| ID | Title | Kind | Memory | Score | Validation | Frontier | Applies To | Updated |",
            "| --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
            *lines_for(active),
            "",
            "## Retired Skills",
            "",
            "| ID | Title | Kind | Memory | Score | Validation | Frontier | Applies To | Updated |",
            "| --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
            *lines_for(retired),
            "",
        ]
        self.index_path.write_text("\n".join(lines), encoding="utf-8")

def mcp_tools() -> list[dict[str, Any]]:
    base_skill_fields = {
        "skill_id": {"type": "string"},
        "title": {"type": "string"},
        "kind": {"type": "string"},
        "applies_to": {"type": "array", "items": {"type": "string"}},
        "goal": {"type": "string"},
        "problem": {"type": "string"},
        "trigger": {"type": "string"},
        "preconditions": {"type": "string"},
        "fast_path": {"type": "string"},
        "failure_modes": {"type": "string"},
        "evidence": {"type": "string"},
        "important_context": {"type": "string"},
        "observations": {"type": "array", "items": {"type": "string"}},
        "risks": {"type": "array", "items": {"type": "string"}},
        "next_actions": {"type": "array", "items": {"type": "string"}},
        "files": {"type": "array", "items": {"type": "string"}},
        "references": {"type": "array", "items": {"type": "string"}},
        "outcome": {"type": "string"},
        "route_decision": {"type": "string", "enum": sorted(ROUTE_DECISIONS)},
        "route_reason": {"type": "string"},
        "unresolved_questions": {"type": "array", "items": {"type": "string"}},
        "artifact_refs": {"type": "array", "items": {"type": "string"}},
        "assigned_target": {"type": "string"},
        "parent_packet_id": {"type": "string"},
        "hop_count": {"type": "integer"},
        "retry_count": {"type": "integer"},
        "target_skill_id": {"type": "string"},
        "parent_skill_id": {"type": "string"},
        "proposal_action": {"type": "string", "enum": sorted(EVOLUTION_ACTIONS)},
        "proposal_reason": {"type": "string"},
        "failure_summary": {"type": "string"},
        "benchmark": {"type": "string"},
        "iteration": {"type": "integer"},
        "baseline_validation_score": {"type": "integer"},
        "surrogate_verdict": {"type": "string", "enum": sorted(SURROGATE_VERDICTS)},
        "surrogate_summary": {"type": "string"},
        "surrogate_findings": {"type": "array", "items": {"type": "string"}},
        "oracle_verdict": {"type": "string"},
        "verification_mode": {"type": "string", "enum": sorted(VERIFICATION_MODES)},
        "subjective_task": {"type": "string"},
        "subjective_rubric": {"type": "array", "items": {"type": "string"}},
        "baseline_output": {"type": "string"},
        "candidate_output": {"type": "string"},
        "judge_choice": {"type": "string", "enum": ["A", "B", "a", "b"]},
        "judge_summary": {"type": "string"},
        "judge_findings": {"type": "array", "items": {"type": "string"}},
        "history_refs": {"type": "array", "items": {"type": "string"}},
        "program_id": {"type": "string"},
        "parent_program_id": {"type": "string"},
        "http_candidate": {"type": "boolean"},
        "source_type": {"type": "string"},
        "memory_scope": {"type": "string", "enum": sorted(MEMORY_SCOPES)},
        "memory_strategy": {"type": "string", "enum": sorted(MEMORY_STRATEGIES)},
        "update_strategy": {"type": "string", "enum": sorted(UPDATE_STRATEGIES)},
        "durable_facts": {"type": "array", "items": {"type": "string"}},
        "provenance_refs": {"type": "array", "items": {"type": "string"}},
        "retrieval_hints": {"type": "array", "items": {"type": "string"}},
        "canonical_keys": {"type": "array", "items": {"type": "string"}},
        "skip_steps_estimate": {"type": "integer"},
        "confidence": {"type": "string"},
        "last_validated": {"type": "string"},
        "persist": {"type": "boolean"},
        "persist_brief": {"type": "boolean"},
        "persist_packet": {"type": "boolean"},
        "persist_report": {"type": "boolean"},
        "auto_merge": {"type": "boolean"},
        "allow_duplicate": {"type": "boolean"},
        "long_task": {"type": "boolean"},
    }
    return [
        {
            "name": "skill_lookup",
            "description": "Find active reusable skills relevant to a URL pattern, task type, or goal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url_pattern": {"type": "string"},
                    "task_type": {"type": "string"},
                    "goal": {"type": "string"},
                    "context": {"type": "string"},
                    "limit": {"type": "integer"},
                },
            },
        },
        {
            "name": "skill_reflect",
            "description": "Create an executive brief, reducer packet, and normalized skill candidate from a completed task or long-running trajectory.",
            "inputSchema": {
                "type": "object",
                "required": ["title", "kind", "goal", "evidence"],
                "properties": base_skill_fields,
            },
        },
        {
            "name": "skill_validate",
            "description": "Validate a skill candidate or existing skill for privacy, structure, evidence quality, duplicate overlap, and reducer packet routing semantics.",
            "inputSchema": {
                "type": "object",
                "properties": base_skill_fields,
            },
        },
        {
            "name": "skill_pipeline_run",
            "description": "Run reflect -> validate -> curate. Persists briefs, reducer packets, validation reports, and only curates when the route decision is complete.",
            "inputSchema": {
                "type": "object",
                "required": ["title", "kind", "goal", "evidence"],
                "properties": base_skill_fields,
            },
        },
        {
            "name": "skill_propose",
            "description": "Create or update a reusable skill in the local skill library after validation.",
            "inputSchema": {
                "type": "object",
                "required": ["title", "kind", "applies_to", "trigger", "fast_path", "evidence"],
                "properties": base_skill_fields,
            },
        },
        {
            "name": "skill_feedback",
            "description": "Record feedback for an existing skill, update its score, and fold reasoned amendments back into the skill.",
            "inputSchema": {
                "type": "object",
                "required": ["skill_id", "verdict", "reason"],
                "properties": {
                    "skill_id": {"type": "string"},
                    "verdict": {"type": "string", "enum": ["upvote", "downvote", "amend"]},
                    "reason": {"type": "string"},
                    "evidence": {"type": "string"},
                    "score_delta": {"type": "integer"},
                },
            },
        },
        {
            "name": "skill_evolve",
            "description": "Run an EvoSkill-style create-or-edit improvement loop: reflect failure evidence, create a proposal, store surrogate verification, apply the mutation, and update the frontier.",
            "inputSchema": {
                "type": "object",
                "required": ["title", "kind", "goal", "evidence"],
                "properties": base_skill_fields,
            },
        },
        {
            "name": "skill_frontier",
            "description": "List the currently accepted EvoSkill frontier entries, optionally filtered to one skill id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "skill_id": {"type": "string"},
                    "limit": {"type": "integer"},
                },
            },
        },
        {
            "name": "skill_get",
            "description": "Fetch a skill, related briefs, packets, feedback, proposals, surrogate reviews, and evolution runs by skill id.",
            "inputSchema": {
                "type": "object",
                "required": ["skill_id"],
                "properties": {"skill_id": {"type": "string"}},
            },
        },
        {
            "name": "skill_retire",
            "description": "Retire an active skill and move it out of the active registry.",
            "inputSchema": {
                "type": "object",
                "required": ["skill_id", "reason"],
                "properties": {
                    "skill_id": {"type": "string"},
                    "reason": {"type": "string"},
                },
            },
        },
    ]


def tool_result(payload: dict[str, Any], is_error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}], "isError": is_error}


def read_message() -> dict[str, Any] | None:
    content_length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        if line.lower().startswith(b"content-length:"):
            content_length = int(line.split(b":", 1)[1].strip())
    if content_length is None:
        return None
    return json.loads(sys.stdin.buffer.read(content_length).decode("utf-8"))


def write_message(payload: dict[str, Any]) -> None:
    raw = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def run_mcp(workspace: str) -> int:
    store = SkillStore(workspace)
    while True:
        message = read_message()
        if message is None:
            return 0
        method = message.get("method")
        msg_id = message.get("id")
        if method == "initialize":
            write_message(
                {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "ping":
            write_message({"jsonrpc": "2.0", "id": msg_id, "result": {}})
        elif method == "tools/list":
            write_message({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": mcp_tools()}})
        elif method == "tools/call":
            params = message.get("params", {})
            name = str(params.get("name", ""))
            arguments = params.get("arguments", {}) or {}
            if name == "skill_lookup":
                result = store.lookup(
                    str(arguments.get("url_pattern", "")),
                    str(arguments.get("task_type", "")),
                    str(arguments.get("goal", "")),
                    str(arguments.get("context", "")),
                    int(arguments.get("limit", 5)),
                )
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result)})
            elif name == "skill_reflect":
                result = store.reflect(arguments)
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") in {"blocked", "missing"})})
            elif name == "skill_validate":
                result = store.validate(arguments)
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") in {"blocked", "missing"})})
            elif name == "skill_pipeline_run":
                result = store.pipeline_run(arguments)
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") in {"blocked", "missing"})})
            elif name == "skill_propose":
                result = store.propose(arguments)
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") in {"blocked", "missing"})})
            elif name == "skill_feedback":
                result = store.feedback(
                    str(arguments["skill_id"]),
                    str(arguments["verdict"]),
                    str(arguments["reason"]),
                    str(arguments.get("evidence", "")),
                    arguments.get("score_delta"),
                )
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") in {"blocked", "missing"})})
            elif name == "skill_evolve":
                result = store.evolve(arguments)
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") in {"blocked", "missing"})})
            elif name == "skill_frontier":
                result = {"status": "ok", "frontier": store.list_frontier(int(arguments.get("limit", 5)), str(arguments.get("skill_id", "")))}
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result)})
            elif name == "skill_get":
                skill_id = str(arguments["skill_id"])
                skill = store.get_skill(skill_id)
                result = (
                    {
                        "status": "ok",
                        "skill": skill,
                        "feedback": store.list_feedback(skill_id),
                        "briefs": store.list_briefs(skill_id),
                        "packets": store.list_packets(skill_id),
                        "proposals": store.list_proposals(skill_id),
                        "surrogate_reviews": store.list_surrogate_reviews(skill_id),
                        "evolution_runs": store.list_evolution_runs(skill_id),
                        "frontier": store.list_frontier(skill_id=skill_id),
                    }
                    if skill
                    else {"status": "missing", "skill_id": skill_id}
                )
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") == "missing")})
            elif name == "skill_retire":
                result = store.retire(str(arguments["skill_id"]), str(arguments["reason"]))
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": tool_result(result, result.get("status") in {"blocked", "missing"})})
            else:
                write_message({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Unknown tool: {name}"}})
        elif msg_id is not None:
            write_message({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Method not found: {method}"}})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=".")
    sub = parser.add_subparsers(dest="command", required=True)

    mcp_parser = sub.add_parser("mcp")
    mcp_parser.add_argument("--workspace", dest="subcommand_workspace", default=None)

    lookup = sub.add_parser("lookup")
    lookup.add_argument("--url-pattern", default="")
    lookup.add_argument("--task-type", default="")
    lookup.add_argument("--goal", default="")
    lookup.add_argument("--context", default="")
    lookup.add_argument("--limit", type=int, default=5)

    reflect = sub.add_parser("reflect")
    reflect.add_argument("--skill-id")
    reflect.add_argument("--title", required=True)
    reflect.add_argument("--kind", required=True)
    reflect.add_argument("--apply", dest="applies_to", action="append")
    reflect.add_argument("--goal", required=True)
    reflect.add_argument("--problem", default="")
    reflect.add_argument("--trigger", default="")
    reflect.add_argument("--preconditions", default="")
    reflect.add_argument("--fast-path", default="")
    reflect.add_argument("--failure-modes", default="")
    reflect.add_argument("--evidence", required=True)
    reflect.add_argument("--important-context", default="")
    reflect.add_argument("--observation", dest="observations", action="append")
    reflect.add_argument("--risk", dest="risks", action="append")
    reflect.add_argument("--next-action", dest="next_actions", action="append")
    reflect.add_argument("--file", dest="files", action="append")
    reflect.add_argument("--reference", dest="references", action="append")
    reflect.add_argument("--outcome", default="")
    reflect.add_argument("--route-decision", choices=sorted(ROUTE_DECISIONS))
    reflect.add_argument("--route-reason", default="")
    reflect.add_argument("--unresolved-question", dest="unresolved_questions", action="append")
    reflect.add_argument("--artifact-ref", dest="artifact_refs", action="append")
    reflect.add_argument("--assigned-target", default="")
    reflect.add_argument("--parent-packet-id", default="")
    reflect.add_argument("--hop-count", type=int, default=0)
    reflect.add_argument("--retry-count", type=int, default=0)
    reflect.add_argument("--http-candidate", action="store_true")
    reflect.add_argument("--source-type", default="trajectory")
    reflect.add_argument("--memory-scope", choices=sorted(MEMORY_SCOPES))
    reflect.add_argument("--memory-strategy", choices=sorted(MEMORY_STRATEGIES))
    reflect.add_argument("--update-strategy", choices=sorted(UPDATE_STRATEGIES))
    reflect.add_argument("--durable-fact", dest="durable_facts", action="append")
    reflect.add_argument("--provenance-ref", dest="provenance_refs", action="append")
    reflect.add_argument("--retrieval-hint", dest="retrieval_hints", action="append")
    reflect.add_argument("--canonical-key", dest="canonical_keys", action="append")
    reflect.add_argument("--skip-steps-estimate", type=int, default=0)
    reflect.add_argument("--confidence", default="medium")
    reflect.add_argument("--last-validated", default="")
    reflect.add_argument("--long-task", action="store_true")
    reflect.add_argument("--no-persist-packet", dest="persist_packet", action="store_false")
    reflect.add_argument("--persist-brief", action="store_true")
    reflect.set_defaults(persist_brief=True, persist_packet=True)

    validate = sub.add_parser("validate")
    validate.add_argument("--skill-id")
    validate.add_argument("--title")
    validate.add_argument("--kind")
    validate.add_argument("--apply", dest="applies_to", action="append")
    validate.add_argument("--goal", default="")
    validate.add_argument("--problem", default="")
    validate.add_argument("--trigger", default="")
    validate.add_argument("--preconditions", default="")
    validate.add_argument("--fast-path", default="")
    validate.add_argument("--failure-modes", default="")
    validate.add_argument("--evidence", default="")
    validate.add_argument("--important-context", default="")
    validate.add_argument("--observation", dest="observations", action="append")
    validate.add_argument("--risk", dest="risks", action="append")
    validate.add_argument("--next-action", dest="next_actions", action="append")
    validate.add_argument("--file", dest="files", action="append")
    validate.add_argument("--reference", dest="references", action="append")
    validate.add_argument("--outcome", default="")
    validate.add_argument("--route-decision", choices=sorted(ROUTE_DECISIONS))
    validate.add_argument("--route-reason", default="")
    validate.add_argument("--unresolved-question", dest="unresolved_questions", action="append")
    validate.add_argument("--artifact-ref", dest="artifact_refs", action="append")
    validate.add_argument("--assigned-target", default="")
    validate.add_argument("--parent-packet-id", default="")
    validate.add_argument("--hop-count", type=int, default=0)
    validate.add_argument("--retry-count", type=int, default=0)
    validate.add_argument("--http-candidate", action="store_true")
    validate.add_argument("--source-type", default="trajectory")
    validate.add_argument("--memory-scope", choices=sorted(MEMORY_SCOPES))
    validate.add_argument("--memory-strategy", choices=sorted(MEMORY_STRATEGIES))
    validate.add_argument("--update-strategy", choices=sorted(UPDATE_STRATEGIES))
    validate.add_argument("--durable-fact", dest="durable_facts", action="append")
    validate.add_argument("--provenance-ref", dest="provenance_refs", action="append")
    validate.add_argument("--retrieval-hint", dest="retrieval_hints", action="append")
    validate.add_argument("--canonical-key", dest="canonical_keys", action="append")
    validate.add_argument("--skip-steps-estimate", type=int, default=0)
    validate.add_argument("--confidence", default="medium")
    validate.add_argument("--last-validated", default="")
    validate.add_argument("--long-task", action="store_true")
    validate.add_argument("--no-persist-report", dest="persist_report", action="store_false")
    validate.set_defaults(persist_report=True)

    propose = sub.add_parser("propose")
    propose.add_argument("--skill-id")
    propose.add_argument("--title", required=True)
    propose.add_argument("--kind", required=True)
    propose.add_argument("--apply", dest="applies_to", action="append", required=True)
    propose.add_argument("--goal", default="")
    propose.add_argument("--problem", default="")
    propose.add_argument("--trigger", required=True)
    propose.add_argument("--preconditions", default="")
    propose.add_argument("--fast-path", required=True)
    propose.add_argument("--failure-modes", default="")
    propose.add_argument("--evidence", required=True)
    propose.add_argument("--important-context", default="")
    propose.add_argument("--observation", dest="observations", action="append")
    propose.add_argument("--risk", dest="risks", action="append")
    propose.add_argument("--next-action", dest="next_actions", action="append")
    propose.add_argument("--file", dest="files", action="append")
    propose.add_argument("--reference", dest="references", action="append")
    propose.add_argument("--outcome", default="")
    propose.add_argument("--route-decision", choices=sorted(ROUTE_DECISIONS))
    propose.add_argument("--route-reason", default="")
    propose.add_argument("--unresolved-question", dest="unresolved_questions", action="append")
    propose.add_argument("--artifact-ref", dest="artifact_refs", action="append")
    propose.add_argument("--assigned-target", default="")
    propose.add_argument("--parent-packet-id", default="")
    propose.add_argument("--hop-count", type=int, default=0)
    propose.add_argument("--retry-count", type=int, default=0)
    propose.add_argument("--http-candidate", action="store_true")
    propose.add_argument("--source-type", default="trajectory")
    propose.add_argument("--memory-scope", choices=sorted(MEMORY_SCOPES))
    propose.add_argument("--memory-strategy", choices=sorted(MEMORY_STRATEGIES))
    propose.add_argument("--update-strategy", choices=sorted(UPDATE_STRATEGIES))
    propose.add_argument("--durable-fact", dest="durable_facts", action="append")
    propose.add_argument("--provenance-ref", dest="provenance_refs", action="append")
    propose.add_argument("--retrieval-hint", dest="retrieval_hints", action="append")
    propose.add_argument("--canonical-key", dest="canonical_keys", action="append")
    propose.add_argument("--skip-steps-estimate", type=int, default=0)
    propose.add_argument("--confidence", default="medium")
    propose.add_argument("--last-validated", default="")
    propose.add_argument("--long-task", action="store_true")
    propose.add_argument("--allow-duplicate", action="store_true")
    propose.add_argument("--no-persist-report", dest="persist_report", action="store_false")
    propose.set_defaults(persist_report=True)

    pipeline = sub.add_parser("pipeline-run")
    pipeline.add_argument("--skill-id")
    pipeline.add_argument("--title", required=True)
    pipeline.add_argument("--kind", required=True)
    pipeline.add_argument("--apply", dest="applies_to", action="append")
    pipeline.add_argument("--goal", required=True)
    pipeline.add_argument("--problem", default="")
    pipeline.add_argument("--trigger", default="")
    pipeline.add_argument("--preconditions", default="")
    pipeline.add_argument("--fast-path", default="")
    pipeline.add_argument("--failure-modes", default="")
    pipeline.add_argument("--evidence", required=True)
    pipeline.add_argument("--important-context", default="")
    pipeline.add_argument("--observation", dest="observations", action="append")
    pipeline.add_argument("--risk", dest="risks", action="append")
    pipeline.add_argument("--next-action", dest="next_actions", action="append")
    pipeline.add_argument("--file", dest="files", action="append")
    pipeline.add_argument("--reference", dest="references", action="append")
    pipeline.add_argument("--outcome", default="")
    pipeline.add_argument("--route-decision", choices=sorted(ROUTE_DECISIONS))
    pipeline.add_argument("--route-reason", default="")
    pipeline.add_argument("--unresolved-question", dest="unresolved_questions", action="append")
    pipeline.add_argument("--artifact-ref", dest="artifact_refs", action="append")
    pipeline.add_argument("--assigned-target", default="")
    pipeline.add_argument("--parent-packet-id", default="")
    pipeline.add_argument("--hop-count", type=int, default=0)
    pipeline.add_argument("--retry-count", type=int, default=0)
    pipeline.add_argument("--http-candidate", action="store_true")
    pipeline.add_argument("--source-type", default="trajectory")
    pipeline.add_argument("--memory-scope", choices=sorted(MEMORY_SCOPES))
    pipeline.add_argument("--memory-strategy", choices=sorted(MEMORY_STRATEGIES))
    pipeline.add_argument("--update-strategy", choices=sorted(UPDATE_STRATEGIES))
    pipeline.add_argument("--durable-fact", dest="durable_facts", action="append")
    pipeline.add_argument("--provenance-ref", dest="provenance_refs", action="append")
    pipeline.add_argument("--retrieval-hint", dest="retrieval_hints", action="append")
    pipeline.add_argument("--canonical-key", dest="canonical_keys", action="append")
    pipeline.add_argument("--skip-steps-estimate", type=int, default=0)
    pipeline.add_argument("--confidence", default="medium")
    pipeline.add_argument("--last-validated", default="")
    pipeline.add_argument("--long-task", action="store_true")
    pipeline.add_argument("--no-persist", dest="persist", action="store_false")
    pipeline.add_argument("--no-persist-brief", dest="persist_brief", action="store_false")
    pipeline.add_argument("--no-persist-packet", dest="persist_packet", action="store_false")
    pipeline.add_argument("--no-persist-report", dest="persist_report", action="store_false")
    pipeline.add_argument("--no-auto-merge", dest="auto_merge", action="store_false")
    pipeline.add_argument("--allow-duplicate", action="store_true")
    pipeline.set_defaults(persist=True, persist_brief=True, persist_packet=True, persist_report=True, auto_merge=True)

    evolve = sub.add_parser("evolve")
    evolve.add_argument("--skill-id")
    evolve.add_argument("--target-skill-id", default="")
    evolve.add_argument("--parent-skill-id", default="")
    evolve.add_argument("--title", required=True)
    evolve.add_argument("--kind", required=True)
    evolve.add_argument("--apply", dest="applies_to", action="append")
    evolve.add_argument("--goal", required=True)
    evolve.add_argument("--problem", default="")
    evolve.add_argument("--trigger", default="")
    evolve.add_argument("--preconditions", default="")
    evolve.add_argument("--fast-path", default="")
    evolve.add_argument("--failure-modes", default="")
    evolve.add_argument("--evidence", required=True)
    evolve.add_argument("--important-context", default="")
    evolve.add_argument("--observation", dest="observations", action="append")
    evolve.add_argument("--risk", dest="risks", action="append")
    evolve.add_argument("--next-action", dest="next_actions", action="append")
    evolve.add_argument("--file", dest="files", action="append")
    evolve.add_argument("--reference", dest="references", action="append")
    evolve.add_argument("--outcome", default="")
    evolve.add_argument("--route-decision", choices=sorted(ROUTE_DECISIONS))
    evolve.add_argument("--route-reason", default="")
    evolve.add_argument("--unresolved-question", dest="unresolved_questions", action="append")
    evolve.add_argument("--artifact-ref", dest="artifact_refs", action="append")
    evolve.add_argument("--assigned-target", default="")
    evolve.add_argument("--parent-packet-id", default="")
    evolve.add_argument("--hop-count", type=int, default=0)
    evolve.add_argument("--retry-count", type=int, default=0)
    evolve.add_argument("--proposal-action", choices=sorted(EVOLUTION_ACTIONS))
    evolve.add_argument("--proposal-reason", default="")
    evolve.add_argument("--failure-summary", default="")
    evolve.add_argument("--benchmark", default="")
    evolve.add_argument("--iteration", type=int, default=None)
    evolve.add_argument("--baseline-validation-score", type=int, default=None)
    evolve.add_argument("--surrogate-verdict", choices=sorted(SURROGATE_VERDICTS))
    evolve.add_argument("--surrogate-summary", default="")
    evolve.add_argument("--surrogate-finding", dest="surrogate_findings", action="append")
    evolve.add_argument("--oracle-verdict", default="")
    evolve.add_argument("--verification-mode", choices=sorted(VERIFICATION_MODES))
    evolve.add_argument("--subjective-task", default="")
    evolve.add_argument("--subjective-rubric", action="append")
    evolve.add_argument("--baseline-output", default="")
    evolve.add_argument("--candidate-output", default="")
    evolve.add_argument("--judge-choice", default="")
    evolve.add_argument("--judge-summary", default="")
    evolve.add_argument("--judge-finding", dest="judge_findings", action="append")
    evolve.add_argument("--history-ref", dest="history_refs", action="append")
    evolve.add_argument("--program-id", default="")
    evolve.add_argument("--parent-program-id", default="")
    evolve.add_argument("--http-candidate", action="store_true")
    evolve.add_argument("--source-type", default="trajectory")
    evolve.add_argument("--memory-scope", choices=sorted(MEMORY_SCOPES))
    evolve.add_argument("--memory-strategy", choices=sorted(MEMORY_STRATEGIES))
    evolve.add_argument("--update-strategy", choices=sorted(UPDATE_STRATEGIES))
    evolve.add_argument("--durable-fact", dest="durable_facts", action="append")
    evolve.add_argument("--provenance-ref", dest="provenance_refs", action="append")
    evolve.add_argument("--retrieval-hint", dest="retrieval_hints", action="append")
    evolve.add_argument("--canonical-key", dest="canonical_keys", action="append")
    evolve.add_argument("--skip-steps-estimate", type=int, default=0)
    evolve.add_argument("--confidence", default="medium")
    evolve.add_argument("--last-validated", default="")
    evolve.add_argument("--long-task", action="store_true")
    evolve.add_argument("--no-persist-packet", dest="persist_packet", action="store_false")
    evolve.add_argument("--no-persist-report", dest="persist_report", action="store_false")
    evolve.set_defaults(persist_packet=True, persist_report=True)

    feedback = sub.add_parser("feedback")
    feedback.add_argument("--skill-id", required=True)
    feedback.add_argument("--verdict", choices=["upvote", "downvote", "amend"], required=True)
    feedback.add_argument("--reason", required=True)
    feedback.add_argument("--evidence", default="")
    feedback.add_argument("--score-delta", type=int)

    frontier = sub.add_parser("frontier")
    frontier.add_argument("--skill-id", default="")
    frontier.add_argument("--limit", type=int, default=5)

    retire = sub.add_parser("retire")
    retire.add_argument("--skill-id", required=True)
    retire.add_argument("--reason", required=True)

    get_cmd = sub.add_parser("get")
    get_cmd.add_argument("--skill-id", required=True)

    sub.add_parser("sync-index")

    args = parser.parse_args(argv)

    if args.command == "mcp":
        return run_mcp(args.subcommand_workspace or args.workspace)

    store = SkillStore(args.workspace)
    payload = vars(args)
    command = payload.pop("command")
    payload.pop("workspace", None)

    if command == "lookup":
        result = store.lookup(payload["url_pattern"], payload["task_type"], payload["goal"], payload["context"], payload["limit"])
    elif command == "reflect":
        result = store.reflect(payload)
    elif command == "validate":
        result = store.validate(payload)
    elif command == "propose":
        result = store.propose(payload)
    elif command == "pipeline-run":
        result = store.pipeline_run(payload)
    elif command == "evolve":
        result = store.evolve(payload)
    elif command == "feedback":
        result = store.feedback(payload["skill_id"], payload["verdict"], payload["reason"], payload["evidence"], payload["score_delta"])
    elif command == "frontier":
        result = {"status": "ok", "frontier": store.list_frontier(payload["limit"], payload["skill_id"])}
    elif command == "retire":
        result = store.retire(payload["skill_id"], payload["reason"])
    elif command == "get":
        skill = store.get_skill(payload["skill_id"])
        result = {
            "status": "ok",
            "skill": skill,
            "feedback": store.list_feedback(payload["skill_id"]),
            "briefs": store.list_briefs(payload["skill_id"]),
            "packets": store.list_packets(payload["skill_id"]),
            "proposals": store.list_proposals(payload["skill_id"]),
            "surrogate_reviews": store.list_surrogate_reviews(payload["skill_id"]),
            "evolution_runs": store.list_evolution_runs(payload["skill_id"]),
            "frontier": store.list_frontier(skill_id=payload["skill_id"]),
        } if skill else {"status": "missing", "skill_id": payload["skill_id"]}
    else:
        store._sync_index()
        result = {"status": "ok", "index_path": str(store.index_path)}

    print(json.dumps(result, indent=2))
    return 0 if result.get("status") not in {"blocked", "missing"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
