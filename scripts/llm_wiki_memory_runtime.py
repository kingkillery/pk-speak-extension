#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.parse import urlencode

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

DEFAULT_QMD_REPO_URL = "https://github.com/kingkillery/pk-qmd"
DEFAULT_QMD_REPO_REF = "ef26cb62bb8132bc3a851b23f450af8e382e4c4e"
DEFAULT_QMD_CONFIG_DIR = ".llm-wiki/qmd-config"
DEFAULT_BRV_PACKAGE = "byterover-cli"
DEFAULT_OBSIDIAN_PACKAGE = "@bitbonsai/mcpvault"
DEFAULT_OBSIDIAN_SERVER_KEY = "obsidian"
DEFAULT_OBSIDIAN_WRAPPER_SCRIPT = "scripts/llm_wiki_obsidian_mcp.py"
DEFAULT_OBSIDIAN_BEHAVIOR_LAYER = "agent-cli-obsidian"
DEFAULT_OBSIDIAN_BEHAVIOR_REPO = "https://github.com/kingkillery/agent-cli-obsidian"
DEFAULT_WIKI_PROVIDER = "obsidian"
DEFAULT_WIKI_FOLDERS = {
    "sources": "wiki/sources",
    "concepts": "wiki/concepts",
    "entities": "wiki/entities",
    "questions": "wiki/questions",
    "syntheses": "wiki/syntheses",
    "decisions": "wiki/decisions",
    "sessions": "wiki/sessions",
    "meta": "wiki/meta",
}
DEFAULT_WIKI_NOTE_TYPES = ["synthesis", "concept", "source", "decision", "session"]
DEFAULT_WIKI_RESEARCH_NOTE_TYPES = ["source", "entity", "concept", "question", "synthesis"]
DEFAULT_SKILL_SERVER_KEY = "llm-wiki-skills"
DEFAULT_SKILL_MCP_STARTUP_TIMEOUT_SEC = 14
DEFAULT_SKILL_SCRIPT = "scripts/llm_wiki_skill_mcp.py"
DEFAULT_FAILURE_HOOK_SCRIPT = "scripts/llm_wiki_failure_hook.py"
DEFAULT_AGENT_FAILURE_CAPTURE_SCRIPT = "scripts/llm_wiki_agent_failure_capture.py"
DEFAULT_AGENT_FAILURE_LAUNCHERS = {
    "powershell": "scripts/run_llm_wiki_agent.ps1",
    "shell": "scripts/run_llm_wiki_agent.sh",
    "cmd": "scripts/run_llm_wiki_agent.cmd",
}
DEFAULT_SKILL_REGISTRY = ".llm-wiki/skills-registry.json"
MANAGED_FAILURE_HOOK_MARKERS = ("llm_wiki_failure_hook.py",)
DEFAULT_PIPELINE_DIRS = {
    "brief_dir": ".llm-wiki/skill-pipeline/briefs",
    "delta_dir": ".llm-wiki/skill-pipeline/deltas",
    "validation_dir": ".llm-wiki/skill-pipeline/validations",
    "packet_dir": ".llm-wiki/skill-pipeline/packets",
    "run_dir": ".llm-wiki/skill-pipeline/runs",
    "proposal_dir": ".llm-wiki/skill-pipeline/proposals",
    "surrogate_review_dir": ".llm-wiki/skill-pipeline/surrogate-reviews",
    "evolution_run_dir": ".llm-wiki/skill-pipeline/evolution-runs",
    "failure_dir": ".llm-wiki/skill-pipeline/failures",
    "failure_event_dir": ".llm-wiki/skill-pipeline/failures/events",
    "failure_cluster_dir": ".llm-wiki/skill-pipeline/failures/clusters",
    "failure_benchmark_dir": ".llm-wiki/skill-pipeline/failures/benchmarks",
}
STATE_PATH = Path(".llm-wiki/setup-state.json")
BROKEN_COMMAND_PATTERNS = (
    "not recognized as the name of a cmdlet",
    "/bin/sh.exe",
    "/bin/sh$exe",
    "the system cannot find the path specified",
)


def env_flag(name: str) -> bool:
    value = os.getenv(name)
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def resolve_runtime_root(script_path: Path) -> Path:
    script_parent = script_path.parent
    script_grandparent = script_parent.parent
    if (script_parent / ".llm-wiki" / "config.json").exists():
        return script_parent
    if (script_grandparent / ".llm-wiki" / "config.json").exists():
        return script_grandparent
    return script_parent


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text(encoding="utf-8-sig").strip()
    if not raw:
        return {}
    return json.loads(raw)


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def normalized_path_string(value: str | None) -> str:
    if not value:
        return ""
    return value.strip().rstrip("/\\")


def resolve_optional_path(value: str | None, workspace_root: Path) -> Path | None:
    normalized = normalized_path_string(value)
    if not normalized:
        return None
    candidate = Path(normalized).expanduser()
    if candidate.is_absolute():
        return candidate.resolve(strict=False)
    return (workspace_root / candidate).resolve(strict=False)


def relative_or_absolute(path: Path, workspace_root: Path) -> str:
    resolved = path.expanduser().resolve(strict=False)
    try:
        return resolved.relative_to(workspace_root.resolve(strict=False)).as_posix()
    except ValueError:
        return str(resolved)


def first_existing(paths: list[Path]) -> Path | None:
    ordered_paths = paths
    if os.name == "nt":
        suffix_rank = {".cmd": 0, ".bat": 0, ".exe": 0, ".ps1": 1}
        ordered_paths = sorted(paths, key=lambda path: suffix_rank.get(path.suffix.lower(), 2))
    for path in ordered_paths:
        if path.exists():
            return path
    return None


def command_in_path(command_name: str) -> str | None:
    resolved = shutil.which(command_name)
    return resolved if resolved else None


def resolve_python_command() -> list[str]:
    if os.getenv("PYTHON_BIN"):
        return [os.environ["PYTHON_BIN"]]
    if shutil.which("python"):
        return ["python"]
    if shutil.which("py"):
        return ["py", "-3"]
    return [sys.executable]


def resolve_npm_command() -> str | None:
    return command_in_path("npm") or command_in_path("npm.cmd")


def resolve_git_command() -> str | None:
    return command_in_path("git") or command_in_path("git.exe")


def resolve_shell_command(script_path: Path) -> list[str]:
    suffix = script_path.suffix.lower()
    if suffix in {".js", ".mjs", ".cjs"}:
        node = command_in_path("node")
        if not node:
            raise RuntimeError("node is required to execute JavaScript entrypoints")
        return [node, str(script_path)]
    if suffix == ".py":
        return [*resolve_python_command(), str(script_path)]
    if suffix == ".ps1":
        powershell = command_in_path("pwsh") or command_in_path("powershell") or "powershell"
        return [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path)]
    if suffix in {".cmd", ".bat"}:
        return ["cmd", "/c", str(script_path)]
    if suffix == ".sh":
        bash = command_in_path("bash")
        if not bash:
            raise RuntimeError("bash is required to execute shell entrypoints")
        return [bash, str(script_path)]
    return [str(script_path)]


def resolve_command_invocation(command_name: str, args: list[str]) -> list[str]:
    path_candidate = Path(command_name).expanduser()
    resolved_command = command_name
    if path_candidate.exists():
        resolved_command = str(path_candidate.resolve(strict=False))
    else:
        resolved = command_in_path(command_name)
        if resolved:
            resolved_command = resolved

    command_path = Path(resolved_command)
    if command_path.suffix:
        return [*resolve_shell_command(command_path), *args]
    return [resolved_command, *args]


def run_command(
    command_name: str,
    args: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int = 300,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    invocation = resolve_command_invocation(command_name, args)
    result = subprocess.run(
        invocation,
        cwd=str(cwd) if cwd else None,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        stderr = result.stderr.strip()
        stdout = result.stdout.strip()
        detail = stderr or stdout or f"exit code {result.returncode}"
        raise RuntimeError(f"{' '.join(invocation)} failed: {detail}")
    return result


def output_indicates_wrapper_failure(text: str) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in BROKEN_COMMAND_PATTERNS)


def probe_command(command_name: str, args: list[str], *, cwd: Path | None = None, timeout: int = 120) -> tuple[bool, str]:
    result = run_command(command_name, args, cwd=cwd, timeout=timeout)
    combined = "\n".join(filter(None, [result.stdout, result.stderr])).strip()
    if result.returncode != 0:
        return False, combined or f"{command_name} exited with {result.returncode}"
    if combined and output_indicates_wrapper_failure(combined):
        return False, combined
    return True, combined


def last_json_line(text: str) -> Any | None:
    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def check_tcp_url(url: str) -> bool:
    parsed = urlparse(url)
    if not parsed.hostname:
        return False
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((parsed.hostname, port), timeout=3):
            return True
    except OSError:
        return False


def runtime_gitvizz_authorization(runtime: dict[str, Any]) -> str:
    authorization = os.getenv(str(runtime.get("gitvizz_authorization_env") or "LLM_WIKI_GITVIZZ_AUTHORIZATION"), "").strip()
    if authorization:
        return authorization
    token = os.getenv(str(runtime.get("gitvizz_auth_token_env") or "LLM_WIKI_GITVIZZ_TOKEN"), "").strip()
    if token:
        scheme = str(runtime.get("gitvizz_auth_scheme") or "Bearer").strip() or "Bearer"
        return f"{scheme} {token}"
    return ""


def post_form_json(url: str, fields: dict[str, Any], *, timeout: int = 5, authorization: str = "") -> tuple[int, Any, str]:
    data = urlencode({key: str(value) for key, value in fields.items() if value is not None}).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if authorization:
        headers["Authorization"] = authorization
    request = Request(url, data=data, headers=headers, method="POST")  # noqa: S310 - configured local/dev endpoint
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(200000).decode("utf-8", errors="ignore")
            return response.status, last_json_line(raw), raw
    except HTTPError as exc:
        try:
            raw = exc.read(200000).decode("utf-8", errors="ignore")
        except Exception:
            raw = ""
        return exc.code, last_json_line(raw), raw
    except (OSError, TimeoutError, socket.timeout, URLError) as exc:
        return 0, None, str(exc)


def package_has_script(package_dir: Path, script_name: str) -> bool:
    package_json = package_dir / "package.json"
    if not package_json.exists():
        return False
    payload = load_json(package_json)
    scripts = payload.get("scripts")
    return isinstance(scripts, dict) and script_name in scripts


def write_qmd_wrappers(managed_tool_root: Path, qmd_dist_path: Path) -> list[Path]:
    bin_root = managed_tool_root / "bin"
    bin_root.mkdir(parents=True, exist_ok=True)
    cmd_path = bin_root / "pk-qmd.cmd"
    ps1_path = bin_root / "pk-qmd.ps1"
    sh_path = bin_root / "pk-qmd"

    cmd_path.write_text(f'@ECHO off\r\nnode "{qmd_dist_path}" %*\r\n', encoding="ascii")
    ps1_path.write_text(
        "#!/usr/bin/env pwsh\n"
        f'& node "{qmd_dist_path}" @args\n'
        "exit $LASTEXITCODE\n",
        encoding="utf-8",
    )
    sh_path.write_text(
        "#!/usr/bin/env bash\n"
        f'exec node "{qmd_dist_path}" "$@"\n',
        encoding="utf-8",
    )
    try:
        sh_path.chmod(0o755)
    except OSError:
        pass
    return [cmd_path, ps1_path, sh_path, qmd_dist_path]


def update_json_mcp_config(
    path: Path,
    server_key: str,
    command_name: str,
    args: list[str],
    *,
    factory_style: bool,
    env: dict[str, str] | None = None,
) -> None:
    payload = load_json(path)
    mcp_servers = payload.get("mcpServers")
    if not isinstance(mcp_servers, dict):
        mcp_servers = {}
    if factory_style:
        server_payload: dict[str, Any] = {
            "type": "stdio",
            "command": command_name,
            "args": args,
            "disabled": False,
        }
    else:
        server_payload = {"command": command_name, "args": args}
    if env:
        server_payload["env"] = env
    mcp_servers[server_key] = server_payload
    mcp_servers.pop("qmd", None)
    payload["mcpServers"] = mcp_servers
    save_json(path, payload)


def toml_string_literal(value: str) -> str:
    if "'" not in value and all(char not in value for char in ("\n", "\r", "\t")):
        return f"'{value}'"
    return json.dumps(value)


def toml_inline_table(payload: dict[str, str]) -> str:
    items = ", ".join(f"{key} = {toml_string_literal(value)}" for key, value in payload.items())
    return "{ " + items + " }"


def update_codex_toml(
    path: Path,
    server_key: str,
    command_name: str,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    startup_timeout_sec: int | None = None,
) -> None:
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    args_literal = "[" + ", ".join(toml_string_literal(value) for value in args) + "]"
    block = f"[mcp_servers.{server_key}]\ncommand = {toml_string_literal(command_name)}\nargs = {args_literal}\n"
    if env:
        block += f"env = {toml_inline_table(env)}\n"
    if startup_timeout_sec is not None:
        block += f"startup_timeout_sec = {int(startup_timeout_sec)}\n"
    section = re.compile(rf"(?ms)^\[mcp_servers\.{re.escape(server_key)}\]\n(?:.*?)(?=^\[|\Z)")
    legacy = re.compile(r"(?ms)^\[mcp_servers\.qmd\]\n(?:.*?)(?=^\[|\Z)")
    if section.search(content):
        content = section.sub(lambda _match: block + "\n", content)
    else:
        if content and not content.endswith("\n"):
            content += "\n"
        content += "\n" + block + "\n"
    content = legacy.sub("", content)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def remove_codex_toml_servers(path: Path, server_keys: list[str]) -> None:
    if not path.exists():
        return
    content = path.read_text(encoding="utf-8")
    for server_key in server_keys:
        section = re.compile(rf"(?ms)^\[mcp_servers\.{re.escape(server_key)}\]\n(?:.*?)(?=^\[|\Z)")
        content = section.sub("", content)
    path.write_text(content, encoding="utf-8")


def load_setup_state(workspace_root: Path) -> dict[str, Any]:
    return load_json(workspace_root / STATE_PATH)


def save_setup_state(workspace_root: Path, payload: dict[str, Any]) -> None:
    save_json(workspace_root / STATE_PATH, payload)


def record_state(payload: dict[str, Any], *keys: str, value: Any) -> None:
    cursor: dict[str, Any] = payload
    for key in keys[:-1]:
        existing = cursor.get(key)
        if not isinstance(existing, dict):
            existing = {}
            cursor[key] = existing
        cursor = existing
    cursor[keys[-1]] = value


def current_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def default_runtime_settings(workspace_root: Path, config_path: Path) -> dict[str, Any]:
    config = load_json(config_path)
    tooling = config.get("tooling") if isinstance(config.get("tooling"), dict) else {}
    install_scope = str(tooling.get("install_scope", "local"))
    managed_tool_root = resolve_optional_path(tooling.get("managed_tool_root"), workspace_root)
    if not managed_tool_root:
        managed_tool_root = (workspace_root / ".llm-wiki" / "tools").resolve(strict=False)
    memory_base = config.get("memory_base") if isinstance(config.get("memory_base"), dict) else {}
    pk_qmd = config.get("pk_qmd") if isinstance(config.get("pk_qmd"), dict) else {}
    byterover = config.get("byterover") if isinstance(config.get("byterover"), dict) else {}
    gitvizz = config.get("gitvizz") if isinstance(config.get("gitvizz"), dict) else {}
    obsidian = config.get("obsidian") if isinstance(config.get("obsidian"), dict) else {}
    wiki_layer = config.get("wiki_layer") if isinstance(config.get("wiki_layer"), dict) else {}
    skills = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    pipeline = skills.get("pipeline") if isinstance(skills.get("pipeline"), dict) else {}
    agent_failure_capture = config.get("agent_failure_capture") if isinstance(config.get("agent_failure_capture"), dict) else {}

    qmd_checkout_path = resolve_optional_path(pk_qmd.get("checkout_path"), workspace_root) or (managed_tool_root / "pk-qmd")
    brv_install_root = resolve_optional_path(byterover.get("install_root"), workspace_root) or (managed_tool_root / "brv")
    gitvizz_checkout_path = resolve_optional_path(gitvizz.get("checkout_path"), workspace_root)
    gitvizz_repo_path = resolve_optional_path(gitvizz.get("repo_path"), workspace_root)
    local_qmd_candidates = [
        path
        for path in (
            resolve_optional_path(str(candidate), workspace_root)
            for candidate in pk_qmd.get("local_command_candidates", [])
        )
        if path
    ]
    if not local_qmd_candidates:
        local_qmd_candidates = [
            managed_tool_root / "bin" / "pk-qmd.cmd",
            managed_tool_root / "bin" / "pk-qmd.ps1",
            managed_tool_root / "bin" / "pk-qmd",
            qmd_checkout_path / "dist" / "cli" / "qmd.js",
        ]

    local_brv_candidates = [
        path
        for path in (
            resolve_optional_path(str(candidate), workspace_root)
            for candidate in byterover.get("local_command_candidates", [])
        )
        if path
    ]
    if not local_brv_candidates:
        local_brv_candidates = [
            brv_install_root / "node_modules" / ".bin" / "brv.cmd",
            brv_install_root / "node_modules" / ".bin" / "brv.ps1",
            brv_install_root / "node_modules" / ".bin" / "brv",
        ]

    obsidian_install_root = resolve_optional_path(obsidian.get("install_root"), workspace_root) or (managed_tool_root / "obsidian-mcp")
    local_obsidian_candidates = [
        path
        for path in (
            resolve_optional_path(str(candidate), workspace_root)
            for candidate in obsidian.get("local_command_candidates", [])
        )
        if path
    ]
    if not local_obsidian_candidates:
        local_obsidian_candidates = [
            obsidian_install_root / "node_modules" / ".bin" / "mcpvault.cmd",
            obsidian_install_root / "node_modules" / ".bin" / "mcpvault.ps1",
            obsidian_install_root / "node_modules" / ".bin" / "mcpvault",
        ]

    memory_base_path = resolve_optional_path(memory_base.get("vault_path"), workspace_root) or workspace_root
    memory_base_name = str(memory_base.get("name") or workspace_root.name.lower().replace(" ", "-"))
    memory_base_id = str(memory_base.get("vault_id") or "")
    wiki_vault_path = (
        resolve_optional_path(wiki_layer.get("vault_path"), workspace_root)
        or resolve_optional_path(obsidian.get("vault_path"), workspace_root)
        or memory_base_path
    )
    wiki_path = resolve_optional_path(wiki_layer.get("wiki_path") or "wiki", wiki_vault_path) or wiki_vault_path / "wiki"
    wiki_raw_path = resolve_optional_path(wiki_layer.get("raw_path") or ".raw", wiki_vault_path) or wiki_vault_path / ".raw"
    wiki_index_path = resolve_optional_path(wiki_layer.get("index_path") or "wiki/index.md", wiki_vault_path) or wiki_vault_path / "wiki/index.md"
    wiki_log_path = resolve_optional_path(wiki_layer.get("log_path") or "wiki/log.md", wiki_vault_path) or wiki_vault_path / "wiki/log.md"
    wiki_hot_cache_path = resolve_optional_path(wiki_layer.get("hot_cache_path") or "wiki/hot.md", wiki_vault_path) or wiki_vault_path / "wiki/hot.md"
    configured_folders = wiki_layer.get("folders") if isinstance(wiki_layer.get("folders"), dict) else {}
    wiki_folders = {**DEFAULT_WIKI_FOLDERS, **{str(key): str(value) for key, value in configured_folders.items()}}
    qmd_collection = str(pk_qmd.get("collection_name") or memory_base_name)
    qmd_context = str(pk_qmd.get("context") or f"Official {memory_base_name} memory base at {memory_base_path}")

    return {
        "workspace_root": workspace_root,
        "config_path": config_path,
        "install_scope": install_scope,
        "managed_tool_root": managed_tool_root,
        "memory_base_path": memory_base_path,
        "memory_base_name": memory_base_name,
        "memory_base_id": memory_base_id,
        "qmd_command": str(pk_qmd.get("command") or "pk-qmd"),
        "qmd_repo_url": str(pk_qmd.get("repo_url") or DEFAULT_QMD_REPO_URL),
        "qmd_repo_ref": str(pk_qmd.get("repo_ref") or DEFAULT_QMD_REPO_REF),
        "qmd_checkout_path": qmd_checkout_path,
        "qmd_local_candidates": local_qmd_candidates,
        "qmd_collection": qmd_collection,
        "qmd_context": qmd_context,
        "qmd_config_dir": resolve_optional_path(pk_qmd.get("config_dir"), workspace_root) or workspace_root / DEFAULT_QMD_CONFIG_DIR,
        "qmd_source_checkout": resolve_optional_path(pk_qmd.get("source_checkout_path"), workspace_root),
        "qmd_source_path": resolve_optional_path(pk_qmd.get("source_path"), workspace_root) or memory_base_path,
        "brv_command": str(byterover.get("command") or "brv"),
        "brv_package_name": str(byterover.get("package_name") or DEFAULT_BRV_PACKAGE),
        "brv_install_root": brv_install_root,
        "brv_local_candidates": local_brv_candidates,
        "obsidian_server_key": str(obsidian.get("mcp_server_key") or DEFAULT_OBSIDIAN_SERVER_KEY),
        "obsidian_package_name": str(obsidian.get("package_name") or DEFAULT_OBSIDIAN_PACKAGE),
        "obsidian_behavior_layer": str(obsidian.get("behavior_layer") or DEFAULT_OBSIDIAN_BEHAVIOR_LAYER),
        "obsidian_behavior_layer_repo": str(obsidian.get("behavior_layer_repo") or DEFAULT_OBSIDIAN_BEHAVIOR_REPO),
        "obsidian_transport_layer": str(obsidian.get("transport_layer") or "mcpvault"),
        "obsidian_alternate_transport": str(obsidian.get("alternate_transport") or "mcp-obsidian"),
        "obsidian_recommended_note_types": list(obsidian.get("recommended_note_types") or ["synthesis", "concept", "source", "decision", "session"]),
        "obsidian_research_note_types": list(obsidian.get("research_note_types") or ["source", "entity", "concept", "question", "synthesis"]),
        "obsidian_install_root": obsidian_install_root,
        "obsidian_local_candidates": local_obsidian_candidates,
        "obsidian_wrapper_script_path": resolve_optional_path(obsidian.get("wrapper_script_path") or DEFAULT_OBSIDIAN_WRAPPER_SCRIPT, workspace_root)
        or workspace_root / DEFAULT_OBSIDIAN_WRAPPER_SCRIPT,
        "obsidian_vault_path": resolve_optional_path(obsidian.get("vault_path"), workspace_root) or memory_base_path,
        "wiki_provider": str(wiki_layer.get("provider") or DEFAULT_WIKI_PROVIDER),
        "wiki_behavior_layer": str(wiki_layer.get("behavior_layer") or DEFAULT_OBSIDIAN_BEHAVIOR_LAYER),
        "wiki_behavior_layer_repo": str(wiki_layer.get("behavior_layer_repo") or DEFAULT_OBSIDIAN_BEHAVIOR_REPO),
        "wiki_transport": str(wiki_layer.get("transport") or obsidian.get("transport_layer") or "mcpvault"),
        "wiki_alternate_transport": str(wiki_layer.get("alternate_transport") or obsidian.get("alternate_transport") or "mcp-obsidian"),
        "wiki_vault_path": wiki_vault_path,
        "wiki_raw_path": wiki_raw_path,
        "wiki_path": wiki_path,
        "wiki_index_path": wiki_index_path,
        "wiki_log_path": wiki_log_path,
        "wiki_hot_cache_path": wiki_hot_cache_path,
        "wiki_folders": wiki_folders,
        "wiki_note_types": list(wiki_layer.get("note_types") or DEFAULT_WIKI_NOTE_TYPES),
        "wiki_research_note_types": list(wiki_layer.get("research_note_types") or DEFAULT_WIKI_RESEARCH_NOTE_TYPES),
        "wiki_offer_save_for_substantial_answers": bool(wiki_layer.get("offer_save_for_substantial_answers", True)),
        "wiki_deep_research_save_default": bool(wiki_layer.get("deep_research_save_default", True)),
        "wiki_update_existing_before_create": bool(wiki_layer.get("update_existing_before_create", True)),
        "wiki_direct_file_fallback": bool(wiki_layer.get("direct_file_fallback", True)),
        "wiki_log_transport_fallback": bool(wiki_layer.get("log_transport_fallback", True)),
        "gitvizz_frontend_url": str(gitvizz.get("frontend_url") or "http://localhost:3000"),
        "gitvizz_backend_url": str(gitvizz.get("backend_url") or "http://localhost:8003"),
        "gitvizz_repo_url": str(gitvizz.get("repo_url") or ""),
        "gitvizz_repo_id": str(gitvizz.get("repo_id") or gitvizz.get("indexed_repo_id") or gitvizz.get("repository_id") or ""),
        "gitvizz_authorization_env": str(gitvizz.get("authorization_env") or "LLM_WIKI_GITVIZZ_AUTHORIZATION"),
        "gitvizz_auth_token_env": str(gitvizz.get("auth_token_env") or "LLM_WIKI_GITVIZZ_TOKEN"),
        "gitvizz_auth_scheme": str(gitvizz.get("auth_scheme") or "Bearer"),
        "gitvizz_checkout_path": gitvizz_checkout_path,
        "gitvizz_repo_path": gitvizz_repo_path,
        "skill_server_key": str(skills.get("mcp_server_key") or DEFAULT_SKILL_SERVER_KEY),
        "skill_script_path": resolve_optional_path(skills.get("script_path") or DEFAULT_SKILL_SCRIPT, workspace_root)
        or workspace_root / DEFAULT_SKILL_SCRIPT,
        "failure_hook_script_path": resolve_optional_path(
            skills.get("failure_hook_script_path") or DEFAULT_FAILURE_HOOK_SCRIPT,
            workspace_root,
        )
        or workspace_root / DEFAULT_FAILURE_HOOK_SCRIPT,
        "agent_failure_capture_script_path": resolve_optional_path(
            agent_failure_capture.get("script_path") or DEFAULT_AGENT_FAILURE_CAPTURE_SCRIPT,
            workspace_root,
        )
        or workspace_root / DEFAULT_AGENT_FAILURE_CAPTURE_SCRIPT,
        "agent_failure_launcher_paths": {
            key: resolve_optional_path(agent_failure_capture.get("launcher_paths", {}).get(key) or default, workspace_root)
            or workspace_root / default
            for key, default in DEFAULT_AGENT_FAILURE_LAUNCHERS.items()
        },
        "agent_failure_commands": {
            key: str(value)
            for key, value in (
                agent_failure_capture.get("commands")
                or {"claude": "claude", "codex": "codex", "droid": "droid", "pi": "pi"}
            ).items()
            if value
        },
        "skill_registry_path": resolve_optional_path(skills.get("registry_path") or DEFAULT_SKILL_REGISTRY, workspace_root)
        or workspace_root / DEFAULT_SKILL_REGISTRY,
        "skill_pipeline_paths": {
            key: resolve_optional_path(pipeline.get(key) or default, workspace_root) or workspace_root / default
            for key, default in DEFAULT_PIPELINE_DIRS.items()
        },
        "skill_active_dir": resolve_optional_path(skills.get("active_dir") or "wiki/skills/active", workspace_root)
        or workspace_root / "wiki/skills/active",
        "skill_retired_dir": resolve_optional_path(skills.get("retired_dir") or "wiki/skills/retired", workspace_root)
        or workspace_root / "wiki/skills/retired",
        "skill_index_path": resolve_optional_path((skills.get("index") or {}).get("output_path") or ".llm-wiki/skill-index.json", workspace_root)
        or workspace_root / ".llm-wiki/skill-index.json",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Shared llm-wiki setup and health runtime.")
    parser.add_argument("mode", choices=("setup", "check"), help="Run setup or health verification.")
    parser.add_argument("--workspace", help="Workspace root that contains .llm-wiki/config.json")
    parser.add_argument("--config-path", help="Explicit path to .llm-wiki/config.json")
    parser.add_argument("--qmd-source", default=os.getenv("LLM_WIKI_QMD_SOURCE", ""))
    parser.add_argument("--qmd-source-checkout", default=os.getenv("LLM_WIKI_QMD_SOURCE_CHECKOUT", ""))
    parser.add_argument("--qmd-repo-url", default=os.getenv("LLM_WIKI_QMD_REPO_URL", ""))
    parser.add_argument("--qmd-command", default=os.getenv("LLM_WIKI_QMD_COMMAND", ""))
    parser.add_argument("--qmd-collection", default=os.getenv("LLM_WIKI_QMD_COLLECTION", ""))
    parser.add_argument("--qmd-context", default=os.getenv("LLM_WIKI_QMD_CONTEXT", ""))
    parser.add_argument("--brv-command", default=os.getenv("LLM_WIKI_BRV_COMMAND", ""))
    parser.add_argument("--obsidian-vault-path", default=os.getenv("LLM_WIKI_OBSIDIAN_VAULT_PATH", ""))
    parser.add_argument("--gitvizz-frontend-url", default=os.getenv("LLM_WIKI_GITVIZZ_FRONTEND_URL", ""))
    parser.add_argument("--gitvizz-backend-url", default=os.getenv("LLM_WIKI_GITVIZZ_BACKEND_URL", ""))
    parser.add_argument("--gitvizz-repo-url", default=os.getenv("LLM_WIKI_GITVIZZ_REPO_URL", ""))
    parser.add_argument("--gitvizz-checkout-path", default=os.getenv("LLM_WIKI_GITVIZZ_CHECKOUT_PATH", ""))
    parser.add_argument("--gitvizz-repo-path", default=os.getenv("LLM_WIKI_GITVIZZ_REPO_PATH", ""))
    parser.add_argument("--skip-qmd", action="store_true")
    parser.add_argument("--skip-mcp", action="store_true")
    parser.add_argument("--skip-qmd-bootstrap", action="store_true")
    parser.add_argument("--skip-qmd-embed", action="store_true")
    parser.add_argument("--skip-brv", action="store_true")
    parser.add_argument("--skip-brv-init", action="store_true")
    parser.add_argument("--skip-gitvizz", action="store_true")
    parser.add_argument("--skip-gitvizz-start", action="store_true")
    parser.add_argument("--allow-global-tool-install", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    return parser.parse_args()


def build_runtime(args: argparse.Namespace) -> dict[str, Any]:
    if args.config_path:
        config_path = Path(args.config_path).expanduser().resolve(strict=False)
        workspace_root = Path(args.workspace).expanduser().resolve(strict=False) if args.workspace else config_path.parent.parent
    else:
        workspace_root = (
            Path(args.workspace).expanduser().resolve(strict=False)
            if args.workspace
            else resolve_runtime_root(Path(__file__).resolve())
        )
        config_path = (workspace_root / ".llm-wiki" / "config.json").resolve(strict=False)

    runtime = default_runtime_settings(workspace_root, config_path)
    runtime["workspace_root"] = workspace_root
    runtime["config_path"] = config_path
    runtime["verify_only"] = args.verify_only or args.mode == "check"
    runtime["allow_global_tool_install"] = args.allow_global_tool_install or env_flag("LLM_WIKI_ALLOW_GLOBAL_TOOL_INSTALL")
    runtime["skip_qmd"] = args.skip_qmd
    runtime["skip_mcp"] = args.skip_mcp or args.mode == "check"
    runtime["skip_qmd_bootstrap"] = args.skip_qmd_bootstrap
    runtime["skip_qmd_embed"] = args.skip_qmd_embed
    runtime["skip_brv"] = args.skip_brv
    runtime["skip_brv_init"] = args.skip_brv_init
    runtime["skip_gitvizz"] = args.skip_gitvizz
    runtime["skip_gitvizz_start"] = args.skip_gitvizz or args.skip_gitvizz_start or args.mode == "check"
    runtime["qmd_source"] = resolve_optional_path(args.qmd_source, workspace_root)
    if args.qmd_source_checkout:
        runtime["qmd_source_checkout"] = resolve_optional_path(args.qmd_source_checkout, workspace_root)
    if args.qmd_repo_url:
        runtime["qmd_repo_url"] = args.qmd_repo_url
    if args.qmd_command:
        runtime["qmd_command"] = args.qmd_command
    if args.qmd_collection:
        runtime["qmd_collection"] = args.qmd_collection
    if args.qmd_context:
        runtime["qmd_context"] = args.qmd_context
    if args.brv_command:
        runtime["brv_command"] = args.brv_command
    if args.obsidian_vault_path:
        runtime["obsidian_vault_path"] = resolve_optional_path(args.obsidian_vault_path, workspace_root) or Path(args.obsidian_vault_path)
    if args.gitvizz_frontend_url:
        runtime["gitvizz_frontend_url"] = args.gitvizz_frontend_url
    if args.gitvizz_backend_url:
        runtime["gitvizz_backend_url"] = args.gitvizz_backend_url
    if args.gitvizz_repo_url:
        runtime["gitvizz_repo_url"] = args.gitvizz_repo_url
    if args.gitvizz_checkout_path:
        runtime["gitvizz_checkout_path"] = resolve_optional_path(args.gitvizz_checkout_path, workspace_root)
    if args.gitvizz_repo_path:
        runtime["gitvizz_repo_path"] = resolve_optional_path(args.gitvizz_repo_path, workspace_root)
    return runtime


def ensure_qmd_source_command(source_path: Path) -> Path | None:
    candidates = [
        source_path / "dist" / "cli" / "qmd.js",
        source_path / "bin" / "qmd.ps1",
        source_path / "bin" / "qmd.cmd",
        source_path / "bin" / "qmd",
        source_path / "bin" / "pk-qmd.ps1",
        source_path / "bin" / "pk-qmd.cmd",
        source_path / "bin" / "pk-qmd",
    ]
    return first_existing(candidates)


def qmd_runtime_env(runtime: dict[str, Any]) -> dict[str, str]:
    env = os.environ.copy()
    config_dir = runtime.get("qmd_config_dir")
    if config_dir:
        Path(config_dir).mkdir(parents=True, exist_ok=True)
        env["QMD_CONFIG_DIR"] = str(config_dir)
    return env


def qmd_package_spec(runtime: dict[str, Any]) -> str:
    repo_url = str(runtime["qmd_repo_url"]).rstrip("/")
    repo_ref = str(runtime["qmd_repo_ref"]).strip()
    if repo_url.startswith("git+"):
        base = repo_url
    elif repo_url.endswith(".git"):
        base = f"git+{repo_url}"
    else:
        base = f"git+{repo_url}.git"
    if repo_ref:
        return f"{base}#{repo_ref}"
    return base


def ensure_managed_qmd(runtime: dict[str, Any], summary: list[str], failures: list[str], state: dict[str, Any]) -> str | None:
    managed_tool_root: Path = runtime["managed_tool_root"]
    checkout_path: Path = runtime["qmd_checkout_path"]
    local_candidates: list[Path] = runtime["qmd_local_candidates"]

    source_checkout: Path | None = runtime.get("qmd_source_checkout")
    if source_checkout:
        source_command = ensure_qmd_source_command(source_checkout)
        if source_command:
            summary.append(f"pk-qmd install state: resolved preferred source checkout {source_command}")
            return str(source_command)
        summary.append(f"pk-qmd install state: preferred source checkout missing runnable entrypoint ({source_checkout})")

    existing_candidate = first_existing(local_candidates)
    if existing_candidate:
        usable, detail = probe_command(str(existing_candidate), ["status"], cwd=runtime["workspace_root"], timeout=120)
        if usable:
            summary.append(f"pk-qmd install state: resolved managed candidate {existing_candidate}")
            return str(existing_candidate)
        summary.append(f"pk-qmd install state: managed candidate unusable ({existing_candidate})")
        if detail:
            summary.append(f"pk-qmd install fallback reason: {detail.splitlines()[-1]}")

    checkout_command = ensure_qmd_source_command(checkout_path)
    if checkout_command:
        usable, detail = probe_command(str(checkout_command), ["status"], cwd=runtime["workspace_root"], timeout=120)
        if usable:
            summary.append(f"pk-qmd install state: resolved managed checkout entrypoint {checkout_command}")
            return str(checkout_command)
        summary.append(f"pk-qmd install state: managed checkout entrypoint unusable ({checkout_command})")
        if detail:
            summary.append(f"pk-qmd install fallback reason: {detail.splitlines()[-1]}")

    configured_command = str(runtime["qmd_command"])
    configured_path = Path(configured_command).expanduser()
    if configured_path.exists() or command_in_path(configured_command):
        usable, detail = probe_command(configured_command, ["status"], cwd=runtime["workspace_root"], timeout=120)
        if usable:
            summary.append(f"pk-qmd install state: resolved existing command {configured_command}")
            return configured_command
        summary.append(f"pk-qmd install state: existing command unusable ({configured_command})")
        if detail:
            summary.append(f"pk-qmd install fallback reason: {detail.splitlines()[-1]}")

    source_path: Path | None = runtime.get("qmd_source")
    if source_path:
        source_command = ensure_qmd_source_command(source_path)
        if source_command:
            summary.append(f"pk-qmd install state: resolved source checkout {source_command}")
            return str(source_command)

    if runtime["verify_only"]:
        failures.append(f"Missing pk-qmd command: {configured_command}")
        return None

    git = resolve_git_command()
    npm = resolve_npm_command()
    if not git or not npm:
        message = "pk-qmd managed install requires both git and npm"
        if runtime["allow_global_tool_install"] and npm:
            try:
                run_command(npm, ["install", "-g", qmd_package_spec(runtime)], check=True, timeout=900)
                summary.append("pk-qmd install state: installed from pinned global npm package")
                return configured_command
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{message}; global install failed: {exc}")
                return None
        failures.append(message)
        return None

    checkout_path.parent.mkdir(parents=True, exist_ok=True)
    repo_url = str(runtime["qmd_repo_url"])
    repo_ref = str(runtime["qmd_repo_ref"])
    try:
        if not checkout_path.exists():
            run_command(git, ["clone", repo_url, str(checkout_path)], check=True, timeout=1200)
            summary.append(f"pk-qmd checkout installed: {checkout_path}")
        elif (checkout_path / ".git").exists():
            state_ref = state.get("setup", {}).get("qmd", {}).get("repo_ref")
            dist_path = checkout_path / "dist" / "cli" / "qmd.js"
            if not (dist_path.exists() and state_ref == repo_ref):
                run_command(git, ["-C", str(checkout_path), "fetch", "--tags", "--prune", "origin"], check=True, timeout=1200)
        if repo_ref:
            run_command(git, ["-C", str(checkout_path), "checkout", repo_ref], check=True, timeout=300)
            summary.append(f"pk-qmd checkout pinned: {repo_ref}")

        dist_path = checkout_path / "dist" / "cli" / "qmd.js"
        dist_exists_preinstall = dist_path.exists()
        run_command(npm, ["install"], cwd=checkout_path, check=True, timeout=1800)
        if package_has_script(checkout_path, "build") and not dist_exists_preinstall:
            try:
                run_command(npm, ["run", "build"], cwd=checkout_path, check=True, timeout=1800)
            except Exception as exc:  # noqa: BLE001
                if dist_path.exists():
                    summary.append(f"pk-qmd build fallback: using existing dist entrypoint after build error ({exc})")
                else:
                    raise

        if not dist_path.exists():
            failures.append(f"pk-qmd checkout missing dist entrypoint after install: {dist_path}")
            return None

        wrappers = write_qmd_wrappers(managed_tool_root, dist_path)
        runtime["qmd_local_candidates"] = wrappers
        record_state(state, "setup", "qmd", "checkout_path", value=str(checkout_path))
        record_state(state, "setup", "qmd", "repo_ref", value=repo_ref)
        record_state(state, "setup", "qmd", "last_install_at", value=current_timestamp())
        summary.append(f"pk-qmd wrappers refreshed: {managed_tool_root / 'bin'}")
        return str(wrappers[0])
    except Exception as exc:  # noqa: BLE001
        failures.append(f"pk-qmd managed install failed: {exc}")
        return None


def ensure_brv_command(runtime: dict[str, Any], summary: list[str], failures: list[str], state: dict[str, Any]) -> str | None:
    local_candidates: list[Path] = runtime["brv_local_candidates"]
    existing_candidate = first_existing(local_candidates)
    if existing_candidate:
        summary.append(f"brv install state: resolved managed candidate {existing_candidate}")
        return str(existing_candidate)

    configured_command = str(runtime["brv_command"])
    configured_path = Path(configured_command).expanduser()
    if configured_path.exists() or command_in_path(configured_command):
        summary.append(f"brv install state: resolved existing command {configured_command}")
        return configured_command

    if runtime["verify_only"]:
        failures.append(f"Missing Byterover command: {configured_command}")
        return None

    npm = resolve_npm_command()
    if npm:
        install_root: Path = runtime["brv_install_root"]
        install_root.mkdir(parents=True, exist_ok=True)
        try:
            run_command(
                npm,
                ["install", "--prefix", str(install_root), str(runtime["brv_package_name"])],
                check=True,
                timeout=1800,
            )
            resolved_candidate = first_existing(local_candidates)
            if resolved_candidate:
                record_state(state, "setup", "brv", "install_root", value=str(install_root))
                record_state(state, "setup", "brv", "last_install_at", value=current_timestamp())
                summary.append(f"brv install state: installed managed dependency {resolved_candidate}")
                return str(resolved_candidate)
        except Exception as exc:  # noqa: BLE001
            summary.append(f"brv managed install failed: {exc}")

    if runtime["allow_global_tool_install"] and npm:
        try:
            run_command(npm, ["install", "-g", str(runtime["brv_package_name"])], check=True, timeout=1800)
            summary.append("brv install state: installed from global npm")
            return configured_command
        except Exception as exc:  # noqa: BLE001
            failures.append(f"Global brv install failed: {exc}")
            return None

    failures.append(f"Missing Byterover command: {configured_command}")
    return None


def ensure_managed_obsidian(runtime: dict[str, Any], summary: list[str], failures: list[str], state: dict[str, Any]) -> str | None:
    local_candidates: list[Path] = runtime["obsidian_local_candidates"]
    existing_candidate = first_existing(local_candidates)
    if existing_candidate:
        summary.append(f"obsidian install state: resolved managed candidate {existing_candidate}")
        return str(existing_candidate)

    configured_command = "mcpvault"
    configured_path = Path(configured_command).expanduser()
    if configured_path.exists() or command_in_path(configured_command):
        summary.append(f"obsidian install state: resolved existing command {configured_command}")
        return configured_command

    if runtime["verify_only"]:
        failures.append(f"Missing Obsidian MCP command: {configured_command}")
        return None

    npm = resolve_npm_command()
    if npm:
        install_root: Path = runtime["obsidian_install_root"]
        install_root.mkdir(parents=True, exist_ok=True)
        try:
            run_command(
                npm,
                ["install", "--prefix", str(install_root), str(runtime["obsidian_package_name"])],
                check=True,
                timeout=1800,
            )
            resolved_candidate = first_existing(local_candidates)
            if resolved_candidate:
                record_state(state, "setup", "obsidian", "install_root", value=str(install_root))
                record_state(state, "setup", "obsidian", "last_install_at", value=current_timestamp())
                summary.append(f"obsidian install state: installed managed dependency {resolved_candidate}")
                return str(resolved_candidate)
        except Exception as exc:  # noqa: BLE001
            summary.append(f"obsidian managed install failed: {exc}")

    failures.append(f"Missing Obsidian MCP command: {configured_command}")
    return None


def patch_qmd_mcp_configs(qmd_command: str, summary: list[str]) -> None:
    user_home = Path.home()
    qmd_invocation = resolve_command_invocation(qmd_command, ["mcp"])
    qmd_command_name = qmd_invocation[0]
    qmd_args = qmd_invocation[1:]
    update_json_mcp_config(user_home / ".claude" / "settings.json", "pk-qmd", qmd_command_name, qmd_args, factory_style=False)
    summary.append("Updated ~/.claude/settings.json")
    remove_codex_toml_servers(user_home / ".codex" / "config.toml", ["pk-qmd", "qmd"])
    summary.append("Skipped ~/.codex/config.toml for pk-qmd (use scripts/llm_wiki_packet.py context/evidence outside MCP)")
    update_json_mcp_config(user_home / ".factory" / "mcp.json", "pk-qmd", qmd_command_name, qmd_args, factory_style=True)
    summary.append("Updated ~/.factory/mcp.json")


def patch_obsidian_mcp_configs(runtime: dict[str, Any], obsidian_command: str, summary: list[str]) -> None:
    user_home = Path.home()
    obsidian_invocation = resolve_command_invocation(obsidian_command, [str(runtime["obsidian_vault_path"])])
    obsidian_command_name = obsidian_invocation[0]
    obsidian_args = obsidian_invocation[1:]
    obsidian_env = {"OBSIDIAN_VAULT_PATH": str(runtime["obsidian_vault_path"])}
    update_json_mcp_config(
        user_home / ".claude" / "settings.json",
        runtime["obsidian_server_key"],
        obsidian_command_name,
        obsidian_args,
        factory_style=False,
        env=obsidian_env,
    )
    summary.append(f"Updated ~/.claude/settings.json for {runtime['obsidian_server_key']}")
    remove_codex_toml_servers(user_home / ".codex" / "config.toml", [runtime["obsidian_server_key"]])
    summary.append(
        f"Skipped ~/.codex/config.toml for {runtime['obsidian_server_key']} "
        "(use scripts/llm_wiki_provider.py or scripts/llm_wiki_save.py outside MCP)"
    )
    update_json_mcp_config(
        user_home / ".factory" / "mcp.json",
        runtime["obsidian_server_key"],
        obsidian_command_name,
        obsidian_args,
        factory_style=True,
        env=obsidian_env,
    )
    summary.append(f"Updated ~/.factory/mcp.json for {runtime['obsidian_server_key']}")


def patch_skill_mcp_configs(runtime: dict[str, Any], summary: list[str]) -> None:
    user_home = Path.home()
    skill_script_path: Path = runtime["skill_script_path"]
    if not skill_script_path.exists():
        fallback = runtime["workspace_root"] / "support" / "scripts" / "llm_wiki_skill_mcp.py"
        if fallback.exists():
            skill_script_path = fallback
    if not skill_script_path.exists():
        summary.append(f"Skill MCP script not found, skipping {runtime['skill_server_key']} MCP wiring")
        return

    python_command = resolve_python_command()
    skill_command_name = python_command[0]
    skill_args = [*python_command[1:], str(skill_script_path), "--workspace", str(runtime["workspace_root"]), "mcp"]
    update_json_mcp_config(user_home / ".claude" / "settings.json", runtime["skill_server_key"], skill_command_name, skill_args, factory_style=False)
    summary.append(f"Updated ~/.claude/settings.json for {runtime['skill_server_key']}")
    update_codex_toml(
        user_home / ".codex" / "config.toml",
        runtime["skill_server_key"],
        skill_command_name,
        skill_args,
        startup_timeout_sec=DEFAULT_SKILL_MCP_STARTUP_TIMEOUT_SEC,
    )
    summary.append(f"Updated ~/.codex/config.toml for {runtime['skill_server_key']}")
    update_json_mcp_config(user_home / ".factory" / "mcp.json", runtime["skill_server_key"], skill_command_name, skill_args, factory_style=True)
    summary.append(f"Updated ~/.factory/mcp.json for {runtime['skill_server_key']}")


def patch_hf_mcp_configs(summary: list[str]) -> None:
    """Wire the Hugging Face Hub MCP server via mcp-remote (pinned).

    Only written when HF_TOKEN is present in the environment - we never
    persist the token itself to disk. Config values use ${HF_AUTH_HEADER}
    interpolation, with the env block holding `Bearer ${HF_TOKEN}` so MCP
    clients can resolve the token at launch time. The two-step indirection
    (HF_AUTH_HEADER -> Bearer ${HF_TOKEN}) avoids spaces in stdio args,
    which trip a known npx-args-mangling bug on Claude Desktop / Cursor on
    Windows (per the mcp-remote upstream README).

    Only Claude Code (`~/.claude/settings.json`) and Factory (`~/.factory/mcp.json`)
    are wired automatically. Codex is intentionally skipped: as of this writing,
    Codex's stdio MCP launcher does NOT expand ${VAR} in args or env values,
    so the wired entry would silently fail authentication. Users wanting HF
    Hub MCP from Codex should configure it manually via Codex's HTTP MCP +
    bearer_token_env_var path.
    """
    if not os.environ.get("HF_TOKEN"):
        summary.append("Skipped Hugging Face MCP wiring (HF_TOKEN not set)")
        return
    user_home = Path.home()
    command_name = "npx"
    args = [
        "-y",
        "mcp-remote@0.1.38",
        "https://huggingface.co/mcp",
        "--header",
        "Authorization:${HF_AUTH_HEADER}",
    ]
    env = {"HF_AUTH_HEADER": "Bearer ${HF_TOKEN}"}
    update_json_mcp_config(
        user_home / ".claude" / "settings.json",
        "huggingface",
        command_name,
        args,
        factory_style=False,
        env=env,
    )
    summary.append("Updated ~/.claude/settings.json for huggingface")
    update_json_mcp_config(
        user_home / ".factory" / "mcp.json",
        "huggingface",
        command_name,
        args,
        factory_style=True,
        env=env,
    )
    summary.append("Updated ~/.factory/mcp.json for huggingface")
    summary.append(
        "Skipped ~/.codex/config.toml for huggingface (Codex stdio MCP does not expand ${VAR}; "
        "wire manually via HTTP MCP + bearer_token_env_var if needed)"
    )


def patch_mcp_configs(runtime: dict[str, Any], qmd_command: str | None, obsidian_command: str | None, summary: list[str]) -> None:
    if obsidian_command:
        patch_obsidian_mcp_configs(runtime, obsidian_command, summary)
    if qmd_command:
        patch_qmd_mcp_configs(qmd_command, summary)
    patch_skill_mcp_configs(runtime, summary)
    patch_hf_mcp_configs(summary)


def resolve_runtime_script_path(runtime: dict[str, Any], runtime_key: str, fallback_relative: str) -> Path:
    script_path = Path(runtime[runtime_key])
    if script_path.exists():
        return script_path
    fallback = runtime["workspace_root"] / fallback_relative
    if fallback.exists():
        return fallback
    return script_path


def powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_claude_failure_hook_handler(
    runtime: dict[str, Any],
    *,
    python_command: list[str] | None = None,
    use_powershell: bool | None = None,
) -> dict[str, Any]:
    workspace_root: Path = runtime["workspace_root"]
    script_path = resolve_runtime_script_path(
        runtime,
        "failure_hook_script_path",
        "support/scripts/llm_wiki_failure_hook.py",
    ).resolve(strict=False)
    python_command = python_command or resolve_python_command()
    use_powershell = os.name == "nt" if use_powershell is None else use_powershell
    try:
        relative_script = script_path.relative_to(workspace_root.resolve(strict=False)).as_posix()
    except ValueError:
        relative_script = ""

    if use_powershell:
        script_expr = powershell_quote(str(script_path))
        if relative_script:
            relative_script_windows = relative_script.replace("/", "\\")
            script_expr = f"(Join-Path $env:CLAUDE_PROJECT_DIR {powershell_quote(relative_script_windows)})"
        python_invocation = " ".join(powershell_quote(part) for part in python_command)
        return {
            "type": "command",
            "shell": "powershell",
            "timeout": 30,
            "command": (
                "$workspace = $env:CLAUDE_PROJECT_DIR; "
                f"$script = {script_expr}; "
                f"& {python_invocation} $script --workspace $workspace"
            ),
        }

    script_assignment = f"script={shlex.quote(str(script_path))}"
    if relative_script:
        script_assignment = f'script="$workspace"/{shlex.quote(relative_script)}'
    python_invocation = " ".join(shlex.quote(part) for part in python_command)
    return {
        "type": "command",
        "timeout": 30,
        "command": (
            'workspace="$CLAUDE_PROJECT_DIR"; '
            f"{script_assignment}; "
            f'{python_invocation} "$script" --workspace "$workspace"'
        ),
    }


def is_managed_failure_hook(handler: Any) -> bool:
    if not isinstance(handler, dict):
        return False
    command = str(handler.get("command") or "")
    return bool(command) and any(marker in command for marker in MANAGED_FAILURE_HOOK_MARKERS)


def remove_managed_failure_hooks(groups: Any) -> list[Any]:
    if not isinstance(groups, list):
        return []
    cleaned: list[Any] = []
    for group in groups:
        if not isinstance(group, dict):
            cleaned.append(group)
            continue
        hooks = group.get("hooks")
        if not isinstance(hooks, list):
            cleaned.append(group)
            continue
        filtered = [hook for hook in hooks if not is_managed_failure_hook(hook)]
        if filtered:
            replacement = dict(group)
            replacement["hooks"] = filtered
            cleaned.append(replacement)
    return cleaned


def update_claude_hook_settings(path: Path, handlers: dict[str, dict[str, Any]]) -> None:
    payload = load_json(path)
    hooks = payload.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    for event_name, handler in handlers.items():
        groups = remove_managed_failure_hooks(hooks.get(event_name))
        groups.append({"matcher": "*", "hooks": [handler]})
        hooks[event_name] = groups
    payload["hooks"] = hooks
    save_json(path, payload)


def patch_claude_local_hook_settings(runtime: dict[str, Any], summary: list[str]) -> None:
    hook_script_path = resolve_runtime_script_path(
        runtime,
        "failure_hook_script_path",
        "support/scripts/llm_wiki_failure_hook.py",
    )
    if not hook_script_path.exists():
        summary.append(f"Failure hook script not found, skipping Claude hook wiring: {hook_script_path}")
        return
    settings_path = runtime["workspace_root"] / ".claude" / "settings.local.json"
    update_claude_hook_settings(
        settings_path,
        {
            "PostToolUseFailure": build_claude_failure_hook_handler(runtime),
            "StopFailure": build_claude_failure_hook_handler(runtime),
        },
    )
    summary.append(f"Updated {settings_path} with llm-wiki failure hooks")


def qmd_supports_collections(qmd_command: str) -> bool:
    result = run_command(qmd_command, [], timeout=30)
    output = "\n".join(filter(None, [result.stdout, result.stderr]))
    return "collection add" in output


def bootstrap_qmd(runtime: dict[str, Any], qmd_command: str, summary: list[str], failures: list[str], state: dict[str, Any]) -> None:
    if not qmd_supports_collections(qmd_command):
        summary.append(f"{qmd_command} does not expose collection commands; skipping collection bootstrap.")
        return

    collection_name = str(runtime["qmd_collection"])
    source_path: Path = runtime["qmd_source_path"]
    qmd_env = qmd_runtime_env(runtime)
    collection_output = run_command(qmd_command, ["collection", "list"], env=qmd_env, timeout=60)
    if f"{collection_name} (qmd://" not in collection_output.stdout:
        if runtime["verify_only"]:
            failures.append(f"Missing qmd collection: {collection_name}")
            return
        run_command(qmd_command, ["collection", "add", str(source_path), "--name", collection_name], env=qmd_env, check=True, timeout=300)
        summary.append(f"Added qmd collection: {collection_name}")
    else:
        summary.append(f"qmd collection already present: {collection_name}")

    context_output = run_command(qmd_command, ["context", "list"], env=qmd_env, timeout=60)
    context_path = f"qmd://{collection_name}/"
    if runtime["qmd_context"] and context_path not in context_output.stdout:
        if runtime["verify_only"]:
            failures.append(f"Missing qmd context: {context_path}")
        else:
            run_command(qmd_command, ["context", "add", context_path, str(runtime["qmd_context"])], env=qmd_env, check=True, timeout=300)
            summary.append(f"Added qmd context: {context_path}")
    elif runtime["qmd_context"]:
        summary.append(f"qmd context already present: {context_path}")

    if runtime["verify_only"] or runtime["skip_qmd_embed"]:
        record_state(state, "setup", "qmd", "collection_bootstrapped_at", value=current_timestamp())
        return

    try:
        runner = runtime["workspace_root"] / "scripts" / "qmd_embed_runner.mjs"
        if runner.exists() and command_in_path("node"):
            runner_args = [
                str(runner),
                "--workspace",
                str(runtime["workspace_root"]),
                "--collection",
                collection_name,
                "--command",
                qmd_command,
            ]
            if env_flag("GEMINI_API_KEY"):
                runner_args.append("--include-images")
            run_command("node", runner_args, env=qmd_env, check=True, timeout=1800)
            summary.append("Ran qmd embed runner")
        else:
            run_command(qmd_command, ["update"], env=qmd_env, check=True, timeout=1800)
            run_command(qmd_command, ["embed"], env=qmd_env, check=True, timeout=1800)
            if env_flag("GEMINI_API_KEY"):
                result = run_command(qmd_command, [], env=qmd_env, timeout=30)
                if "membed" in "\n".join(filter(None, [result.stdout, result.stderr])):
                    run_command(qmd_command, ["membed"], env=qmd_env, check=True, timeout=1800)
                    summary.append("Ran qmd text + image embeddings")
                else:
                    summary.append("Ran qmd text embeddings")
            else:
                summary.append("Ran qmd text embeddings")
    except Exception as exc:  # noqa: BLE001
        summary.append(f"qmd embedding deferred: {exc}")
    record_state(state, "setup", "qmd", "collection_bootstrapped_at", value=current_timestamp())


def verify_skill_pipeline(runtime: dict[str, Any], failures: list[str]) -> None:
    skill_script_path: Path = runtime["skill_script_path"]
    if not skill_script_path.exists():
        failures.append(f"Missing skill MCP script: {skill_script_path}")
    failure_hook_script_path = resolve_runtime_script_path(
        runtime,
        "failure_hook_script_path",
        "support/scripts/llm_wiki_failure_hook.py",
    )
    if not failure_hook_script_path.exists():
        failures.append(f"Missing skill failure hook script: {failure_hook_script_path}")
    registry_path: Path = runtime["skill_registry_path"]
    if not registry_path.exists():
        failures.append(f"Missing skill registry: {registry_path}")
    else:
        try:
            registry = load_json(registry_path)
        except json.JSONDecodeError:
            failures.append(f"Skill registry is not valid JSON: {registry_path}")
        else:
            if "packets" not in registry:
                failures.append(f"Skill registry missing packets collection: {registry_path}")
    for key, directory in runtime["skill_pipeline_paths"].items():
        if not directory.exists():
            failures.append(f"Missing skill pipeline {key.replace('_', ' ')}: {directory}")


def ensure_skill_index(runtime: dict[str, Any], summary: list[str], failures: list[str], state: dict[str, Any] | None = None) -> None:
    try:
        from skill_index import ensure_index as ensure_skill_index_file, index_needs_rebuild

        workspace_root: Path = runtime["workspace_root"]
        needs_rebuild = index_needs_rebuild(workspace_root)
        if runtime.get("verify_only") and needs_rebuild:
            failures.append(f"Skill index missing or stale: {runtime.get('skill_index_path', workspace_root / '.llm-wiki' / 'skill-index.json')}")
            return
        index_path = ensure_skill_index_file(workspace_root)
        if not index_path.exists():
            failures.append(f"Skill index was not created: {index_path}")
            return
        summary.append(f"Skill index {'refreshed' if needs_rebuild else 'current'}: {index_path}")
        if state is not None:
            record_state(state, "setup", "skills", "index_built_at", value=current_timestamp())
    except Exception as exc:  # noqa: BLE001
        failures.append(f"Skill index refresh failed: {exc}")


def verify_agent_failure_capture(runtime: dict[str, Any], summary: list[str], failures: list[str]) -> None:
    script_path: Path = runtime["agent_failure_capture_script_path"]
    if not script_path.exists():
        failures.append(f"Missing agent failure capture script: {script_path}")
    for key, path in runtime["agent_failure_launcher_paths"].items():
        if not path.exists():
            failures.append(f"Missing agent failure launcher ({key}): {path}")
    for agent, command_name in runtime["agent_failure_commands"].items():
        resolved = command_in_path(command_name)
        if resolved:
            summary.append(f"Agent runtime detected: {agent} -> {resolved}")
        else:
            summary.append(f"Agent runtime detected: {agent} -> missing ({command_name})")


def init_brv_workspace(runtime: dict[str, Any], brv_command: str, summary: list[str], failures: list[str], state: dict[str, Any]) -> None:
    workspace_root: Path = runtime["workspace_root"]
    config_path = workspace_root / ".brv" / "config.json"
    if config_path.exists():
        summary.append("BRV workspace already initialized")
        return
    if runtime["verify_only"]:
        failures.append(f"Missing BRV workspace config: {config_path}")
        return
    result = run_command(brv_command, ["status", "--format", "json"], cwd=workspace_root, timeout=300)
    if result.returncode != 0:
        failures.append(result.stderr.strip() or result.stdout.strip() or "brv status failed during workspace init")
        return
    if config_path.exists():
        record_state(state, "setup", "brv", "workspace_initialized_at", value=current_timestamp())
        summary.append("Initialized BRV workspace via status")
    else:
        summary.append(f"BRV status ran but no config was created at {config_path}")


def verify_brv_status(runtime: dict[str, Any], brv_command: str, summary: list[str], failures: list[str]) -> None:
    result = run_command(brv_command, ["status", "--format", "json"], cwd=runtime["workspace_root"], timeout=120)
    if result.returncode == 0:
        summary.append("brv reachable: status ok")
    else:
        failures.append(result.stderr.strip() or result.stdout.strip() or f"brv status failed for {brv_command}")
        return
    providers = run_command(brv_command, ["providers", "list", "--format", "json"], timeout=120)
    payload = last_json_line(providers.stdout) if providers.returncode == 0 else None
    connected_provider = ""
    if isinstance(payload, dict):
        providers_list = payload.get("data", {}).get("providers", [])
        for provider in providers_list:
            if provider.get("isConnected"):
                connected_provider = str(provider.get("id") or "")
                break
    if connected_provider:
        summary.append(f"brv provider connected: {connected_provider}")
    else:
        summary.append("Next BRV steps: connect a provider before using brv_query/brv_curate, e.g. 'brv providers connect byterover'.")
    if not os.getenv("BYTEROVER_API_KEY"):
        summary.append("Optional BRV cloud auth: brv login --api-key <key> or export BYTEROVER_API_KEY")


def resolve_gitvizz_managed_path(runtime: dict[str, Any]) -> Path | None:
    return runtime.get("gitvizz_checkout_path") or runtime.get("gitvizz_repo_path")


def gitvizz_compose_file(repo_path: Path) -> Path | None:
    for candidate in ("docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"):
        path = repo_path / candidate
        if path.exists():
            return path
    return None


def ensure_gitvizz_checkout(runtime: dict[str, Any], summary: list[str], failures: list[str]) -> Path | None:
    managed_path = resolve_gitvizz_managed_path(runtime)
    if managed_path is None:
        return None
    repo_url = str(runtime.get("gitvizz_repo_url") or "")
    if managed_path.exists():
        summary.append(f"GitVizz checkout resolved: {managed_path}")
        return managed_path
    if runtime["verify_only"]:
        summary.append(f"GitVizz checkout resolved: missing ({managed_path})")
        return managed_path
    if not repo_url:
        failures.append(f"GitVizz checkout path is missing and no repo URL was configured: {managed_path}")
        return managed_path
    git = resolve_git_command()
    if not git:
        failures.append("git is required to acquire the configured GitVizz checkout")
        return managed_path
    managed_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        run_command(git, ["clone", repo_url, str(managed_path)], check=True, timeout=1200)
        summary.append(f"GitVizz checkout installed: {managed_path}")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"GitVizz checkout install failed: {exc}")
    return managed_path


def maybe_start_gitvizz(runtime: dict[str, Any], summary: list[str], failures: list[str], state: dict[str, Any]) -> None:
    frontend = str(runtime["gitvizz_frontend_url"])
    backend = str(runtime["gitvizz_backend_url"])
    managed_path = ensure_gitvizz_checkout(runtime, summary, failures)
    if check_tcp_url(frontend) and check_tcp_url(backend):
        summary.append("GitVizz launch state: already reachable")
        return
    if runtime["verify_only"]:
        summary.append("GitVizz launch state: verify-only")
        return
    if managed_path is None:
        summary.append("GitVizz launch state: unmanaged endpoint only")
        return
    compose_file = gitvizz_compose_file(managed_path)
    if not compose_file:
        failures.append(f"GitVizz checkout is missing a compose file: {managed_path}")
        return
    docker = command_in_path("docker")
    docker_compose = command_in_path("docker-compose")
    try:
        if docker:
            run_command("docker", ["compose", "-f", str(compose_file), "up", "-d", "--build"], check=True, timeout=1800)
        elif docker_compose:
            run_command(docker_compose, ["-f", str(compose_file), "up", "-d", "--build"], check=True, timeout=1800)
        else:
            failures.append("docker compose is required to launch GitVizz from a managed checkout")
            return
        record_state(state, "setup", "gitvizz", "last_launch_at", value=current_timestamp())
        if check_tcp_url(frontend) and check_tcp_url(backend):
            summary.append("GitVizz launch state: launched")
        else:
            failures.append("GitVizz launch completed but the configured endpoints are still unreachable.")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"GitVizz launch failed: {exc}")


def verify_gitvizz(runtime: dict[str, Any], summary: list[str], failures: list[str]) -> None:
    frontend = str(runtime["gitvizz_frontend_url"])
    backend = str(runtime["gitvizz_backend_url"])
    repo_id = str(runtime.get("gitvizz_repo_id") or "")
    summary.append(f"GitVizz configured frontend: {frontend}")
    summary.append(f"GitVizz configured backend: {backend}")
    summary.append(f"GitVizz configured repo id: {repo_id or 'missing'}")
    managed_path = resolve_gitvizz_managed_path(runtime)
    managed = managed_path is not None
    if check_tcp_url(frontend):
        summary.append(f"GitVizz frontend reachable: {frontend}")
    elif managed:
        failures.append(f"GitVizz frontend unreachable: {frontend}")
    else:
        summary.append(f"GitVizz frontend reachable: missing ({frontend}); endpoint-only mode remains allowed")

    if check_tcp_url(backend):
        summary.append(f"GitVizz backend reachable: {backend}")
        if repo_id:
            status, payload, raw = post_form_json(
                f"{backend.rstrip('/')}/api/backend-chat/context/search",
                {"repository_id": repo_id, "query": "health check", "max_results": 1},
                timeout=5,
                authorization=runtime_gitvizz_authorization(runtime),
            )
            if status == 200:
                summary.append("GitVizz context search reachable: ok")
            elif status in {401, 403}:
                summary.append(
                    "GitVizz context search reachable: auth required "
                    f"(set {runtime.get('gitvizz_authorization_env')} or {runtime.get('gitvizz_auth_token_env')})"
                )
            elif status:
                summary.append(f"GitVizz context search reachable: degraded HTTP {status}")
            else:
                summary.append(f"GitVizz context search reachable: degraded ({str(raw)[:160]})")
            if isinstance(payload, dict):
                count = len(payload.get("results", [])) if isinstance(payload.get("results"), list) else 0
                summary.append(f"GitVizz context search sample results: {count}")
        else:
            summary.append("GitVizz context search reachable: skipped (repo id missing)")
    elif managed:
        failures.append(f"GitVizz backend unreachable: {backend}")
    else:
        summary.append(f"GitVizz backend reachable: missing ({backend}); endpoint-only mode remains allowed")


def path_within(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve(strict=False).relative_to(base.resolve(strict=False))
        return True
    except ValueError:
        return False


def can_write_directory(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".llm-wiki-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def verify_wiki_layer(runtime: dict[str, Any], summary: list[str], failures: list[str]) -> None:
    provider = str(runtime.get("wiki_provider") or "")
    vault_path: Path = runtime["wiki_vault_path"]
    summary.append(f"Wiki layer provider: {provider or 'missing'}")
    summary.append(f"Wiki layer behavior: {runtime.get('wiki_behavior_layer')}")
    summary.append(f"Wiki layer transport: {runtime.get('wiki_transport')}")
    summary.append(f"Wiki layer vault: {vault_path}")

    if provider != "obsidian":
        failures.append(f"Unsupported wiki layer provider: {provider or 'missing'}")
        return

    if not vault_path.exists():
        failures.append(f"Wiki layer vault path missing: {vault_path}")
        return

    required_paths: list[Path] = [
        runtime["wiki_raw_path"],
        runtime["wiki_path"],
        runtime["wiki_index_path"],
        runtime["wiki_log_path"],
        runtime["wiki_hot_cache_path"],
    ]
    for path in required_paths:
        if not path_within(vault_path, path):
            failures.append(f"Wiki layer path escapes vault: {path}")
            return

    if not can_write_directory(runtime["wiki_path"]):
        failures.append(f"Wiki layer is not writable: {runtime['wiki_path']}")
        return

    runtime["wiki_raw_path"].mkdir(parents=True, exist_ok=True)
    runtime["wiki_path"].mkdir(parents=True, exist_ok=True)
    defaults = {
        runtime["wiki_index_path"]: "# Wiki Index\n\n",
        runtime["wiki_log_path"]: "# Wiki Log\n\n",
        runtime["wiki_hot_cache_path"]: (
            "---\ntype: meta\ntitle: \"Hot Cache\"\nupdated: \n---\n\n"
            "# Recent Context\n\n## Key Recent Facts\n\n## Recent Changes\n\n## Active Threads\n\n"
        ),
    }
    for path, content in defaults.items():
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            summary.append(f"Wiki layer created missing file: {path}")

    if not runtime.get("wiki_note_types") or not runtime.get("wiki_research_note_types"):
        failures.append("Wiki layer note taxonomy is missing")
        return

    transport_available = bool(first_existing(runtime.get("obsidian_local_candidates", [])) or command_in_path("mcpvault"))
    if transport_available:
        summary.append("Wiki layer transport readiness: MCP transport available")
    elif runtime.get("wiki_direct_file_fallback"):
        summary.append("Wiki layer transport readiness: MCP unavailable; direct file fallback active")
    else:
        failures.append("Wiki layer transport unavailable and direct file fallback disabled")
        return

    summary.append("Wiki layer readiness: ok")


def run_setup(runtime: dict[str, Any], summary: list[str], failures: list[str], state: dict[str, Any]) -> None:
    summary.append(f"Managed install scope: {runtime['install_scope']}")
    summary.append(f"Managed tool root: {runtime['managed_tool_root']}")
    summary.append(f"Official memory base: {runtime['memory_base_path']}")
    if runtime["memory_base_id"]:
        summary.append(f"Official memory base id: {runtime['memory_base_id']}")
    if runtime["allow_global_tool_install"]:
        summary.append("Global tool install fallback enabled")
    else:
        summary.append("Global tool install fallback disabled; managed installs only")

    if not runtime["skip_qmd"]:
        qmd_command = ensure_managed_qmd(runtime, summary, failures, state)
        if qmd_command:
            runtime["qmd_command"] = qmd_command
            status_result = run_command(qmd_command, ["status"], timeout=120)
            if status_result.returncode == 0:
                summary.append("pk-qmd reachable: status ok")
            else:
                failures.append(status_result.stderr.strip() or status_result.stdout.strip() or f"pk-qmd status failed for {qmd_command}")
            if status_result.returncode == 0 and not runtime["skip_qmd_bootstrap"]:
                bootstrap_qmd(runtime, qmd_command, summary, failures, state)

    obsidian_command: str | None = None
    if not runtime["skip_mcp"]:
        obsidian_command = ensure_managed_obsidian(runtime, summary, failures, state)
        if obsidian_command:
            runtime["obsidian_command"] = obsidian_command

    if not runtime["skip_mcp"]:
        patch_mcp_configs(runtime, runtime.get("qmd_command"), obsidian_command, summary)

        patch_claude_local_hook_settings(runtime, summary)

    if not runtime["skip_brv"]:
        brv_command = ensure_brv_command(runtime, summary, failures, state)
        if brv_command:
            runtime["brv_command"] = brv_command
            verify_brv_status(runtime, brv_command, summary, failures)
            if not runtime["skip_brv_init"]:
                init_brv_workspace(runtime, brv_command, summary, failures, state)

    verify_skill_pipeline(runtime, failures)
    ensure_skill_index(runtime, summary, failures, state)
    verify_agent_failure_capture(runtime, summary, failures)
    verify_wiki_layer(runtime, summary, failures)

    if runtime["skip_gitvizz"]:
        summary.append("GitVizz checks skipped")
    else:
        if not runtime["skip_gitvizz_start"]:
            maybe_start_gitvizz(runtime, summary, failures, state)
        else:
            summary.append("GitVizz launch state: skipped")
        verify_gitvizz(runtime, summary, failures)


def run_health_check(runtime: dict[str, Any], summary: list[str], failures: list[str]) -> None:
    summary.append("=== llm-wiki-memory health check ===")
    summary.append(f"Config: {runtime['config_path']}")
    summary.append(f"Memory base: {runtime['memory_base_name']} -> {runtime['memory_base_path']}")
    if runtime["memory_base_id"]:
        summary.append(f"Memory base id: {runtime['memory_base_id']}")

    if not runtime["skip_qmd"]:
        qmd_command = ensure_managed_qmd(runtime, summary, failures, {})
        if qmd_command:
            runtime["qmd_command"] = qmd_command
            status_result = run_command(qmd_command, ["status"], cwd=runtime["workspace_root"], timeout=120)
            if status_result.returncode != 0:
                failures.append(status_result.stderr.strip() or status_result.stdout.strip() or f"pk-qmd status failed for {qmd_command}")

    if not runtime["skip_brv"]:
        brv_command = ensure_brv_command(runtime, summary, failures, {})
        if brv_command:
            verify_brv_status(runtime, brv_command, summary, failures)
            init_brv_workspace(runtime, brv_command, [], failures, {})

    verify_skill_pipeline(runtime, failures)
    ensure_skill_index(runtime, summary, failures)
    verify_agent_failure_capture(runtime, summary, failures)
    verify_wiki_layer(runtime, summary, failures)

    if runtime["skip_gitvizz"]:
        summary.append("GitVizz checks skipped.")
    else:
        verify_gitvizz(runtime, summary, failures)


def main() -> int:
    args = parse_args()
    runtime = build_runtime(args)
    summary: list[str] = []
    failures: list[str] = []
    state = load_setup_state(runtime["workspace_root"])
    record_state(state, "version", value=1)
    record_state(state, "last_run_mode", value=args.mode)
    record_state(state, "last_run_at", value=current_timestamp())

    if args.mode == "setup":
        run_setup(runtime, summary, failures, state)
        if not runtime["verify_only"]:
            save_setup_state(runtime["workspace_root"], state)
    else:
        run_health_check(runtime, summary, failures)

    for line in summary:
        print(line)
    if failures:
        for line in failures:
            print(line, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
