#!/usr/bin/env bash
set -euo pipefail
PYTHON_BIN="${PYTHON_BIN:-python3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/.llm-wiki/config.json"
REPO_PATH="${LLM_WIKI_GITVIZZ_REPO_PATH:-}"
REBUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-path)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --repo-path)
      REPO_PATH="$2"
      shift 2
      ;;
    --rebuild)
      REBUILD=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPO_PATH" && -f "$CONFIG_PATH" ]]; then
  mapfile -t CFG < <("$PYTHON_BIN" - "$CONFIG_PATH" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    cfg = json.load(handle)

print(cfg["gitvizz"].get("repo_path", "") or "")
PY
)
  REPO_PATH="${CFG[0]}"
fi

if [[ -z "$REPO_PATH" ]]; then
  echo "GitVizz repo path is not configured." >&2
  exit 1
fi

if [[ ! -f "$REPO_PATH/docker-compose.yaml" ]]; then
  echo "docker-compose.yaml not found under $REPO_PATH" >&2
  exit 1
fi

cd "$REPO_PATH"
if [[ "$REBUILD" -eq 1 ]]; then
  docker-compose up -d --build
else
  docker-compose up -d
fi
