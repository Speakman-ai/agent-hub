#!/usr/bin/env bash
# designs-files.sh — list files in a design's artifact dir (recursive).
#
# Usage:
#   designs-files.sh <designId>              # one path per line (default)
#   designs-files.sh <designId> --json       # full JSON body {designId, files:[{path,size,mtime}]}
#
# Paths are forward-slash, relative to the artifact root. The JSON form
# includes size (bytes) and mtime (ISO 8601).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/../../agent-hub/scripts/ah-api.sh"

id="${1:-}"
mode="${2:-paths}"
if [[ -z "$id" ]]; then
  echo "usage: designs-files.sh <designId> [--json]" >&2
  exit 2
fi

raw="$(ah_api GET "/api/designs/$id/files")"

case "$mode" in
  --json|json) printf '%s\n' "$raw" ;;
  paths|'')
    if command -v jq >/dev/null 2>&1; then
      printf '%s' "$raw" | jq -r '.files[].path'
    else
      # Fallback: naive extraction of path fields
      printf '%s' "$raw" | sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
    fi
    ;;
  *)
    echo "designs-files.sh: unknown mode '$mode'" >&2
    exit 2
    ;;
esac
