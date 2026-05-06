#!/usr/bin/env bash
set -euo pipefail
PYTHON_BIN="${PYTHON_BIN:-python3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/.llm-wiki/config.json"
BRV_COMMAND="${LLM_WIKI_BRV_COMMAND:-}"
QUERY=""
PROVIDER=""
MODEL=""
USE_QUERY_EXPERIMENT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-path)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --query)
      QUERY="$2"
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
    --use-query-experiment)
      USE_QUERY_EXPERIMENT=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$QUERY" ]]; then
  echo "--query is required" >&2
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
print(cfg["byterover"].get("query_experiment_provider", "") or "")
print(cfg["byterover"].get("query_experiment_model", "") or "")
PY
)
  [[ -z "$BRV_COMMAND" ]] && BRV_COMMAND="${CFG[0]}"
  if [[ "$USE_QUERY_EXPERIMENT" -eq 1 ]]; then
    [[ -z "$PROVIDER" ]] && PROVIDER="${CFG[3]}"
    [[ -z "$MODEL" ]] && MODEL="${CFG[4]}"
  else
    [[ -z "$PROVIDER" ]] && PROVIDER="${CFG[1]}"
    [[ -z "$MODEL" ]] && MODEL="${CFG[2]}"
  fi
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
"$BRV_COMMAND" query "$QUERY" --format json
