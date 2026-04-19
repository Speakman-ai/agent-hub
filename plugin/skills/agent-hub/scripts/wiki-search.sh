#!/usr/bin/env bash
# scripts/wiki-search.sh — FTS5 search against the project wiki.
#
# Usage:
#   wiki-search.sh <query>
#
# Environment:
#   PROJECT_ID  required
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
usage: wiki-search.sh <query>

Full-text search the wiki for $PROJECT_ID. Uses the server's FTS5 index.

Example:
  PROJECT_ID=agent-hub wiki-search.sh "deployment"
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

if [[ $# -ne 1 ]]; then
  _usage >&2
  exit 2
fi

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

query="$1"

# URL-encode the query (ASCII-safe fallback mirroring wiki.sh's encoder; multi-
# byte UTF-8 chars may be mangled — wiki titles/queries are ASCII in practice).
encoded="$(
  AH_Q="$query" python3 <<'PY'
import os, urllib.parse
print(urllib.parse.quote(os.environ["AH_Q"], safe=""))
PY
)"

ah_api GET "/api/projects/$PROJECT_ID/wiki?q=$encoded"
