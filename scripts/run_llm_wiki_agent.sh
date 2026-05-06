#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_SCRIPT="$SCRIPT_DIR/llm_wiki_agent_failure_capture.py"
WORKSPACE_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-}"

resolve_python() {
  if [[ -n "$PYTHON_BIN" ]]; then
    printf '%s\n' "$PYTHON_BIN"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "python3"
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    printf '%s\n' "python"
    return 0
  fi
  if command -v py >/dev/null 2>&1; then
    printf '%s\n' "py -3"
    return 0
  fi
  return 1
}

if [[ ! -f "$WRAPPER_SCRIPT" ]]; then
  echo "Missing agent failure wrapper: $WRAPPER_SCRIPT" >&2
  exit 1
fi

AGENT=""
MODE="auto"
WORKSPACE="$WORKSPACE_DEFAULT"
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-auto}"
      shift 2
      ;;
    --workspace)
      WORKSPACE="${2:-$WORKSPACE_DEFAULT}"
      shift 2
      ;;
    --)
      shift
      POSITIONAL+=("$@")
      break
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  echo "Usage: run_llm_wiki_agent.sh --agent <claude|codex|droid|pi> [--mode auto|interactive|noninteractive] [--workspace <path>] -- [agent args...]" >&2
  exit 2
fi

PYTHON_CMD="$(resolve_python || true)"
if [[ -z "$PYTHON_CMD" ]]; then
  echo "Python is required to run run_llm_wiki_agent.sh" >&2
  exit 1
fi

if [[ "$PYTHON_CMD" == "py -3" ]]; then
  exec py -3 "$WRAPPER_SCRIPT" --workspace "$WORKSPACE" --agent "$AGENT" --mode "$MODE" -- "${POSITIONAL[@]}"
fi

exec "$PYTHON_CMD" "$WRAPPER_SCRIPT" --workspace "$WORKSPACE" --agent "$AGENT" --mode "$MODE" -- "${POSITIONAL[@]}"
