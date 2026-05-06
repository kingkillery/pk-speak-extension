#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="$script_dir/llm_wiki_packet.py"

if [[ ! -f "$script_path" ]]; then
  echo "Missing packet CLI script: $script_path" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 "$script_path" "$@"
fi

if command -v python >/dev/null 2>&1; then
  exec python "$script_path" "$@"
fi

echo "Python is required to run llm_wiki_packet.sh" >&2
exit 1
