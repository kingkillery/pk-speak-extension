#!/usr/bin/env bash
set -euo pipefail
PYTHON_BIN="${PYTHON_BIN:-python3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/.llm-wiki/config.json"
BRV_COMMAND="${LLM_WIKI_BRV_COMMAND:-}"
CONTENT=""
PROVIDER=""
MODEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-path)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --content)
      CONTENT="$2"
      shift 2
      ;;
    --brv-command)
      BRV_COMMAND="$2"
      shift 2
      ;;
    --provider)
      PROVIDER="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$CONTENT" ]]; then
  echo "--content is required" >&2
  exit 1
fi

if [[ -f "$CONFIG_PATH" ]]; then
  mapfile -t CFG < <("$PYTHON_BIN" - "$CONFIG_PATH" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    cfg = json.load(handle)
print(cfg["byterover"]["command"])
print(cfg["byterover"].get("default_provider", "") or "")
print(cfg["byterover"].get("default_model", "") or "")
print(cfg["byterover"].get("curate_preferred_provider", "") or "")
print(cfg["byterover"].get("curate_preferred_model", "") or "")
PY
)
  [[ -z "$BRV_COMMAND" ]] && BRV_COMMAND="${CFG[0]}"
  [[ -z "$PROVIDER" ]] && PROVIDER="${CFG[3]:-${CFG[1]}}"
  [[ -z "$MODEL" ]] && MODEL="${CFG[4]:-${CFG[2]}}"
fi

if [[ -z "$BRV_COMMAND" ]]; then
  echo "BRV command is not configured." >&2
  exit 1
fi

cd "$(dirname "$CONFIG_PATH")/.."
if [[ -n "$MODEL" ]]; then
  SWITCH_ARGS=(model switch "$MODEL" --format json)
  if [[ -n "$PROVIDER" ]]; then
    SWITCH_ARGS+=(--provider "$PROVIDER")
  fi
  "$BRV_COMMAND" "${SWITCH_ARGS[@]}" >/dev/null
fi
"$BRV_COMMAND" curate "$CONTENT" --format json
