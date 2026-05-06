#!/usr/bin/env bash
set -euo pipefail
PYTHON_BIN="${PYTHON_BIN:-python3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/.llm-wiki/config.json"
PATH_SUFFIX="/openapi.json"
METHOD="GET"
BASE_URL="${LLM_WIKI_GITVIZZ_BACKEND_URL:-}"
JSON_BODY=""
AUTHORIZATION=""
USE_API_BASE=0
FORM_FIELDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-path)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --path)
      PATH_SUFFIX="$2"
      shift 2
      ;;
    --method)
      METHOD="$2"
      shift 2
      ;;
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --json-body)
      JSON_BODY="$2"
      shift 2
      ;;
    --form-field)
      FORM_FIELDS+=("$2")
      shift 2
      ;;
    --authorization)
      AUTHORIZATION="$2"
      shift 2
      ;;
    --use-api-base)
      USE_API_BASE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BASE_URL" && -f "$CONFIG_PATH" ]]; then
  mapfile -t CFG < <("$PYTHON_BIN" - "$CONFIG_PATH" "$USE_API_BASE" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    cfg = json.load(handle)

use_api_base = sys.argv[2] == "1"
if use_api_base and cfg["gitvizz"].get("api_base_url"):
    print(cfg["gitvizz"]["api_base_url"])
else:
    print(cfg["gitvizz"]["backend_url"])
PY
)
  BASE_URL="${CFG[0]}"
fi

if [[ -z "$BASE_URL" ]]; then
  echo "GitVizz backend URL is not configured." >&2
  exit 1
fi

URL="${BASE_URL%/}"
if [[ "$PATH_SUFFIX" == /* ]]; then
  URL+="$PATH_SUFFIX"
else
  URL+="/$PATH_SUFFIX"
fi

CURL_ARGS=(-sS -X "$METHOD" "$URL")

if [[ -n "$AUTHORIZATION" ]]; then
  CURL_ARGS+=(-H "Authorization: $AUTHORIZATION")
fi

if [[ -n "$JSON_BODY" ]]; then
  CURL_ARGS+=(-H "Content-Type: application/json" --data "$JSON_BODY")
fi

for field in "${FORM_FIELDS[@]}"; do
  CURL_ARGS+=(-F "$field")
done

curl "${CURL_ARGS[@]}"
