#!/usr/bin/env python3
"""Shared module for building and querying a skill suggestion index.

Supports multiple embedding backends:
- tei: Local text-embeddings-inference HTTP endpoint
- keyword: Dependency-free weighted lexical overlap (default, always works)
- stub: Deterministic unit vectors for testing.
"""
from __future__ import annotations

import abc
import datetime
import json
import math
import re
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable


WORD_RE = re.compile(r"[a-zA-Z0-9_\-]+")

# Field weights for keyword scoring (higher = more important for matching)
FIELD_WEIGHTS = {
    "title": 3.0,
    "goal": 2.0,
    "trigger": 2.0,
    "fast_path": 1.5,
    "failure_modes": 1.0,
    "kind": 1.0,
    "body": 0.5,
}


@dataclass
class Skill:
    id: str
    title: str
    kind: str = ""
    memory_scope: str = ""
    memory_strategy: str = ""
    update_strategy: str = ""
    confidence: str = ""
    applies_to: list[str] = field(default_factory=list)
    path: str = ""
    created_at: str = ""
    updated_at: str = ""
    feedback_score: int = 0
    trigger: str = ""
    fast_path: str = ""
    failure_modes: str = ""
    body: str = ""
    related_skills: list[dict] = field(default_factory=list)

    def weighted_terms(self) -> dict[str, float]:
        """Return a term-frequency-like dict with field weights applied."""
        terms: dict[str, float] = {}
        for field_name, weight in FIELD_WEIGHTS.items():
            text = getattr(self, field_name, "")
            if not text:
                continue
            for word in WORD_RE.findall(text.lower()):
                terms[word] = terms.get(word, 0.0) + weight
        return terms


class Embedder(abc.ABC):
    @abc.abstractmethod
    def is_available(self) -> bool:
        ...

    @abc.abstractmethod
    def embed(self, text: str) -> list[float]:
        ...


class TEIEmbedder(Embedder):
    """Call a local text-embeddings-inference endpoint."""

    def __init__(self, url: str = "http://127.0.0.1:8182/embed") -> None:
        self.url = url

    def is_available(self) -> bool:
        try:
            req = urllib.request.Request(
                self.url,
                data=json.dumps({"inputs": "test"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                return resp.status == 200
        except Exception:
            return False

    def embed(self, text: str) -> list[float]:
        req = urllib.request.Request(
            self.url,
            data=json.dumps({"inputs": text}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            # TEI returns the embedding vector directly for a single input
            if isinstance(payload, list) and len(payload) > 0:
                vec = payload[0]
                if isinstance(vec, list):
                    return [float(v) for v in vec]
            raise RuntimeError(f"Unexpected TEI response shape: {payload}")


class KeywordEmbedder(Embedder):
    """No-op embedder; keyword scoring is handled separately."""

    def is_available(self) -> bool:
        return True

    def embed(self, text: str) -> list[float]:
        return []


class StubEmbedder(Embedder):
    """Deterministic unit vectors for testing."""

    def __init__(self, dimensions: int = 8) -> None:
        self.dimensions = dimensions

    def is_available(self) -> bool:
        return True

    def embed(self, text: str) -> list[float]:
        # Deterministic pseudo-random unit vector based on text hash
        h = hash(text)
        vec = [float((h >> (i % 32)) & 1) * 2 - 1 for i in range(self.dimensions)]
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _recency_multiplier(updated_at, halflife_days: float = 30.0) -> float:
    if not updated_at or not halflife_days:
        return 1.0
    try:
        if isinstance(updated_at, datetime.datetime):
            dt = updated_at
        else:
            dt = datetime.datetime.fromisoformat(str(updated_at).replace("Z", "+00:00"))
        age_days = (datetime.datetime.now(datetime.timezone.utc) - dt).total_seconds() / 86400.0
        return 0.5 + 0.5 * math.exp(-age_days / halflife_days)
    except Exception:
        return 1.0


def _tokenize(text: str) -> set[str]:
    return set(WORD_RE.findall(text.lower()))


def _keyword_score(task_text: str, skill: Skill) -> float:
    """Weighted lexical overlap score between task text and skill."""
    task_terms = {}
    for word in WORD_RE.findall(task_text.lower()):
        task_terms[word] = task_terms.get(word, 0.0) + 1.0

    skill_terms = skill.weighted_terms()
    if not skill_terms:
        return 0.0

    overlap = 0.0
    for term, task_count in task_terms.items():
        skill_weight = skill_terms.get(term, 0.0)
        if skill_weight:
            overlap += min(task_count, skill_weight)

    # Normalize by a hybrid of task length and skill length
    task_norm = math.sqrt(sum(c * c for c in task_terms.values()))
    skill_norm = math.sqrt(sum(c * c for c in skill_terms.values()))
    if task_norm == 0 or skill_norm == 0:
        return 0.0
    return overlap / (task_norm * skill_norm)


def _load_retired_penalties(retired_dir: Path) -> dict[str, float]:
    """Return penalty for each retired skill (0.5 per retired skill)."""
    penalties: dict[str, float] = {}
    if not retired_dir.exists():
        return penalties
    for path in retired_dir.glob("*.md"):
        text = path.read_text(encoding="utf-8")
        frontmatter: dict[str, Any] = {}
        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                try:
                    import yaml
                    frontmatter = yaml.safe_load(parts[1]) or {}
                except Exception:
                    frontmatter = _naive_frontmatter(parts[1])
        skill_id = frontmatter.get("skill_id") or frontmatter.get("id") or path.stem
        penalties[skill_id] = penalties.get(skill_id, 0.0) + 0.5
    return penalties


def _load_feedback_penalties(workspace: Path) -> dict[str, float]:
    """Return penalty from feedback.jsonl (0.25 per negative verdict, cap 0.5)."""
    penalties: dict[str, float] = {}
    log_path = workspace / ".llm-wiki" / "skill-pipeline" / "feedback.jsonl"
    if not log_path.exists():
        return penalties
    for line in log_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
            skill_id = event.get("skill_id", "")
            verdict = event.get("verdict", 0)
            if skill_id and verdict < 0:
                penalties[skill_id] = penalties.get(skill_id, 0.0) + 0.25
        except Exception:
            continue
    # Cap feedback-derived penalty at 0.5 per skill
    for skill_id in penalties:
        penalties[skill_id] = min(penalties[skill_id], 0.5)
    return penalties


def resolve_embedder(config: dict[str, Any]) -> Embedder:
    backend = config.get("backend", "keyword")
    if backend == "tei":
        url = config.get("tei_url", "http://127.0.0.1:8182/embed")
        return TEIEmbedder(url)
    if backend == "stub":
        dims = config.get("stub_dimensions", 8)
        return StubEmbedder(dims)
    return KeywordEmbedder()


@dataclass
class SkillIndex:
    version: int = 1
    backend: str = "keyword"
    skills: list[Skill] = field(default_factory=list)
    embeddings: dict[str, list[float]] = field(default_factory=dict)
    edges: dict[str, list[dict]] = field(default_factory=dict)
    penalties: dict[str, float] = field(default_factory=dict)

    def _penalty_multiplier(self, skill_id: str) -> float:
        """Return score multiplier (0.25–1.0) based on negative signals."""
        penalty = self.penalties.get(skill_id, 0.0)
        # Cap total penalty at 0.75 so skill never drops to zero
        return max(0.25, 1.0 - min(penalty, 0.75))

    def save(self, path: Path) -> None:
        def _sanitize(obj):
            if isinstance(obj, dict):
                return {k: _sanitize(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_sanitize(v) for v in obj]
            if isinstance(obj, (set, frozenset, tuple)):
                return [_sanitize(v) for v in obj]
            # Handle dates/datetimes from YAML parsing
            if hasattr(obj, "isoformat"):
                return obj.isoformat()
            return obj

        payload = {
            "version": self.version,
            "backend": self.backend,
            "skills": [_sanitize(asdict(s)) for s in self.skills],
            "embeddings": self.embeddings,
            "edges": self.edges,
            "penalties": self.penalties,
        }
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> SkillIndex:
        payload = json.loads(path.read_text(encoding="utf-8"))
        skills = [Skill(**item) for item in payload.get("skills", [])]
        return cls(
            version=payload.get("version", 1),
            backend=payload.get("backend", "keyword"),
            skills=skills,
            embeddings=payload.get("embeddings", {}),
            edges=payload.get("edges", {}),
            penalties=payload.get("penalties", {}),
        )

    def _skills_by_id(self) -> dict[str, Skill]:
        return {s.id: s for s in self.skills}

    def neighbors(self, skill_id: str, max_per_relation: int = 2) -> list[dict]:
        """Return related skill neighborhoods with titles."""
        by_id = self._skills_by_id()
        seen: dict[str, int] = {}
        out: list[dict] = []
        for edge in self.edges.get(skill_id, []):
            rel = edge.get("relation", "related")
            if seen.get(rel, 0) >= max_per_relation:
                continue
            target = by_id.get(edge.get("id", ""))
            if target:
                out.append({"id": target.id, "title": target.title, "relation": rel})
                seen[rel] = seen.get(rel, 0) + 1
        return out

    def score(
        self,
        task_text: str,
        embedder: Embedder | None = None,
        top_n: int = 3,
        halflife_days: float = 30.0,
    ) -> list[tuple[Skill, float]]:
        """Return top-N (skill, score) tuples sorted by descending score."""
        results: list[tuple[Skill, float]] = []

        # Keyword score is always computed
        keyword_scores = {skill.id: _keyword_score(task_text, skill) for skill in self.skills}

        # Embedding score, if available
        embedding_scores: dict[str, float] = {}
        if embedder is not None and embedder.is_available() and self.embeddings:
            try:
                task_vec = embedder.embed(task_text)
                for skill in self.skills:
                    skill_vec = self.embeddings.get(skill.id)
                    if skill_vec:
                        embedding_scores[skill.id] = _cosine_similarity(task_vec, skill_vec)
            except Exception:
                # Graceful degradation
                pass

        # Combine scores with configurable weighting
        embed_weight = 0.6 if embedding_scores else 0.0
        keyword_weight = 1.0 - embed_weight

        for skill in self.skills:
            score = keyword_weight * keyword_scores.get(skill.id, 0.0)
            if embed_weight:
                score += embed_weight * embedding_scores.get(skill.id, 0.0)
            # Apply recency decay
            score *= _recency_multiplier(skill.updated_at, halflife_days)
            # Apply negative-example penalty (retired / bad feedback)
            score *= self._penalty_multiplier(skill.id)
            results.append((skill, score))

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_n]


def discover_skills(active_dir: Path) -> list[Skill]:
    """Read all skill markdown files and extract structured metadata."""
    skills: list[Skill] = []
    if not active_dir.exists():
        return skills

    for path in sorted(active_dir.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        frontmatter: dict[str, Any] = {}
        body = text

        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                try:
                    import yaml
                    frontmatter = yaml.safe_load(parts[1]) or {}
                    body = parts[2]
                except Exception:
                    # yaml not available; fall back to naive parsing
                    frontmatter = _naive_frontmatter(parts[1])
                    body = parts[2]

        skill_id = frontmatter.get("skill_id") or frontmatter.get("id") or path.stem
        title = frontmatter.get("title", path.stem.replace("-", " "))
        kind = frontmatter.get("kind", "")
        memory_scope = frontmatter.get("memory_scope", "")
        memory_strategy = frontmatter.get("memory_strategy", "")
        update_strategy = frontmatter.get("update_strategy", "")
        confidence = frontmatter.get("confidence", "")
        applies_to = frontmatter.get("applies_to", [])
        if isinstance(applies_to, str):
            applies_to = [applies_to]

        # Extract trigger, fast_path, failure_modes from body heuristics
        trigger = _extract_section(body, "trigger", "## Trigger")
        fast_path = _extract_section(body, "fast path", "## Fast path")
        failure_modes = _extract_section(body, "failure modes", "## Failure modes")
        related_skills = frontmatter.get("related_skills", [])
        if not isinstance(related_skills, list):
            related_skills = []

        skills.append(
            Skill(
                id=skill_id,
                title=title,
                kind=kind,
                memory_scope=memory_scope,
                memory_strategy=memory_strategy,
                update_strategy=update_strategy,
                confidence=confidence,
                applies_to=applies_to,
                path=str(path),
                created_at=frontmatter.get("created_at", ""),
                updated_at=frontmatter.get("updated_at", ""),
                feedback_score=frontmatter.get("feedback_score", 0),
                trigger=trigger,
                fast_path=fast_path,
                failure_modes=failure_modes,
                body=body,
                related_skills=related_skills,
            )
        )

    return skills


def _naive_frontmatter(text: str) -> dict[str, Any]:
    """Parse simple key: value lines without requiring PyYAML."""
    result: dict[str, Any] = {}
    for line in text.splitlines():
        if ":" in line and not line.strip().startswith("-"):
            key, _, val = line.partition(":")
            result[key.strip()] = val.strip().strip('"').strip("'")
    return result


def _extract_section(body: str, *headers: str) -> str:
    """Extract text under the first matching markdown header."""
    lower_body = body.lower()
    start = -1
    for header in headers:
        idx = lower_body.find(header.lower())
        if idx != -1:
            start = idx + len(header)
            break
    if start == -1:
        return ""

    remaining = body[start:]
    # Find next ## header
    next_header = re.search(r"\n##\s", remaining)
    if next_header:
        return remaining[: next_header.start()].strip()
    return remaining.strip()


def _iter_skill_index_inputs(
    workspace: Path,
    config: dict[str, Any] | None = None,
) -> tuple[Path, Path, Path, Path, list[Path]]:
    config = config or {}
    skill_config = config.get("skills", {}) if isinstance(config.get("skills"), dict) else {}
    index_config = skill_config.get("index", {}) if isinstance(skill_config.get("index"), dict) else {}
    config_path = workspace / ".llm-wiki" / "config.json"
    active_dir = workspace / skill_config.get("active_dir", "wiki/skills/active")
    retired_dir = workspace / skill_config.get("retired_dir", "wiki/skills/retired")
    index_path = workspace / index_config.get("output_path", ".llm-wiki/skill-index.json")
    feedback_log = workspace / ".llm-wiki" / "skill-pipeline" / "feedback.jsonl"

    inputs: list[Path] = []
    if config_path.exists():
        inputs.append(config_path)
    if feedback_log.exists():
        inputs.append(feedback_log)
    if active_dir.exists():
        inputs.extend(sorted(active_dir.glob("*.md")))
    if retired_dir.exists():
        inputs.extend(sorted(retired_dir.glob("*.md")))
    return config_path, active_dir, retired_dir, index_path, inputs


def _latest_mtime(paths: Iterable[Path]) -> float:
    latest = 0.0
    for path in paths:
        try:
            latest = max(latest, path.stat().st_mtime)
        except OSError:
            continue
    return latest


def index_needs_rebuild(workspace: Path, config: dict[str, Any] | None = None) -> bool:
    _, _, _, index_path, inputs = _iter_skill_index_inputs(workspace, config)
    if not index_path.exists():
        return True
    try:
        index_mtime = index_path.stat().st_mtime
    except OSError:
        return True
    return _latest_mtime(inputs) > index_mtime


def ensure_index(workspace: Path, config: dict[str, Any] | None = None, force: bool = False) -> Path:
    workspace = workspace.resolve()
    config_path = workspace / ".llm-wiki" / "config.json"
    if config is None:
        config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    _, active_dir, _, index_path, _ = _iter_skill_index_inputs(workspace, config)
    if force or index_needs_rebuild(workspace, config):
        skill_config = config.get("skills", {}) if isinstance(config.get("skills"), dict) else {}
        index_config = skill_config.get("index", {}) if isinstance(skill_config.get("index"), dict) else {}
        embedder_config = {
            "backend": index_config.get("backend", "keyword"),
            "tei_url": index_config.get("tei_url", "http://127.0.0.1:8182/embed"),
        }
        build_index(active_dir, index_path, embedder=resolve_embedder(embedder_config))
    return index_path


def suggest_skills(
    workspace: Path,
    task_text: str,
    top_n: int = 3,
    threshold: float = 0.3,
) -> list[dict]:
    """Return skill suggestions for a task text."""
    config_path = workspace / ".llm-wiki" / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    skill_config = config.get("skills", {})
    index_config = skill_config.get("index", {})
    index_path = ensure_index(workspace, config=config)

    if not index_path.exists():
        return []

    index = SkillIndex.load(index_path)
    embedder_config = {
        "backend": index.backend,
        "tei_url": index_config.get("tei_url", "http://127.0.0.1:8182/embed"),
    }
    embedder = resolve_embedder(embedder_config)
    halflife = index_config.get("halflife_days", 30.0)

    results = index.score(task_text, embedder=embedder, top_n=top_n, halflife_days=halflife)
    suggestions = []
    for skill, score in results:
        if score < threshold:
            continue
        suggestions.append({
            "id": skill.id,
            "title": skill.title,
            "kind": skill.kind,
            "score": round(score, 4),
            "fast_path": skill.fast_path[:280] if skill.fast_path else "",
            "trigger": skill.trigger[:280] if skill.trigger else "",
            "path": skill.path,
            "neighbors": index.neighbors(skill.id, max_per_relation=2),
        })
    return suggestions


def format_suggestions(suggestions: list[dict]) -> str:
    if not suggestions:
        return ""
    lines = ["Skill suggestions:"]
    for s in suggestions:
        lines.append(f"  * {s['title']} (score {s['score']}) -- {s['id']}")
        if s.get("fast_path"):
            lines.append(f"    Fast path: {s['fast_path']}")
        if s.get("neighbors"):
            for n in s["neighbors"]:
                lines.append(f"    - {n['relation']}: {n['title']} ({n['id']})")
    return "\n".join(lines)


def build_index(
    active_dir: Path,
    output_path: Path,
    embedder: Embedder | None = None,
) -> SkillIndex:
    """Build and save a skill index from the active skill directory."""
    skills = discover_skills(active_dir)
    backend = "keyword"
    embeddings: dict[str, list[float]] = {}

    backend_map = {
        TEIEmbedder: "tei",
        StubEmbedder: "stub",
        KeywordEmbedder: "keyword",
    }
    if embedder is not None and embedder.is_available():
        backend = backend_map.get(type(embedder), "keyword")
        for skill in skills:
            try:
                vec = embedder.embed(skill.title + " " + skill.trigger + " " + skill.fast_path)
                embeddings[skill.id] = vec
            except Exception:
                pass

    # Build edge index from skill relationships
    edges: dict[str, list[dict]] = {}
    for skill in skills:
        if skill.related_skills:
            edges[skill.id] = [{"id": r.get("id", ""), "relation": r.get("relation", "related")} for r in skill.related_skills if r.get("id")]

    # Compute negative-example penalties
    workspace = output_path.parent.parent.resolve()
    retired_dir = active_dir.parent / "retired"
    penalties: dict[str, float] = {}
    for sid, p in _load_retired_penalties(retired_dir).items():
        penalties[sid] = penalties.get(sid, 0.0) + p
    for sid, p in _load_feedback_penalties(workspace).items():
        penalties[sid] = penalties.get(sid, 0.0) + p

    index = SkillIndex(version=1, backend=backend, skills=skills, embeddings=embeddings, edges=edges, penalties=penalties)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    index.save(output_path)
    return index
