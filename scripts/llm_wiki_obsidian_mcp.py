#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_PACKAGE = "@bitbonsai/mcpvault"
DEFAULT_LOCAL_CANDIDATES = (
    ".llm-wiki/tools/obsidian-mcp/node_modules/.bin/mcpvault.cmd",
    ".llm-wiki/tools/obsidian-mcp/node_modules/.bin/mcpvault.ps1",
    ".llm-wiki/tools/obsidian-mcp/node_modules/.bin/mcpvault",
)


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return {}
    return json.loads(raw)


def resolve_optional_path(value: str | None, workspace_root: Path) -> Path | None:
    if not value:
        return None
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return candidate.resolve(strict=False)
    return (workspace_root / candidate).resolve(strict=False)


def first_existing(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.exists():
            return path
    return None


def resolve_wrapper_runtime(workspace_root: Path) -> tuple[Path, Path, list[Path], str]:
    config = load_json(workspace_root / ".llm-wiki" / "config.json")
    obsidian = config.get("obsidian") if isinstance(config.get("obsidian"), dict) else {}
    memory_base = config.get("memory_base") if isinstance(config.get("memory_base"), dict) else {}
    vault_path = resolve_optional_path(str(obsidian.get("vault_path") or memory_base.get("vault_path") or workspace_root), workspace_root)
    candidates = [
        path
        for path in (
            resolve_optional_path(str(candidate), workspace_root)
            for candidate in obsidian.get("local_command_candidates", DEFAULT_LOCAL_CANDIDATES)
        )
        if path
    ]
    package_name = str(obsidian.get("package_name") or DEFAULT_PACKAGE)
    return workspace_root, vault_path or workspace_root, candidates, package_name


def ensure_local_install(workspace_root: Path, package_name: str) -> None:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        return
    install_root = workspace_root / ".llm-wiki" / "tools" / "obsidian-mcp"
    install_root.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [npm, "install", "--prefix", str(install_root), package_name],
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Launch the managed Obsidian MCP server without npx cold starts.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--vault", default="")
    parser.add_argument("--ensure-install", action="store_true")
    args = parser.parse_args()

    workspace_root = Path(args.workspace).expanduser().resolve(strict=False)
    _, configured_vault_path, candidates, package_name = resolve_wrapper_runtime(workspace_root)
    env_vault = os.environ.get("OBSIDIAN_VAULT_PATH", "")
    vault_path = (
        Path(args.vault).expanduser().resolve(strict=False)
        if args.vault
        else Path(env_vault).expanduser().resolve(strict=False)
        if env_vault
        else configured_vault_path
    )

    command_path = first_existing(candidates)
    if command_path is None and args.ensure_install:
        ensure_local_install(workspace_root, package_name)
        command_path = first_existing(candidates)

    if command_path is not None:
        return subprocess.run([str(command_path), str(vault_path)], check=False).returncode

    fallback = shutil.which("mcpvault")
    if fallback:
        return subprocess.run([fallback, str(vault_path)], check=False).returncode

    npm = shutil.which("npx") or shutil.which("npx.cmd")
    if not npm:
        raise SystemExit("Unable to locate mcpvault or npx for Obsidian MCP startup.")
    return subprocess.run([npm, "-y", package_name, str(vault_path)], check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
