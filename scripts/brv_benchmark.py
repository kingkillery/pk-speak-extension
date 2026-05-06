#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path


DEFAULT_QUERY = (
    "A user has a difficult repo question and does not know the right folder yet. "
    "We also have an older note saying GitVizz first for all searches. "
    "What should the system do now, why, and what caveat should it mention?"
)

DEFAULT_CURATE = """Meeting notes, April 7.

Transient:
- At 10:12 AM Docker was flaky on my laptop after sleep.
- Port 3000 briefly failed once and worked again after restart.
- Revisit this next Tuesday with John.

Durable decisions:
- Use pk-qmd first when the right folder or file is not yet known.
- Use GitVizz after the likely area is found, to inspect topology, routes, and API relationships.
- Do not store transient command output or one-off runtime failures in BRV.
- Keep Gemini Flash Lite as the default BRV model for now.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config-path",
        default=str(Path(__file__).resolve().parents[1] / ".llm-wiki" / "config.json"),
    )
    parser.add_argument(
        "--target",
        action="append",
        default=[],
        help="Benchmark target in provider=model form. Repeatable.",
    )
    parser.add_argument("--query", default=DEFAULT_QUERY)
    parser.add_argument("--curate-note", default=DEFAULT_CURATE)
    parser.add_argument("--brv-command", default="")
    return parser.parse_args()


def load_config(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def parse_target(raw: str) -> tuple[str, str]:
    if "=" not in raw:
        raise ValueError(f"Target must use provider=model form: {raw}")
    provider, model = raw.split("=", 1)
    provider = provider.strip()
    model = model.strip()
    if not provider or not model:
        raise ValueError(f"Target must include both provider and model: {raw}")
    return provider, model


def resolve_targets(config: dict[str, object], explicit: list[str]) -> list[tuple[str, str]]:
    if explicit:
        return [parse_target(item) for item in explicit]

    byterover = config.get("byterover", {}) if isinstance(config.get("byterover"), dict) else {}
    targets: list[tuple[str, str]] = []

    default_provider = str(byterover.get("default_provider", "") or "")
    default_model = str(byterover.get("default_model", "") or "")
    if default_provider and default_model:
        targets.append((default_provider, default_model))

    experiment_provider = str(byterover.get("query_experiment_provider", "") or "")
    experiment_model = str(byterover.get("query_experiment_model", "") or "")
    if experiment_provider and experiment_model and (experiment_provider, experiment_model) not in targets:
        targets.append((experiment_provider, experiment_model))

    return targets


def run_brv(brv_command: str, cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [brv_command, *args],
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )


def last_json_line(output: str) -> dict[str, object]:
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        return {}
    return json.loads(lines[-1])


def safe_preview(text: str, limit: int) -> str:
    return text[:limit]


def seed_query_workspace(root: Path) -> None:
    (root / ".brv" / "context-tree" / "architecture").mkdir(parents=True, exist_ok=True)
    (root / ".brv" / "context-tree" / "history").mkdir(parents=True, exist_ok=True)
    (root / ".brv" / "context-tree" / "history" / "old-routing.md").write_text(
        "# Older routing note\n- Old note: Use GitVizz first for all repo searches.\n",
        encoding="utf-8",
    )
    (root / ".brv" / "context-tree" / "architecture" / "routing-correction.md").write_text(
        "# Current routing correction\n"
        "- Current rule: use pk-qmd first when the user does not yet know the right file or folder.\n"
        "- Use GitVizz after the likely folder, subsystem, or route is known, to inspect topology and API relationships.\n"
        "- BRV is for durable memory only.\n",
        encoding="utf-8",
    )


def benchmark_query(brv_command: str, targets: list[tuple[str, str]], query: str) -> list[dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix="brv-bench-query-") as tmp:
        root = Path(tmp)
        seed_query_workspace(root)
        run_brv(brv_command, root, "status", "--format", "json")
        results: list[dict[str, object]] = []
        for provider, model in targets:
            run_brv(brv_command, root, "model", "switch", model, "--provider", provider, "--format", "json")
            started = time.perf_counter()
            proc = run_brv(brv_command, root, "query", query, "--format", "json")
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            payload = last_json_line(proc.stdout)
            data = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
            result_text = str(data.get("result", "") or "")
            results.append(
                {
                    "provider": provider,
                    "model": model,
                    "ms": elapsed_ms,
                    "success": payload.get("success"),
                    "status": data.get("status"),
                    "chars": len(result_text),
                    "preview": safe_preview(result_text, 700),
                    "stderr": proc.stderr.strip(),
                }
            )
        return results


def benchmark_curate(brv_command: str, targets: list[tuple[str, str]], note: str) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for provider, model in targets:
        with tempfile.TemporaryDirectory(prefix="brv-bench-curate-") as tmp:
            root = Path(tmp)
            (root / ".brv" / "context-tree").mkdir(parents=True, exist_ok=True)
            run_brv(brv_command, root, "status", "--format", "json")
            run_brv(brv_command, root, "model", "switch", model, "--provider", provider, "--format", "json")
            started = time.perf_counter()
            proc = run_brv(brv_command, root, "curate", note, "--format", "json")
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            payload = last_json_line(proc.stdout)
            data = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
            changes = data.get("changes", {}) if isinstance(data.get("changes"), dict) else {}
            changed = list(changes.get("updated", []) or []) + list(changes.get("created", []) or [])
            preview = ""
            if changed:
                first = Path(changed[0])
                if first.exists():
                    preview = safe_preview(first.read_text(encoding="utf-8"), 900)
            results.append(
                {
                    "provider": provider,
                    "model": model,
                    "ms": elapsed_ms,
                    "success": payload.get("success"),
                    "status": data.get("status"),
                    "message": data.get("message"),
                    "changed": changed,
                    "preview": preview,
                    "stderr": proc.stderr.strip(),
                }
            )
    return results


def get_active_state(brv_command: str, cwd: Path) -> tuple[str | None, str | None]:
    proc = run_brv(brv_command, cwd, "model", "--format", "json")
    payload = last_json_line(proc.stdout)
    data = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
    return (
        str(data.get("providerId")) if data.get("providerId") else None,
        str(data.get("activeModel")) if data.get("activeModel") else None,
    )


def restore_active_state(brv_command: str, cwd: Path, provider: str | None, model: str | None) -> None:
    if provider and model:
        run_brv(brv_command, cwd, "model", "switch", model, "--provider", provider, "--format", "json")
        run_brv(brv_command, cwd, "providers", "switch", provider, "--format", "json")


def main() -> int:
    args = parse_args()
    config = load_config(Path(args.config_path))
    targets = resolve_targets(config, args.target)
    if not targets:
        raise SystemExit("No benchmark targets resolved.")

    byterover = config.get("byterover", {}) if isinstance(config.get("byterover"), dict) else {}
    brv_command = args.brv_command or str(byterover.get("command", "") or "brv")
    original_provider, original_model = get_active_state(brv_command, Path.cwd())

    try:
        result = {
            "targets": [{"provider": provider, "model": model} for provider, model in targets],
            "query": benchmark_query(brv_command, targets, args.query),
            "curate": benchmark_curate(brv_command, targets, args.curate_note),
        }
        print(json.dumps(result, indent=2))
        return 0
    finally:
        restore_active_state(brv_command, Path.cwd(), original_provider, original_model)


if __name__ == "__main__":
    sys.exit(main())
