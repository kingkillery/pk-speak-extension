#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from llm_wiki_skill_mcp import SkillStore, ensure_list, ensure_text, merge_text, slugify, unique_list, utc_now


DEFAULT_KIND = "workflow"


def parse_timestamp(value: str) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    normalized = value.strip().replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def ensure_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def ensure_int(value: Any, default: int = 0) -> int:
    if value in (None, ""):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def load_json_payload(path_or_dash: str) -> dict[str, Any]:
    if path_or_dash == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(path_or_dash).read_text(encoding="utf-8")
    payload = json.loads(raw or "{}")
    if not isinstance(payload, dict):
        raise SystemExit("Failure payload must decode to a JSON object.")
    return payload


def normalize_text_for_fingerprint(value: str) -> str:
    return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in value).split()[:20])


def sanitize_evidence_for_skill(value: str) -> str:
    cleaned: list[str] = []
    for line in ensure_text(value).splitlines():
        lowered = line.strip().lower()
        if lowered.startswith("run identity:"):
            continue
        cleaned.append(line)
    return "\n".join(cleaned).strip()


class FailureCollector:
    def __init__(self, workspace: str | Path) -> None:
        self.workspace = Path(workspace).resolve()
        config = self._load_config()
        skill_cfg = config.get("skills", {})
        pipeline_cfg = skill_cfg.get("pipeline", {})

        self.failure_dir = self.workspace / pipeline_cfg.get("failure_dir", ".llm-wiki/skill-pipeline/failures")
        self.failure_event_dir = self.workspace / pipeline_cfg.get("failure_event_dir", ".llm-wiki/skill-pipeline/failures/events")
        self.failure_cluster_dir = self.workspace / pipeline_cfg.get("failure_cluster_dir", ".llm-wiki/skill-pipeline/failures/clusters")
        self.failure_benchmark_dir = self.workspace / pipeline_cfg.get("failure_benchmark_dir", ".llm-wiki/skill-pipeline/failures/benchmarks")
        self.promotion_threshold = max(1, int(pipeline_cfg.get("failure_promotion_threshold", 3)))
        self.promotion_window_hours = max(1, int(pipeline_cfg.get("failure_promotion_window_hours", 168)))
        self.promotion_min_unique_sessions = max(1, int(pipeline_cfg.get("failure_promotion_min_unique_sessions", 2)))
        self.failure_auto_promote = bool(pipeline_cfg.get("failure_auto_promote", True))

        for path in [
            self.failure_dir,
            self.failure_event_dir,
            self.failure_cluster_dir,
            self.failure_benchmark_dir,
        ]:
            path.mkdir(parents=True, exist_ok=True)

    def _load_config(self) -> dict[str, Any]:
        config_path = self.workspace / ".llm-wiki" / "config.json"
        if config_path.exists():
            return json.loads(config_path.read_text(encoding="utf-8"))
        return {}

    def _relative(self, path: Path) -> str:
        return path.relative_to(self.workspace).as_posix()

    def _list_event_files(self) -> list[Path]:
        return sorted(self.failure_event_dir.glob("*.json"))

    def _load_event(self, path: Path) -> dict[str, Any]:
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload.setdefault("event_path", self._relative(path))
        return payload

    def _write_event(self, event: dict[str, Any]) -> str:
        filename = f"{event['created_at'][:10]}--{event['fingerprint']}--{event['id']}.json"
        path = self.failure_event_dir / filename
        path.write_text(json.dumps(event, indent=2) + "\n", encoding="utf-8")
        return self._relative(path)

    def _write_cluster(self, cluster: dict[str, Any]) -> str:
        filename = f"{cluster['fingerprint']}.json"
        path = self.failure_cluster_dir / filename
        path.write_text(json.dumps(cluster, indent=2) + "\n", encoding="utf-8")
        return self._relative(path)

    def _write_benchmark(self, benchmark: dict[str, Any]) -> str:
        filename = f"{benchmark['created_at'][:10]}--{benchmark['fingerprint']}--{benchmark['id']}.json"
        path = self.failure_benchmark_dir / filename
        path.write_text(json.dumps(benchmark, indent=2) + "\n", encoding="utf-8")
        return self._relative(path)

    def _build_fingerprint(self, candidate: dict[str, Any]) -> str:
        hint = ensure_text(candidate.get("fingerprint_hint"))
        if hint:
            return slugify(hint)
        seed = {
            "skill_id": ensure_text(candidate.get("target_skill_id") or candidate.get("skill_id")),
            "kind": ensure_text(candidate.get("kind") or DEFAULT_KIND).lower(),
            "goal": normalize_text_for_fingerprint(ensure_text(candidate.get("goal") or candidate.get("problem") or candidate.get("title"))),
            "applies_to": sorted(ensure_list(candidate.get("applies_to")) or [ensure_text(candidate.get("url_pattern"))]),
            "error_class": ensure_text(candidate.get("error_class")).lower(),
            "route_decision": ensure_text(candidate.get("route_decision")).lower(),
            "tool_name": ensure_text(candidate.get("tool_name")).lower(),
        }
        digest = hashlib.sha1(json.dumps(seed, sort_keys=True).encode("utf-8")).hexdigest()[:12]
        prefix = slugify(
            "-".join(
                part
                for part in [
                    seed["skill_id"],
                    seed["kind"],
                    seed["error_class"],
                    seed["tool_name"],
                    seed["route_decision"],
                ]
                if part
            )
        )[:40]
        return f"{prefix}-{digest}" if prefix else digest

    def _build_evidence(self, payload: dict[str, Any]) -> str:
        evidence = ensure_text(payload.get("evidence"))
        fragments = []
        if ensure_text(payload.get("error_class")):
            fragments.append(f"Error class: {ensure_text(payload.get('error_class'))}")
        if ensure_text(payload.get("error_message")):
            fragments.append(f"Error message: {ensure_text(payload.get('error_message'))}")
        if ensure_text(payload.get("stderr")):
            fragments.append(f"stderr:\n{ensure_text(payload.get('stderr'))}")
        observations = ensure_list(payload.get("observations"))
        if observations:
            fragments.append("Observed failure behavior:\n" + "\n".join(f"- {item}" for item in observations))
        tool_sequence = ensure_list(payload.get("tool_sequence"))
        if tool_sequence:
            fragments.append("Tool sequence:\n" + "\n".join(f"- {item}" for item in tool_sequence))
        if ensure_text(payload.get("trace_id")) or ensure_text(payload.get("session_id")):
            fragments.append(
                "Run identity: "
                + ", ".join(
                    part
                    for part in [
                        f"trace={ensure_text(payload.get('trace_id'))}" if ensure_text(payload.get("trace_id")) else "",
                        f"session={ensure_text(payload.get('session_id'))}" if ensure_text(payload.get("session_id")) else "",
                    ]
                    if part
                )
            )
        for fragment in fragments:
            evidence = merge_text(evidence, fragment)
        return evidence

    def _normalize_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = (
            ensure_text(payload.get("title"))
            or ensure_text(payload.get("failure_summary"))
            or ensure_text(payload.get("goal"))
            or ensure_text(payload.get("error_class"))
            or "Recorded failure"
        )
        kind = ensure_text(payload.get("kind") or payload.get("task_type") or DEFAULT_KIND).lower()
        applies_to = ensure_list(payload.get("applies_to"))
        if not applies_to and ensure_text(payload.get("url_pattern")):
            applies_to = [ensure_text(payload.get("url_pattern"))]

        event: dict[str, Any] = {
            "id": f"failure-{uuid.uuid4().hex[:12]}",
            "created_at": ensure_text(payload.get("created_at")) or utc_now(),
            "title": title,
            "kind": kind,
            "goal": ensure_text(payload.get("goal") or payload.get("problem") or title),
            "problem": ensure_text(payload.get("problem")),
            "trigger": ensure_text(payload.get("trigger")),
            "applies_to": applies_to,
            "failure_summary": ensure_text(payload.get("failure_summary") or payload.get("error_message") or title),
            "evidence": self._build_evidence(payload),
            "skill_id": ensure_text(payload.get("skill_id")),
            "target_skill_id": ensure_text(payload.get("target_skill_id") or payload.get("skill_id")),
            "parent_skill_id": ensure_text(payload.get("parent_skill_id")),
            "trace_id": ensure_text(payload.get("trace_id")),
            "session_id": ensure_text(payload.get("session_id")),
            "agent": ensure_text(payload.get("agent")),
            "model": ensure_text(payload.get("model")),
            "tool_name": ensure_text(payload.get("tool_name")),
            "tool_sequence": ensure_list(payload.get("tool_sequence")),
            "error_class": ensure_text(payload.get("error_class")),
            "error_message": ensure_text(payload.get("error_message")),
            "stderr": ensure_text(payload.get("stderr")),
            "route_decision": ensure_text(payload.get("route_decision")),
            "route_reason": ensure_text(payload.get("route_reason")),
            "benchmark": ensure_text(payload.get("benchmark")),
            "artifact_refs": unique_list(ensure_list(payload.get("artifact_refs"))),
            "references": unique_list(ensure_list(payload.get("references"))),
            "observations": unique_list(ensure_list(payload.get("observations"))),
            "risks": unique_list(ensure_list(payload.get("risks"))),
            "tags": unique_list(ensure_list(payload.get("tags"))),
            "source_type": ensure_text(payload.get("source_type") or "runtime_failure"),
            "user_verdict": ensure_text(payload.get("user_verdict")),
            "oracle_verdict": ensure_text(payload.get("oracle_verdict")),
            "surrogate_verdict": ensure_text(payload.get("surrogate_verdict")),
            "verification_mode": ensure_text(payload.get("verification_mode")),
            "subjective_task": ensure_text(payload.get("subjective_task")),
            "subjective_rubric": unique_list(ensure_list(payload.get("subjective_rubric"))),
            "baseline_output": ensure_text(payload.get("baseline_output")),
            "candidate_output": ensure_text(payload.get("candidate_output")),
            "judge_choice": ensure_text(payload.get("judge_choice")),
            "judge_summary": ensure_text(payload.get("judge_summary")),
            "judge_findings": unique_list(ensure_list(payload.get("judge_findings"))),
            "proposal_action": ensure_text(payload.get("proposal_action")),
            "proposal_reason": ensure_text(payload.get("proposal_reason")),
            "fingerprint_hint": ensure_text(payload.get("fingerprint_hint")),
            "promotion_status": ensure_text(payload.get("promotion_status") or "pending"),
            "auto_promote": ensure_bool(payload.get("auto_promote"), self.failure_auto_promote),
        }
        event["fingerprint"] = self._build_fingerprint(event)
        return event

    def _session_key(self, event: dict[str, Any]) -> str:
        return (
            ensure_text(event.get("session_id"))
            or ensure_text(event.get("trace_id"))
            or ensure_text(event.get("id"))
        )

    def list_events(self, fingerprint: str = "", include_promoted: bool = True) -> list[dict[str, Any]]:
        events = [self._load_event(path) for path in self._list_event_files()]
        if fingerprint:
            events = [event for event in events if event.get("fingerprint") == fingerprint]
        if not include_promoted:
            events = [event for event in events if event.get("promotion_status") != "promoted"]
        events.sort(key=lambda item: item.get("created_at", ""), reverse=True)
        return events

    def record(self, payload: dict[str, Any]) -> dict[str, Any]:
        event = self._normalize_event(payload)
        event_path = self._write_event(event)
        cluster = self.refresh_cluster(event["fingerprint"])
        return {
            "status": "recorded",
            "event": event,
            "event_path": event_path,
            "cluster": cluster,
        }

    def refresh_cluster(self, fingerprint: str) -> dict[str, Any]:
        events = self.list_events(fingerprint=fingerprint, include_promoted=True)
        if not events:
            return {"status": "missing", "fingerprint": fingerprint}
        event_paths = [event["event_path"] for event in events if event.get("event_path")]
        latest = events[0]
        sessions = sorted({self._session_key(event) for event in events})
        skill_ids = unique_list(
            [
                ensure_text(event.get("target_skill_id") or event.get("skill_id"))
                for event in events
                if ensure_text(event.get("target_skill_id") or event.get("skill_id"))
            ]
        )
        error_counts = Counter(
            ensure_text(event.get("error_class") or "unknown")
            for event in events
        )
        promoted_events = [event for event in events if event.get("promotion_status") == "promoted"]
        cluster = {
            "id": f"cluster-{fingerprint}",
            "fingerprint": fingerprint,
            "title": latest["title"],
            "kind": latest["kind"],
            "goal": latest["goal"],
            "applies_to": latest.get("applies_to", []),
            "count": len(events),
            "unique_sessions": len(sessions),
            "session_keys": sessions,
            "skill_ids": skill_ids,
            "latest_failure_at": latest["created_at"],
            "error_classes": dict(error_counts),
            "event_refs": event_paths,
            "promotion_status": "promoted" if promoted_events else "pending",
            "last_promotion_at": ensure_text(promoted_events[0].get("promoted_at")) if promoted_events else "",
            "updated_at": utc_now(),
        }
        cluster_path = self._write_cluster(cluster)
        cluster["cluster_path"] = cluster_path
        return cluster

    def _cluster_is_eligible(self, cluster: dict[str, Any], events: list[dict[str, Any]], force: bool) -> bool:
        if force:
            return True
        if not any(ensure_bool(event.get("auto_promote"), self.failure_auto_promote) for event in events):
            return False
        if len(events) < self.promotion_threshold:
            return False
        pending_sessions = sorted({self._session_key(event) for event in events})
        if len(pending_sessions) < self.promotion_min_unique_sessions:
            return False
        return True

    def _recent_pending_events(self, fingerprint: str = "") -> dict[str, list[dict[str, Any]]]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self.promotion_window_hours)
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for event in self.list_events(fingerprint=fingerprint, include_promoted=False):
            created_at = parse_timestamp(ensure_text(event.get("created_at")))
            if created_at < cutoff:
                continue
            grouped[event["fingerprint"]].append(event)
        return grouped

    def _build_evolve_payload(self, cluster: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
        latest = events[0]
        target_skill_id = ensure_text(latest.get("target_skill_id") or latest.get("skill_id"))
        proposal_action = ensure_text(latest.get("proposal_action")).lower()
        if not proposal_action:
            proposal_action = "edit_skill" if target_skill_id else "create_skill"
        evidence = ""
        for idx, event in enumerate(reversed(events[:5]), start=1):
            summary = ensure_text(event.get("failure_summary"))
            error_class = ensure_text(event.get("error_class"))
            line = f"- Failure example {idx}:"
            if error_class:
                line += f" {error_class}:"
            if summary:
                line += f" {summary}"
            evidence = merge_text(evidence, line)
            event_evidence = sanitize_evidence_for_skill(ensure_text(event.get("evidence")))
            if event_evidence:
                evidence = merge_text(evidence, event_evidence)
        benchmark = ensure_text(latest.get("benchmark")) or f"failure-cluster:{cluster['fingerprint']}"
        return {
            "title": latest["title"],
            "kind": latest["kind"],
            "applies_to": latest.get("applies_to", []),
            "goal": latest["goal"],
            "problem": latest.get("problem", ""),
            "trigger": latest.get("trigger", ""),
            "failure_modes": "\n".join(f"- {item}" for item in unique_list([event.get("failure_summary", "") for event in events if event.get("failure_summary")])),
            "evidence": evidence,
            "observations": unique_list([item for event in events for item in ensure_list(event.get("observations"))]),
            "risks": unique_list([item for event in events for item in ensure_list(event.get("risks"))]),
            "references": unique_list([item for event in events for item in ensure_list(event.get("references"))]),
            "artifact_refs": unique_list([item for event in events for item in ensure_list(event.get("artifact_refs"))]),
            "route_decision": "complete",
            "route_reason": f"Repeated failure cluster {cluster['fingerprint']} reached promotion threshold.",
            "failure_summary": f"Repeated failure cluster {cluster['fingerprint']} triggered {cluster['count']} times across {cluster['unique_sessions']} sessions.",
            "benchmark": benchmark,
            "history_refs": [event["event_path"] for event in events if event.get("event_path")],
            "program_id": cluster["id"],
            "parent_program_id": "",
            "proposal_action": proposal_action,
            "proposal_reason": ensure_text(latest.get("proposal_reason")) or "Promote repeated failure evidence into an EvoSkill mutation.",
            "target_skill_id": target_skill_id,
            "skill_id": ensure_text(latest.get("skill_id")),
            "parent_skill_id": ensure_text(latest.get("parent_skill_id")),
            "oracle_verdict": ensure_text(latest.get("oracle_verdict")),
            "surrogate_verdict": ensure_text(latest.get("surrogate_verdict")),
            "verification_mode": ensure_text(latest.get("verification_mode")),
            "subjective_task": ensure_text(latest.get("subjective_task")),
            "subjective_rubric": unique_list(ensure_list(latest.get("subjective_rubric"))),
            "baseline_output": ensure_text(latest.get("baseline_output")),
            "candidate_output": ensure_text(latest.get("candidate_output")),
            "judge_choice": ensure_text(latest.get("judge_choice")),
            "judge_summary": ensure_text(latest.get("judge_summary")),
            "judge_findings": unique_list(ensure_list(latest.get("judge_findings"))),
            "surrogate_findings": [
                f"Observed {cluster['count']} failures across {cluster['unique_sessions']} sessions.",
                f"Top error classes: {', '.join(f'{name} x{count}' for name, count in Counter(ensure_text(event.get('error_class') or 'unknown') for event in events).most_common(3))}",
            ],
        }

    def _rewrite_event(self, path: Path, event: dict[str, Any]) -> None:
        path.write_text(json.dumps(event, indent=2) + "\n", encoding="utf-8")

    def promote(self, fingerprint: str = "", limit: int = 10, force: bool = False) -> dict[str, Any]:
        grouped = self._recent_pending_events(fingerprint=fingerprint)
        promotions: list[dict[str, Any]] = []
        store = SkillStore(self.workspace)
        cluster_rows: list[dict[str, Any]] = []
        for fp, events in grouped.items():
            events.sort(key=lambda item: item.get("created_at", ""), reverse=True)
            cluster = self.refresh_cluster(fp)
            cluster_rows.append(cluster)
            if not self._cluster_is_eligible(cluster, events, force):
                continue
            evolve_payload = self._build_evolve_payload(cluster, events)
            evolve_result = store.evolve(evolve_payload)
            benchmark = {
                "id": f"benchmark-{uuid.uuid4().hex[:10]}",
                "fingerprint": fp,
                "cluster_id": cluster["id"],
                "created_at": utc_now(),
                "count": cluster["count"],
                "unique_sessions": cluster["unique_sessions"],
                "event_refs": [event["event_path"] for event in events if event.get("event_path")],
                "evolve_payload": evolve_payload,
                "evolve_status": evolve_result["status"],
                "evolution_run_path": ensure_text(evolve_result.get("evolution_run_path")),
                "proposal_path": ensure_text(evolve_result.get("proposal_path")),
                "surrogate_review_path": ensure_text(evolve_result.get("surrogate_review_path")),
                "frontier_status": ensure_text((evolve_result.get("frontier_entry") or {}).get("status")),
            }
            benchmark_path = self._write_benchmark(benchmark)
            for event in events:
                event_path = self.workspace / event["event_path"]
                event["promotion_status"] = "promoted"
                event["promoted_at"] = benchmark["created_at"]
                event["promotion_id"] = benchmark["id"]
                event["benchmark_path"] = benchmark_path
                event["evolution_run_path"] = benchmark["evolution_run_path"]
                self._rewrite_event(event_path, event)
            refreshed_cluster = self.refresh_cluster(fp)
            promotions.append(
                {
                    "fingerprint": fp,
                    "cluster": refreshed_cluster,
                    "benchmark": benchmark,
                    "benchmark_path": benchmark_path,
                    "evolve_result": evolve_result,
                }
            )
            if len(promotions) >= max(1, limit):
                break
        return {
            "status": "ok",
            "promoted": promotions,
            "eligible_clusters": [cluster for cluster in cluster_rows if cluster["count"] >= self.promotion_threshold],
        }


def build_record_payload(args: argparse.Namespace) -> dict[str, Any]:
    payload = load_json_payload(args.json_path) if args.json_path else {}
    payload.update(
        {
            "title": args.title or payload.get("title", ""),
            "kind": args.kind or payload.get("kind", ""),
            "goal": args.goal or payload.get("goal", ""),
            "problem": args.problem or payload.get("problem", ""),
            "trigger": args.trigger or payload.get("trigger", ""),
            "evidence": args.evidence or payload.get("evidence", ""),
            "skill_id": args.skill_id or payload.get("skill_id", ""),
            "target_skill_id": args.target_skill_id or payload.get("target_skill_id", ""),
            "url_pattern": args.url_pattern or payload.get("url_pattern", ""),
            "error_class": args.error_class or payload.get("error_class", ""),
            "error_message": args.error_message or payload.get("error_message", ""),
            "stderr": args.stderr or payload.get("stderr", ""),
            "trace_id": args.trace_id or payload.get("trace_id", ""),
            "session_id": args.session_id or payload.get("session_id", ""),
            "agent": args.agent or payload.get("agent", ""),
            "model": args.model or payload.get("model", ""),
            "tool_name": args.tool_name or payload.get("tool_name", ""),
            "route_decision": args.route_decision or payload.get("route_decision", ""),
            "route_reason": args.route_reason or payload.get("route_reason", ""),
            "benchmark": args.benchmark or payload.get("benchmark", ""),
            "verification_mode": args.verification_mode or payload.get("verification_mode", ""),
            "subjective_task": args.subjective_task or payload.get("subjective_task", ""),
            "subjective_rubric": args.subjective_rubric or payload.get("subjective_rubric", []),
            "baseline_output": args.baseline_output or payload.get("baseline_output", ""),
            "candidate_output": args.candidate_output or payload.get("candidate_output", ""),
            "judge_choice": args.judge_choice or payload.get("judge_choice", ""),
            "judge_summary": args.judge_summary or payload.get("judge_summary", ""),
            "judge_findings": args.judge_findings or payload.get("judge_findings", []),
            "applies_to": args.applies_to or payload.get("applies_to", []),
            "tool_sequence": args.tool_sequence or payload.get("tool_sequence", []),
            "observations": args.observations or payload.get("observations", []),
            "artifact_refs": args.artifact_refs or payload.get("artifact_refs", []),
            "references": args.references or payload.get("references", []),
            "tags": args.tags or payload.get("tags", []),
            "auto_promote": payload.get("auto_promote", not args.no_auto_promote),
            "fingerprint_hint": args.fingerprint_hint or payload.get("fingerprint_hint", ""),
        }
    )
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Record repeated runtime failures and promote eligible clusters into skill_evolve.")
    parser.add_argument("--workspace", default=".", help="Workspace root that contains .llm-wiki/config.json")
    sub = parser.add_subparsers(dest="command", required=True)

    record = sub.add_parser("record", help="Record one failure event.")
    record.add_argument("--json-path", help="Path to a JSON object or '-' to read JSON from stdin.")
    record.add_argument("--title", default="")
    record.add_argument("--kind", default="")
    record.add_argument("--goal", default="")
    record.add_argument("--problem", default="")
    record.add_argument("--trigger", default="")
    record.add_argument("--evidence", default="")
    record.add_argument("--skill-id", default="")
    record.add_argument("--target-skill-id", default="")
    record.add_argument("--url-pattern", default="")
    record.add_argument("--error-class", default="")
    record.add_argument("--error-message", default="")
    record.add_argument("--stderr", default="")
    record.add_argument("--trace-id", default="")
    record.add_argument("--session-id", default="")
    record.add_argument("--agent", default="")
    record.add_argument("--model", default="")
    record.add_argument("--tool-name", default="")
    record.add_argument("--route-decision", default="")
    record.add_argument("--route-reason", default="")
    record.add_argument("--benchmark", default="")
    record.add_argument("--verification-mode", default="")
    record.add_argument("--subjective-task", default="")
    record.add_argument("--subjective-rubric", action="append", default=[])
    record.add_argument("--baseline-output", default="")
    record.add_argument("--candidate-output", default="")
    record.add_argument("--judge-choice", default="")
    record.add_argument("--judge-summary", default="")
    record.add_argument("--judge-findings", action="append", default=[])
    record.add_argument("--fingerprint-hint", default="")
    record.add_argument("--no-auto-promote", action="store_true")
    record.add_argument("--applies-to", action="append", default=[])
    record.add_argument("--tool-sequence", action="append", default=[])
    record.add_argument("--observations", action="append", default=[])
    record.add_argument("--artifact-refs", action="append", default=[])
    record.add_argument("--references", action="append", default=[])
    record.add_argument("--tags", action="append", default=[])

    ingest = sub.add_parser("ingest", help="Record a failure event, then try to promote matching clusters immediately.")
    for action in record._actions[1:]:
        if action.dest not in {"help"}:
            ingest._add_action(action)
    ingest.add_argument("--force-promote", action="store_true")
    ingest.add_argument("--promote-limit", type=int, default=5)

    promote = sub.add_parser("promote", help="Promote eligible repeated-failure clusters into skill_evolve.")
    promote.add_argument("--fingerprint", default="")
    promote.add_argument("--limit", type=int, default=10)
    promote.add_argument("--force", action="store_true")

    listing = sub.add_parser("list", help="List recorded failure events.")
    listing.add_argument("--fingerprint", default="")
    listing.add_argument("--pending-only", action="store_true")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    collector = FailureCollector(args.workspace)
    if args.command == "record":
        result = collector.record(build_record_payload(args))
    elif args.command == "ingest":
        recorded = collector.record(build_record_payload(args))
        promoted = collector.promote(
            fingerprint=recorded["event"]["fingerprint"],
            limit=max(1, ensure_int(getattr(args, "promote_limit", 5), 5)),
            force=ensure_bool(getattr(args, "force_promote", False)),
        )
        result = {"status": "ok", "recorded": recorded, "promoted": promoted}
    elif args.command == "promote":
        result = collector.promote(fingerprint=args.fingerprint, limit=args.limit, force=args.force)
    else:
        result = {
            "status": "ok",
            "events": collector.list_events(
                fingerprint=args.fingerprint,
                include_promoted=not args.pending_only,
            ),
        }
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
