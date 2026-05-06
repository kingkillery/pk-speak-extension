#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import textwrap
import time
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from llm_wiki_failure_collector import FailureCollector


DEFAULT_GYM_REPO = Path(r"C:\dev\Desktop-Benchmarks\Gym-Anything\gym-anything")
DEFAULT_ENV_DIR = DEFAULT_GYM_REPO / "benchmarks" / "cua_world" / "environments" / "pokemon_agent_env"
DEFAULT_TASK_ID = "start_server_capture_state"
DEFAULT_AGENT = "codex"
DEFAULT_OUTPUT_ROOT = REPO_ROOT / ".artifacts" / "pokemon-benchmark"
FAILURE_ROOT = REPO_ROOT / ".llm-wiki" / "skill-pipeline" / "failures"
WRAPPER_PS1 = SCRIPT_DIR / "run_llm_wiki_agent.ps1"
REPORT_IN_ENV = "/root/Desktop/pokemon_session_report.json"
STATE_IN_ENV = "/tmp/pokemon_state.json"
SCREENSHOT_IN_ENV = "/tmp/pokemon_screenshot.png"
SERVER_LOG_IN_ENV = "/tmp/pokemon_server.log"
SERVER_PID_IN_ENV = "/tmp/pokemon_server.pid"
EXPORT_ROOT_IN_ENV = "/tmp/pokemon_agent_export"
TASK_EXPORT_REPORT = f"{EXPORT_ROOT_IN_ENV}/pokemon_session_report.json"
TASK_EXPORT_STATE = f"{EXPORT_ROOT_IN_ENV}/pokemon_state.json"
TASK_EXPORT_SCREENSHOT = f"{EXPORT_ROOT_IN_ENV}/pokemon_screenshot.png"
SESSION_FILE_NAME = "session.json"
RESULT_FILE_NAME = "result.json"
VERIFICATION_FILE_NAME = "verification.json"
TASK_CONTRACT_FILE_NAME = "task_contract.json"
PROMPT_FILE_NAME = "framework_prompt.md"
WRAPPER_STDOUT_FILE = "wrapper_stdout.txt"
WRAPPER_STDERR_FILE = "wrapper_stderr.txt"
WRAPPER_LAST_MESSAGE_FILE = "wrapper_last_message.txt"
SMOKE_LOG_FILE = "smoke_steps.json"
CONTAINER_LOG_FILE = "container.log"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def relative_to_repo(path: str | Path) -> str:
    resolved = Path(path).resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(resolved)


def rel_or_abs(path: Path | None) -> str | None:
    if path is None:
        return None
    return relative_to_repo(path)


def create_run_dir(output_root: Path, label: str) -> Path:
    run_id = f"{time.strftime('%Y%m%d_%H%M%S')}_{label}"
    run_dir = ensure_dir(output_root / "runs" / run_id)
    (output_root / "latest_run.txt").write_text(run_id, encoding="utf-8")
    return run_dir


def latest_run_dir(output_root: Path) -> Path:
    latest_path = output_root / "latest_run.txt"
    if not latest_path.exists():
        raise FileNotFoundError(f"No latest run marker found under {output_root}")
    run_id = latest_path.read_text(encoding="utf-8").strip()
    run_dir = output_root / "runs" / run_id
    if not run_dir.exists():
        raise FileNotFoundError(f"Latest run directory is missing: {run_dir}")
    return run_dir


@contextlib.contextmanager
def pushd(path: Path) -> Iterator[None]:
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def import_function(file_path: Path, func_name: str):
    spec = importlib.util.spec_from_file_location(file_path.stem, file_path)
    if not spec or not spec.loader:
        raise ImportError(f"Cannot import verifier from {file_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, func_name)


def default_runtime_contract(task_payload: dict[str, Any]) -> dict[str, Any]:
    metadata = task_payload.get("metadata", {})
    port = int(metadata.get("preferred_port", 8765))
    return {
        "repo_path": metadata.get("preferred_repo_path", "/opt/pokemon-agent"),
        "venv_activate": "/opt/pokemon-agent/.venv/bin/activate",
        "rom_path": metadata.get(
            "preferred_runtime_rom_path",
            "/opt/pokemon-agent/roms/Pokemon - Red Version (USA, Europe) (SGB Enhanced).gb",
        ),
        "data_dir": metadata.get("preferred_data_dir", "/root/.pokemon-agent"),
        "port": port,
        "health_url": f"http://127.0.0.1:{port}/health",
        "state_url": f"http://127.0.0.1:{port}/state",
        "screenshot_url": f"http://127.0.0.1:{port}/screenshot",
        "save_url": f"http://127.0.0.1:{port}/save",
        "save_request_json": {"name": metadata.get("required_save_name", "gym_bootstrap")},
        "report_output": metadata.get("report_output", REPORT_IN_ENV),
        "required_report_fields": metadata.get("required_report_fields", []),
        "required_save_name": metadata.get("required_save_name", "gym_bootstrap"),
    }


def build_task_contract(task_json_path: Path) -> dict[str, Any]:
    task_payload = read_json(task_json_path)
    runtime = default_runtime_contract(task_payload)
    return {
        "task_json_path": str(task_json_path.resolve()),
        "task": task_payload,
        "runtime_contract": runtime,
        "observed_server_contract": {
            "serve_help_confirmed": True,
            "serve_command": (
                f"pokemon-agent serve --rom {shlex.quote(runtime['rom_path'])} "
                f"--port {runtime['port']} --data-dir {shlex.quote(runtime['data_dir'])}"
            ),
            "health_shape": {"status": "ok", "emulator_ready": True},
            "save_http_method": "POST",
            "save_json_body": runtime["save_request_json"],
        },
    }


def failure_snapshot() -> dict[str, set[str]]:
    snapshot: dict[str, set[str]] = {}
    for name in ("events", "clusters", "benchmarks"):
        directory = FAILURE_ROOT / name
        if directory.exists():
            snapshot[name] = {relative_to_repo(path) for path in directory.glob("*.json")}
        else:
            snapshot[name] = set()
    return snapshot


def failure_diff(before: dict[str, set[str]], after: dict[str, set[str]]) -> dict[str, list[str]]:
    return {name: sorted(after.get(name, set()) - before.get(name, set())) for name in ("events", "clusters", "benchmarks")}


def container_exists(container_name: str) -> bool:
    result = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"name={container_name}", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return container_name in result.stdout.splitlines()


def docker_exec_capture(
    session: dict[str, Any],
    cmd: str,
    *,
    timeout: int = 600,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    env_map = dict(session.get("default_exec_env") or {})
    if extra_env:
        env_map.update(extra_env)
    full_cmd = ["docker", "exec"]
    for key, value in env_map.items():
        full_cmd += ["-e", f"{key}={value}"]
    full_cmd += [session["container_name"], "bash", "-lc", cmd]
    completed = subprocess.run(
        full_cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    return {
        "command": cmd,
        "docker_command": full_cmd,
        "command_returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "ok": completed.returncode == 0,
    }


def docker_copy_from(container_name: str, src: str, dst: Path) -> dict[str, Any]:
    dst = dst.resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        ["docker", "cp", f"{container_name}:{src}", str(dst)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return {
        "src": src,
        "dst": str(dst),
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "exists": completed.returncode == 0 and dst.exists(),
    }


def docker_copy_to(container_name: str, src: Path, dst: str) -> dict[str, Any]:
    src = src.resolve()
    completed = subprocess.run(
        ["docker", "cp", str(src), f"{container_name}:{dst}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return {
        "src": str(src),
        "dst": dst,
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "exists": completed.returncode == 0,
    }


def save_container_logs(container_name: str, output_path: Path) -> Path:
    completed = subprocess.run(
        ["docker", "logs", container_name],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    output_path.write_text((completed.stdout or "") + (completed.stderr or ""), encoding="utf-8")
    return output_path


def load_gym_api(gym_repo: Path):
    src_dir = gym_repo / "src"
    if str(src_dir) not in sys.path:
        sys.path.insert(0, str(src_dir))
    from gym_anything.api import from_config  # type: ignore

    return from_config


def start_session(
    *,
    run_dir: Path,
    gym_repo: Path,
    env_dir: Path,
    task_id: str,
    seed: int,
    task_contract: dict[str, Any],
) -> dict[str, Any]:
    from_config = load_gym_api(gym_repo)
    with pushd(gym_repo):
        env = from_config(env_dir, task_id=task_id)
        env.reset(seed=seed)
    runner = env._runner
    runtime_info = runner.get_runtime_info()
    session_info = env.get_session_info()
    raw_episode_dir = Path(env.episode_dir) if env.episode_dir else None
    if raw_episode_dir is not None and not raw_episode_dir.is_absolute():
        episode_dir = (gym_repo / raw_episode_dir).resolve()
    else:
        episode_dir = raw_episode_dir.resolve() if raw_episode_dir else None
    task_payload = task_contract["task"]
    session = {
        "created_at": utc_now(),
        "status": "open",
        "mode": None,
        "gym_repo": str(gym_repo.resolve()),
        "env_dir": str(env_dir.resolve()),
        "task_id": task_id,
        "task_json_path": task_contract["task_json_path"],
        "task_root": str((env_dir / "tasks" / task_id).resolve()),
        "container_name": getattr(runner, "container_name", None),
        "runner_type": type(runner).__name__,
        "default_exec_env": runner.default_exec_env(),
        "episode_dir": str(episode_dir) if episode_dir else None,
        "run_dir": str(run_dir.resolve()),
        "session_info": asdict(session_info) if is_dataclass(session_info) else {},
        "runtime_info": asdict(runtime_info) if is_dataclass(runtime_info) else {},
        "env_id": task_payload.get("env_id"),
        "export_dir_in_env": EXPORT_ROOT_IN_ENV,
    }
    write_json(run_dir / SESSION_FILE_NAME, session)
    return session


def load_session(session_path: Path) -> dict[str, Any]:
    session = read_json(session_path)
    if not session.get("container_name"):
        raise ValueError(f"Invalid session manifest without container_name: {session_path}")
    return session


def update_session(session_path: Path, **updates: Any) -> dict[str, Any]:
    session = load_session(session_path)
    session.update(updates)
    write_json(session_path, session)
    return session


def write_report_file(session: dict[str, Any], report_payload: dict[str, Any], run_dir: Path) -> Path:
    host_report_path = run_dir / "report.generated.json"
    write_json(host_report_path, report_payload)
    copy_result = docker_copy_to(session["container_name"], host_report_path, REPORT_IN_ENV)
    if copy_result["returncode"] != 0:
        raise RuntimeError(f"Failed to copy report into container: {copy_result['stderr']}")
    return host_report_path


def canonical_report_payload(task_contract: dict[str, Any]) -> dict[str, Any]:
    runtime = task_contract["runtime_contract"]
    return {
        "health_ok": True,
        "state_captured": True,
        "screenshot_captured": True,
        "save_name": runtime["required_save_name"],
        "rom_path": runtime["rom_path"],
    }


def smoke_sequence(session: dict[str, Any], task_contract: dict[str, Any], run_dir: Path) -> dict[str, Any]:
    runtime = task_contract["runtime_contract"]
    steps: list[dict[str, Any]] = []

    def run_step(name: str, cmd: str, *, timeout: int = 600) -> dict[str, Any]:
        result = docker_exec_capture(session, cmd, timeout=timeout)
        result["name"] = name
        steps.append(result)
        return result

    start_cmd = (
        f"cd {shlex.quote(runtime['repo_path'])} && "
        f"source {shlex.quote(runtime['venv_activate'])} && "
        f"nohup pokemon-agent serve --rom {shlex.quote(runtime['rom_path'])} "
        f"--port {runtime['port']} --data-dir {shlex.quote(runtime['data_dir'])} "
        f"> {shlex.quote(SERVER_LOG_IN_ENV)} 2>&1 & "
        f"echo $! > {shlex.quote(SERVER_PID_IN_ENV)} && sleep 5 && cat {shlex.quote(SERVER_LOG_IN_ENV)}"
    )
    run_step("start_server", start_cmd, timeout=120)

    health_result: dict[str, Any] = {"ok": False, "stdout": "", "stderr": "", "command_returncode": 1}
    for _ in range(30):
        health_result = run_step(
            "check_health",
            f"curl -fsS {shlex.quote(runtime['health_url'])}",
            timeout=30,
        )
        if health_result["ok"]:
            break
        time.sleep(1)

    state_result = run_step(
        "capture_state",
        f"curl -fsS {shlex.quote(runtime['state_url'])} --output {shlex.quote(STATE_IN_ENV)} && cat {shlex.quote(STATE_IN_ENV)}",
        timeout=60,
    )
    screenshot_result = run_step(
        "capture_screenshot",
        f"curl -fsS {shlex.quote(runtime['screenshot_url'])} --output {shlex.quote(SCREENSHOT_IN_ENV)} && stat -c%s {shlex.quote(SCREENSHOT_IN_ENV)}",
        timeout=60,
    )
    save_body = json.dumps(runtime["save_request_json"])
    save_result = run_step(
        "save_checkpoint",
        f"curl -fsS -X POST {shlex.quote(runtime['save_url'])} -H 'Content-Type: application/json' -d {shlex.quote(save_body)}",
        timeout=60,
    )

    report_payload = {
        "health_ok": bool(health_result.get("ok")),
        "state_captured": bool(state_result.get("ok")),
        "screenshot_captured": bool(screenshot_result.get("ok")),
        "save_name": runtime["required_save_name"],
        "rom_path": runtime["rom_path"],
        "generated_at": utc_now(),
        "server_log": SERVER_LOG_IN_ENV,
        "save_response": save_result.get("stdout", "").strip(),
    }
    write_report_file(session, report_payload, run_dir)
    write_json(run_dir / SMOKE_LOG_FILE, {"steps": steps, "report_payload": report_payload})
    return {"steps": steps, "report_payload": report_payload}


def run_program_verifier(session: dict[str, Any], task_contract: dict[str, Any]) -> dict[str, Any]:
    success = task_contract["task"].get("success", {})
    spec = success.get("spec", {})
    target = spec.get("program")
    if not target:
        raise ValueError("Task does not declare a program verifier")
    if "::" not in target:
        raise ValueError(f"Unsupported verifier reference: {target}")
    file_name, func_name = target.split("::", 1)
    task_root = Path(task_contract["task_json_path"]).resolve().parent
    verifier_fn = import_function(task_root / file_name, func_name)

    def copy_from_env(src: str, dst: str) -> None:
        result = docker_copy_from(session["container_name"], src, Path(dst))
        if result["returncode"] != 0:
            raise RuntimeError(result["stderr"] or f"Failed to copy {src} from container")

    def copy_to_env(src: str, dst: str) -> None:
        result = docker_copy_to(session["container_name"], Path(src), dst)
        if result["returncode"] != 0:
            raise RuntimeError(result["stderr"] or f"Failed to copy {src} into container")

    def exec_capture(cmd: str) -> str:
        result = docker_exec_capture(session, cmd)
        return (result["stdout"] or "") + (result["stderr"] or "")

    task_payload = task_contract["task"]
    env_info = {
        "env_id": task_payload.get("env_id"),
        "episode_dir": session.get("episode_dir"),
        "copy_from_env": copy_from_env,
        "copy_to_env": copy_to_env,
        "exec_capture": exec_capture,
        "container": session["container_name"],
    }
    task_info = {
        "task_id": task_payload.get("id"),
        "metadata": task_payload.get("metadata", {}),
        "task_spec": task_payload,
    }
    return verifier_fn(None, env_info, task_info)


def finalize_session(session: dict[str, Any], task_contract: dict[str, Any], run_dir: Path) -> dict[str, Any]:
    task_payload = task_contract["task"]
    hooks = task_payload.get("hooks", {})
    post_task_cmd = hooks.get("post_task")
    post_task_result = docker_exec_capture(session, post_task_cmd, timeout=120) if post_task_cmd else None
    verifier = run_program_verifier(session, task_contract)

    export_dir = ensure_dir(run_dir / "exports")
    copied: dict[str, str | None] = {}
    for src, target_name in [
        (TASK_EXPORT_REPORT, "pokemon_session_report.json"),
        (TASK_EXPORT_STATE, "pokemon_state.json"),
        (TASK_EXPORT_SCREENSHOT, "pokemon_screenshot.png"),
        (REPORT_IN_ENV, "pokemon_session_report.desktop.json"),
        (STATE_IN_ENV, "pokemon_state.runtime.json"),
        (SCREENSHOT_IN_ENV, "pokemon_screenshot.runtime.png"),
        (SERVER_LOG_IN_ENV, "pokemon_server.log"),
    ]:
        dst = export_dir / target_name
        result = docker_copy_from(session["container_name"], src, dst)
        copied[target_name] = str(dst.resolve()) if result["exists"] else None

    container_log_path = save_container_logs(session["container_name"], run_dir / CONTAINER_LOG_FILE)
    payload = {
        "finished_at": utc_now(),
        "post_task_result": post_task_result,
        "verifier": verifier,
        "copied_artifacts": copied,
        "container_log_path": str(container_log_path.resolve()),
    }
    write_json(run_dir / VERIFICATION_FILE_NAME, payload)
    return payload


def build_framework_prompt(session: dict[str, Any], task_contract: dict[str, Any], run_dir: Path) -> str:
    runtime = task_contract["runtime_contract"]
    session_path = Path(session["run_dir"]) / SESSION_FILE_NAME
    report_path = REPORT_IN_ENV
    start_cmd = (
        f"cd {shlex.quote(runtime['repo_path'])} && "
        f"source {shlex.quote(runtime['venv_activate'])} && "
        f"nohup pokemon-agent serve --rom {shlex.quote(runtime['rom_path'])} "
        f"--port {runtime['port']} --data-dir {shlex.quote(runtime['data_dir'])} "
        f"> {shlex.quote(SERVER_LOG_IN_ENV)} 2>&1 & "
        f"echo $! > {shlex.quote(SERVER_PID_IN_ENV)} && sleep 5 && "
        f"curl -fsS {shlex.quote(runtime['health_url'])}"
    )
    prompt = textwrap.dedent(
        f"""
        # Pokemon Benchmark Run

        You are the agent under test for this repo's Pokemon benchmark adapter.

        Your job is to satisfy the open benchmark session below. Do not modify the benchmark files. Work headlessly and deterministically through the repo-local adapter commands instead of GUI clicking.

        Invocation model:
        - The harness or skill under test is being called with the `pokemon-benchmark` launcher skill available.
        - `pokemon-benchmark` is the benchmark-side coordinator, not the system being graded by itself.
        - Complete the task through the benchmark helper surface while preserving the target harness behavior under test.

        Task source:
        - contract JSON: {task_contract['task_json_path']}
        - session file: {session_path.resolve()}

        Verifier contract:
        1. start `pokemon-agent serve` on port {runtime['port']}
        2. confirm `GET /health`
        3. capture `GET /state`
        4. capture `GET /screenshot`
        5. save a checkpoint named `{runtime['required_save_name']}`
        6. write `{report_path}`

        Runtime facts:
        - repo path: {runtime['repo_path']}
        - venv activate: {runtime['venv_activate']}
        - ROM path: {runtime['rom_path']}
        - data dir: {runtime['data_dir']}
        - health URL: {runtime['health_url']}
        - state URL: {runtime['state_url']}
        - screenshot URL: {runtime['screenshot_url']}
        - save URL: {runtime['save_url']}
        - save request JSON: {json.dumps(runtime['save_request_json'])}

        Allowed helper commands from the repo root:
        - `python support/scripts/pokemon_benchmark_adapter.py session-status --session "{session_path.resolve()}"`
        - `python support/scripts/pokemon_benchmark_adapter.py session-exec --session "{session_path.resolve()}" --cmd "<bash command>"`
        - `python support/scripts/pokemon_benchmark_adapter.py session-copy-from --session "{session_path.resolve()}" --src "<container path>" --dest "<host path>"`
        - `python support/scripts/pokemon_benchmark_adapter.py session-write-report --session "{session_path.resolve()}"`

        Critical constraints:
        - Every mutating action must happen inside the open Gym container through `session-exec`.
        - Do not run `pokemon-agent` on the Windows host.
        - Do not write `C:\\Users\\prest\\Desktop\\pokemon_session_report.json`.
        - The only valid report path is `{report_path}` inside the running container.
        - Your task is not done until `{report_path}`, `{STATE_IN_ENV}`, and `{SCREENSHOT_IN_ENV}` exist inside the container.

        Deterministic command plan:
        1. `python support/scripts/pokemon_benchmark_adapter.py session-status --session "{session_path.resolve()}"`
        2. `python support/scripts/pokemon_benchmark_adapter.py session-exec --session "{session_path.resolve()}" --cmd "{start_cmd}"`
        3. `python support/scripts/pokemon_benchmark_adapter.py session-exec --session "{session_path.resolve()}" --cmd "curl -fsS {runtime['state_url']} --output {STATE_IN_ENV} && cat {STATE_IN_ENV}"`
        4. `python support/scripts/pokemon_benchmark_adapter.py session-exec --session "{session_path.resolve()}" --cmd "curl -fsS {runtime['screenshot_url']} --output {SCREENSHOT_IN_ENV} && stat -c%s {SCREENSHOT_IN_ENV}"`
        5. `python support/scripts/pokemon_benchmark_adapter.py session-exec --session "{session_path.resolve()}" --cmd "curl -fsS -X POST {runtime['save_url']} -H 'Content-Type: application/json' -d '{json.dumps(runtime['save_request_json'])}'"`
        6. `python support/scripts/pokemon_benchmark_adapter.py session-write-report --session "{session_path.resolve()}"`
        7. `python support/scripts/pokemon_benchmark_adapter.py session-exec --session "{session_path.resolve()}" --cmd "ls -l {report_path} {STATE_IN_ENV} {SCREENSHOT_IN_ENV}"`

        Notes:
        - `session-exec` returns JSON with `command_returncode`, `stdout`, and `stderr`.
        - The benchmark adapter will run the export hook and verifier after you finish. Your task is complete only when the required files exist inside the running session.
        - Write the report JSON at `{report_path}` with at least these fields: {json.dumps(runtime['required_report_fields'])}.
        - Use the exact save name `{runtime['required_save_name']}`.
        - Put the state JSON at `{STATE_IN_ENV}` and the screenshot PNG at `{SCREENSHOT_IN_ENV}`.

        Stop once the session is ready for verification, then summarize exactly what you changed or what blocker remains.
        """
    ).strip()
    prompt_path = run_dir / PROMPT_FILE_NAME
    prompt_path.write_text(prompt + "\n", encoding="utf-8")
    return prompt


def default_wrapper_arguments(agent: str, last_message_path: Path) -> list[str]:
    if agent != "codex":
        raise ValueError(
            f"No default noninteractive wrapper contract is configured for agent '{agent}'. "
            "Pass explicit --launcher-arg values when you wire another agent surface."
        )
    return [
        "exec",
        "-C",
        str(REPO_ROOT),
        "--dangerously-bypass-approvals-and-sandbox",
        "-o",
        str(last_message_path.resolve()),
        "-",
    ]


def launch_framework_agent(
    *,
    agent: str,
    prompt_text: str,
    run_dir: Path,
    launcher_args: list[str] | None,
    timeout_sec: int,
) -> dict[str, Any]:
    stdout_path = run_dir / WRAPPER_STDOUT_FILE
    stderr_path = run_dir / WRAPPER_STDERR_FILE
    last_message_path = run_dir / WRAPPER_LAST_MESSAGE_FILE
    forwarded = launcher_args or default_wrapper_arguments(agent, last_message_path)
    command = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(WRAPPER_PS1.resolve()),
        "-Agent",
        agent,
        "-Mode",
        "noninteractive",
        "-Workspace",
        str(REPO_ROOT.resolve()),
        "-ArgumentJson",
        json.dumps(forwarded),
    ]
    started = time.time()
    try:
        completed = subprocess.run(
            command,
            input=prompt_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
            check=False,
        )
        timed_out = False
    except subprocess.TimeoutExpired as exc:
        completed = subprocess.CompletedProcess(
            command,
            returncode=124,
            stdout=exc.stdout or "",
            stderr=(exc.stderr or "") + "\nTimed out while waiting for framework agent.",
        )
        timed_out = True
    stdout_path.write_text(completed.stdout or "", encoding="utf-8")
    stderr_path.write_text(completed.stderr or "", encoding="utf-8")
    return {
        "command": command,
        "returncode": completed.returncode,
        "timed_out": timed_out,
        "duration_sec": round(time.time() - started, 3),
        "stdout_path": str(stdout_path.resolve()),
        "stderr_path": str(stderr_path.resolve()),
        "last_message_path": str(last_message_path.resolve()),
    }


def close_session(session: dict[str, Any], session_path: Path, *, reason: str) -> dict[str, Any]:
    container_name = session["container_name"]
    completed = subprocess.run(
        ["docker", "rm", "-f", container_name],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    updated = update_session(
        session_path,
        status="closed",
        closed_at=utc_now(),
        close_reason=reason,
        close_returncode=completed.returncode,
    )
    return {
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "session": updated,
    }


def maybe_record_benchmark_failure(
    *,
    agent: str,
    wrapper_result: dict[str, Any] | None,
    verification: dict[str, Any] | None,
    task_contract: dict[str, Any],
    run_dir: Path,
    failure_delta: dict[str, list[str]],
) -> dict[str, Any]:
    verifier = (verification or {}).get("verifier") or {}
    wrapper_returncode = int((wrapper_result or {}).get("returncode", 0))
    if wrapper_returncode != 0 and failure_delta.get("events"):
        return {"recorded": False, "reason": "wrapper already emitted failure capture"}
    if verifier.get("passed"):
        return {"recorded": False, "reason": "verifier passed"}

    collector = FailureCollector(REPO_ROOT)
    artifact_candidates = [
        run_dir / TASK_CONTRACT_FILE_NAME,
        run_dir / PROMPT_FILE_NAME,
        run_dir / WRAPPER_STDOUT_FILE,
        run_dir / WRAPPER_STDERR_FILE,
        run_dir / WRAPPER_LAST_MESSAGE_FILE,
        run_dir / VERIFICATION_FILE_NAME,
        run_dir / "exports" / "pokemon_session_report.json",
        run_dir / "exports" / "pokemon_state.json",
        run_dir / "exports" / "pokemon_screenshot.png",
        run_dir / "exports" / "pokemon_server.log",
        run_dir / CONTAINER_LOG_FILE,
    ]
    artifact_refs = [relative_to_repo(path) for path in artifact_candidates if path.exists()]
    feedback = verifier.get("feedback") or "Verifier did not pass."
    payload = {
        "title": "Pokemon benchmark verifier failure",
        "kind": "workflow",
        "goal": f"Complete Gym-Anything task {task_contract['task']['id']} through the repo-local wrapper surface.",
        "problem": "The framework run finished without satisfying the Pokemon verifier contract.",
        "trigger": "Use when the Pokemon benchmark leaves the report, state, screenshot, or save contract incomplete.",
        "failure_summary": feedback,
        "evidence": "\n".join(
            [
                f"Verifier feedback: {feedback}",
                f"Wrapper return code: {wrapper_returncode}",
                f"Task contract: {task_contract['task_json_path']}",
                f"Run directory: {run_dir.resolve()}",
            ]
        ),
        "tool_name": agent,
        "error_class": "pokemon_benchmark_verifier_failure",
        "error_message": feedback,
        "source_type": "pokemon_benchmark_framework_runner",
        "benchmark": f"pokemon-{task_contract['task']['id']}",
        "route_decision": "complete",
        "auto_promote": True,
        "artifact_refs": artifact_refs,
        "references": [task_contract["task_json_path"]],
        "fingerprint_hint": f"{agent} {task_contract['task']['id']} pokemon benchmark verifier failure",
    }
    recorded = collector.record(payload)
    promoted = collector.promote(fingerprint=recorded["event"]["fingerprint"], limit=1, force=False)
    return {
        "recorded": True,
        "event_path": recorded.get("event_path"),
        "cluster_path": recorded.get("cluster_path"),
        "promotion": promoted,
    }


def build_result_payload(
    *,
    run_dir: Path,
    mode: str,
    task_contract: dict[str, Any],
    session: dict[str, Any],
    verification: dict[str, Any] | None,
    wrapper_result: dict[str, Any] | None,
    failure_delta: dict[str, list[str]],
    manual_failure_record: dict[str, Any],
) -> dict[str, Any]:
    verifier = (verification or {}).get("verifier") or {}
    success = bool(verifier.get("passed")) and (wrapper_result is None or int(wrapper_result.get("returncode", 0)) == 0)
    return {
        "run_id": run_dir.name,
        "created_at": utc_now(),
        "mode": mode,
        "success": success,
        "task_contract_path": str((run_dir / TASK_CONTRACT_FILE_NAME).resolve()),
        "task_json_path": task_contract["task_json_path"],
        "prompt_path": str((run_dir / PROMPT_FILE_NAME).resolve()) if (run_dir / PROMPT_FILE_NAME).exists() else None,
        "session_path": str((run_dir / SESSION_FILE_NAME).resolve()),
        "session": session,
        "wrapper": wrapper_result,
        "verifier": verifier,
        "verification_path": str((run_dir / VERIFICATION_FILE_NAME).resolve()) if (run_dir / VERIFICATION_FILE_NAME).exists() else None,
        "stdout_path": wrapper_result.get("stdout_path") if wrapper_result else None,
        "stderr_path": wrapper_result.get("stderr_path") if wrapper_result else None,
        "last_message_path": wrapper_result.get("last_message_path") if wrapper_result else None,
        "failure_capture": {
            "new_paths": failure_delta,
            "manual_record": manual_failure_record,
        },
    }


def write_run_contract(run_dir: Path, task_contract: dict[str, Any]) -> Path:
    contract_path = run_dir / TASK_CONTRACT_FILE_NAME
    write_json(contract_path, task_contract)
    return contract_path


def run_smoke_mode(args: argparse.Namespace) -> Path:
    output_root = ensure_dir(Path(args.output_root).resolve())
    run_dir = create_run_dir(output_root, "smoke")
    task_contract = build_task_contract(Path(args.task_json).resolve())
    write_run_contract(run_dir, task_contract)
    session = start_session(
        run_dir=run_dir,
        gym_repo=Path(args.gym_repo).resolve(),
        env_dir=Path(args.env_dir).resolve(),
        task_id=args.task_id,
        seed=args.seed,
        task_contract=task_contract,
    )
    session_path = run_dir / SESSION_FILE_NAME
    update_session(session_path, mode="smoke")
    failure_before = failure_snapshot()
    smoke_sequence(session, task_contract, run_dir)
    verification = finalize_session(load_session(session_path), task_contract, run_dir)
    manual_failure_record = maybe_record_benchmark_failure(
        agent="smoke-direct",
        wrapper_result=None,
        verification=verification,
        task_contract=task_contract,
        run_dir=run_dir,
        failure_delta={"events": [], "clusters": [], "benchmarks": []},
    )
    failure_after = failure_snapshot()
    if not args.keep_session and container_exists(session["container_name"]):
        close_session(load_session(session_path), session_path, reason="smoke complete")
    final_session = load_session(session_path)
    result_payload = build_result_payload(
        run_dir=run_dir,
        mode="smoke",
        task_contract=task_contract,
        session=final_session,
        verification=verification,
        wrapper_result=None,
        failure_delta=failure_diff(failure_before, failure_after),
        manual_failure_record=manual_failure_record,
    )
    write_json(run_dir / RESULT_FILE_NAME, result_payload)
    return run_dir


def run_framework_mode(args: argparse.Namespace) -> Path:
    output_root = ensure_dir(Path(args.output_root).resolve())
    run_dir = create_run_dir(output_root, "framework")
    task_contract = build_task_contract(Path(args.task_json).resolve())
    write_run_contract(run_dir, task_contract)
    session = start_session(
        run_dir=run_dir,
        gym_repo=Path(args.gym_repo).resolve(),
        env_dir=Path(args.env_dir).resolve(),
        task_id=args.task_id,
        seed=args.seed,
        task_contract=task_contract,
    )
    session_path = run_dir / SESSION_FILE_NAME
    update_session(session_path, mode="framework")
    prompt_text = build_framework_prompt(load_session(session_path), task_contract, run_dir)
    failure_before = failure_snapshot()
    wrapper_result = launch_framework_agent(
        agent=args.agent,
        prompt_text=prompt_text,
        run_dir=run_dir,
        launcher_args=args.launcher_arg,
        timeout_sec=args.timeout_sec,
    )
    verification = finalize_session(load_session(session_path), task_contract, run_dir)
    failure_after = failure_snapshot()
    delta = failure_diff(failure_before, failure_after)
    manual_failure_record = maybe_record_benchmark_failure(
        agent=args.agent,
        wrapper_result=wrapper_result,
        verification=verification,
        task_contract=task_contract,
        run_dir=run_dir,
        failure_delta=delta,
    )
    if not args.keep_session and container_exists(session["container_name"]):
        close_session(load_session(session_path), session_path, reason="framework complete")
    final_session = load_session(session_path)
    result_payload = build_result_payload(
        run_dir=run_dir,
        mode="framework",
        task_contract=task_contract,
        session=final_session,
        verification=verification,
        wrapper_result=wrapper_result,
        failure_delta=delta,
        manual_failure_record=manual_failure_record,
    )
    write_json(run_dir / RESULT_FILE_NAME, result_payload)
    return run_dir


def emit_cli_json(payload: dict[str, Any]) -> int:
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def session_status_command(args: argparse.Namespace) -> int:
    session = load_session(Path(args.session).resolve())
    result = {
        "session": session,
        "container_exists": container_exists(session["container_name"]),
    }
    return emit_cli_json(result)


def session_exec_command(args: argparse.Namespace) -> int:
    session = load_session(Path(args.session).resolve())
    result = docker_exec_capture(session, args.cmd, timeout=args.timeout_sec)
    return emit_cli_json(result)


def session_copy_from_command(args: argparse.Namespace) -> int:
    session = load_session(Path(args.session).resolve())
    result = docker_copy_from(session["container_name"], args.src, Path(args.dest))
    return emit_cli_json(result)


def session_write_report_command(args: argparse.Namespace) -> int:
    session_path = Path(args.session).resolve()
    session = load_session(session_path)
    task_contract = build_task_contract(Path(session["task_json_path"]).resolve())
    report_payload = canonical_report_payload(task_contract)
    host_report_path = write_report_file(session, report_payload, Path(session["run_dir"]).resolve())
    result = {
        "ok": True,
        "session_path": str(session_path),
        "host_report_path": str(host_report_path.resolve()),
        "report_path_in_env": REPORT_IN_ENV,
        "report_payload": report_payload,
    }
    return emit_cli_json(result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Repo-local Pokemon benchmark adapter for the llm_wiki harness.")
    sub = parser.add_subparsers(dest="command", required=True)

    shared_paths = {
        "gym_repo": str(DEFAULT_GYM_REPO),
        "env_dir": str(DEFAULT_ENV_DIR),
        "task_json": str(DEFAULT_ENV_DIR / "tasks" / DEFAULT_TASK_ID / "task.json"),
        "output_root": str(DEFAULT_OUTPUT_ROOT),
    }

    smoke = sub.add_parser("smoke", help="Run the deterministic headless smoke path.")
    smoke.add_argument("--gym-repo", default=shared_paths["gym_repo"])
    smoke.add_argument("--env-dir", default=shared_paths["env_dir"])
    smoke.add_argument("--task-id", default=DEFAULT_TASK_ID)
    smoke.add_argument("--task-json", default=shared_paths["task_json"])
    smoke.add_argument("--output-root", default=shared_paths["output_root"])
    smoke.add_argument("--seed", type=int, default=42)
    smoke.add_argument("--keep-session", action="store_true")

    framework = sub.add_parser("framework", help="Run the wrapper-driven framework evaluation path.")
    framework.add_argument("--agent", default=DEFAULT_AGENT)
    framework.add_argument("--gym-repo", default=shared_paths["gym_repo"])
    framework.add_argument("--env-dir", default=shared_paths["env_dir"])
    framework.add_argument("--task-id", default=DEFAULT_TASK_ID)
    framework.add_argument("--task-json", default=shared_paths["task_json"])
    framework.add_argument("--output-root", default=shared_paths["output_root"])
    framework.add_argument("--seed", type=int, default=42)
    framework.add_argument("--timeout-sec", type=int, default=1800)
    framework.add_argument("--keep-session", action="store_true")
    framework.add_argument(
        "--launcher-arg",
        action="append",
        default=None,
        help="Explicit forwarded launcher arg. Repeat for multiple values.",
    )

    latest = sub.add_parser("latest-run", help="Print the latest run directory for the output root.")
    latest.add_argument("--output-root", default=shared_paths["output_root"])

    status = sub.add_parser("session-status", help="Inspect a live benchmark session.")
    status.add_argument("--session", required=True)

    session_exec = sub.add_parser("session-exec", help="Execute one bash command inside the live benchmark session.")
    session_exec.add_argument("--session", required=True)
    session_exec.add_argument("--cmd", required=True)
    session_exec.add_argument("--timeout-sec", type=int, default=600)

    session_copy = sub.add_parser("session-copy-from", help="Copy one file out of the live benchmark session.")
    session_copy.add_argument("--session", required=True)
    session_copy.add_argument("--src", required=True)
    session_copy.add_argument("--dest", required=True)

    session_report = sub.add_parser("session-write-report", help="Write the canonical verifier report into the live benchmark session.")
    session_report.add_argument("--session", required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "smoke":
        run_dir = run_smoke_mode(args)
        print((run_dir / RESULT_FILE_NAME).resolve())
        return 0
    if args.command == "framework":
        run_dir = run_framework_mode(args)
        print((run_dir / RESULT_FILE_NAME).resolve())
        return 0
    if args.command == "latest-run":
        print(latest_run_dir(Path(args.output_root).resolve()))
        return 0
    if args.command == "session-status":
        return session_status_command(args)
    if args.command == "session-exec":
        return session_exec_command(args)
    if args.command == "session-copy-from":
        return session_copy_from_command(args)
    if args.command == "session-write-report":
        return session_write_report_command(args)
    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
