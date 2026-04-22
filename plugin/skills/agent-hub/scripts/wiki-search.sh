#!/usr/bin/env bash
# scripts/wiki-search.sh — hybrid semantic + FTS search against the project wiki.
#
# Usage:
#   wiki-search.sh <query> [mode]
#
# Environment:
#   PROJECT_ID  required
#   python3     required on PATH (JSON is used to encode the query and normalize responses)
#
# Exit codes:
#   0  success; JSON array of matching pages on stdout
#   2  bad invocation
#   *  curl / API error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: wiki-search.sh <query> [mode]

Hybrid-search the wiki for $PROJECT_ID.
Modes: hybrid (default), semantic, fts.

Example:
  PROJECT_ID=agent-hub wiki-search.sh "deployment"
  PROJECT_ID=agent-hub wiki-search.sh "deployment" semantic
EOF
}

case "${1:-}" in
  -h|--help|help)
    _usage; exit 0 ;;
  '')
    _usage >&2
    exit 2
    ;;
esac

if [[ $# -lt 1 || $# -gt 2 ]]; then
  _usage >&2
  exit 2
fi

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

query="$1"
mode="${2:-hybrid}"
case "$mode" in
  hybrid|semantic|fts) ;;
  *)
    echo "error: mode must be one of: hybrid | semantic | fts" >&2
    exit 2
    ;;
esac

# URL-encode the query (ASCII-safe fallback mirroring wiki.sh's encoder; multi-
# byte UTF-8 chars may be mangled — wiki titles/queries are ASCII in practice).
encoded="$(
  AH_Q="$query" python3 <<'PY'
import os, urllib.parse
print(urllib.parse.quote(os.environ["AH_Q"], safe=""))
PY
)"

resp="$(ah_api GET "/api/projects/$PROJECT_ID/wiki/search?q=$encoded&mode=$mode")"

# Preserve legacy script shape (JSON array) for existing callers.
printf '%s' "$resp" | python3 -c 'import json,sys; data=json.load(sys.stdin); json.dump(data.get("results", data), sys.stdout); print()'
