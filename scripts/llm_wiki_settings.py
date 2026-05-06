#!/usr/bin/env python3
"""Resolve llm-wiki provider settings with deterministic precedence."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from llm_wiki_provider import load_config


DEFAULT_SETTINGS = {
    "provider": "direct-file",
    "model": "",
    "timeout_ms": 600000,
    "language": "",
    "endpoint": "",
}

ENV_KEYS = {
    "provider": "LLM_WIKI_PROVIDER",
    "model": "LLM_WIKI_MODEL",
    "timeout_ms": "LLM_WIKI_TIMEOUT_MS",
    "language": "LLM_WIKI_LANGUAGE",
    "endpoint": "LLM_WIKI_ENDPOINT",
}


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        values[key] = value
    return values


def normalize_timeout(value: Any) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return int(DEFAULT_SETTINGS["timeout_ms"])


def read_agent_settings(workspace: Path) -> dict[str, Any]:
    path = workspace / ".llm-wiki" / "agent-settings.json"
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return {}
    settings = payload.get("provider_settings") if isinstance(payload.get("provider_settings"), dict) else payload
    return settings if isinstance(settings, dict) else {}


def read_packet_settings(workspace: Path) -> dict[str, Any]:
    config = load_config(workspace)
    settings = config.get("provider_settings") if isinstance(config.get("provider_settings"), dict) else {}
    wiki_compile = config.get("wiki_compile") if isinstance(config.get("wiki_compile"), dict) else {}
    merged: dict[str, Any] = dict(settings)
    if "timeout_ms" not in merged and wiki_compile.get("request_timeout_ms"):
        merged["timeout_ms"] = wiki_compile.get("request_timeout_ms")
    if "language" not in merged and wiki_compile.get("output_language"):
        merged["language"] = wiki_compile.get("output_language")
    return merged


def resolve_provider_settings(workspace: str | Path, environ: dict[str, str] | None = None) -> dict[str, Any]:
    root = Path(workspace).expanduser().resolve(strict=False)
    env = os.environ if environ is None else environ
    env_file = parse_env_file(root / ".env")
    agent_settings = read_agent_settings(root)
    packet_settings = read_packet_settings(root)

    layers = [
        ("defaults", DEFAULT_SETTINGS),
        ("packet_config", packet_settings),
        ("agent_settings", agent_settings),
        (".env", {key: env_file[name] for key, name in ENV_KEYS.items() if name in env_file}),
        ("environment", {key: env[name] for key, name in ENV_KEYS.items() if name in env}),
    ]
    resolved: dict[str, Any] = {}
    sources: dict[str, str] = {}
    for source, layer in layers:
        for key, value in layer.items():
            if key not in DEFAULT_SETTINGS or value in (None, ""):
                continue
            resolved[key] = value
            sources[key] = source
    resolved["timeout_ms"] = normalize_timeout(resolved.get("timeout_ms"))
    return {"settings": resolved, "sources": sources, "precedence": [name for name, _ in layers]}


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve llm-wiki provider/model settings.")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    payload = resolve_provider_settings(args.workspace)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for key, value in payload["settings"].items():
            print(f"{key}: {value} ({payload['sources'].get(key, 'unknown')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
