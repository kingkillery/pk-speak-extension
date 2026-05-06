#!/usr/bin/env bash
set -euo pipefail
PYTHON_BIN="${PYTHON_BIN:-python3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/.llm-wiki/config.json"
BRV_COMMAND="${LLM_WIKI_BRV_COMMAND:-}"
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-path)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --target|--query|--curate-note|--brv-command)
      ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$BRV_COMMAND" ]]; then
  ARGS+=(--brv-command "$BRV_COMMAND")
fi

"$PYTHON_BIN" "$SCRIPT_DIR/brv_benchmark.py" --config-path "$CONFIG_PATH" "${ARGS[@]}"
