#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_SCRIPT="$SCRIPT_DIR/llm_wiki_memory_runtime.py"
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

if [[ ! -f "$RUNTIME_SCRIPT" ]]; then
  echo "Missing shared runtime: $RUNTIME_SCRIPT" >&2
  exit 1
fi

PYTHON_CMD="$(resolve_python || true)"
if [[ -z "$PYTHON_CMD" ]]; then
  echo "Python is required to run check_llm_wiki_memory.sh" >&2
  exit 1
fi

if [[ "$PYTHON_CMD" == "py -3" ]]; then
  exec py -3 "$RUNTIME_SCRIPT" check "$@"
fi

exec "$PYTHON_CMD" "$RUNTIME_SCRIPT" check "$@"
