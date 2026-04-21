#!/usr/bin/env bash
# designs-read.sh — fetch the raw contents of a single file in a design's
# artifact dir. Works for text and binary; stdout is the bytes verbatim.
#
# Usage:
#   designs-read.sh <designId> <path>
#
# Example:
#   designs-read.sh 0b1e...  index.html
#   designs-read.sh 0b1e...  assets/hero.png > /tmp/hero.png
#
# Under the hood this hits the auth-gated `/design-files/:id/<path>` mount
# so the server's path-traversal guard + org-isolation checks both apply.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/../../agent-hub/scripts/ah-api.sh"

id="${1:-}"
filepath="${2:-}"
if [[ -z "$id" || -z "$filepath" ]]; then
  echo "usage: designs-read.sh <designId> <path>" >&2
  exit 2
fi

# Reject client-side traversal attempts early — the server rejects them too
# but it's friendlier to fail here with a clear message.
case "$filepath" in
  /*|*..*)
    echo "designs-read.sh: refusing path with leading slash or '..' segments" >&2
    exit 2
    ;;
esac

# URL-encode each path segment so spaces and unicode survive the round-trip.
encode_segment() {
  local s="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$s" | jq -sRr @uri
  else
    # Minimal fallback: encode space only. Enough for the MVP.
    printf '%s' "${s// /%20}"
  fi
}

encoded=""
IFS='/' read -ra parts <<<"$filepath"
for part in "${parts[@]}"; do
  [[ -z "$part" ]] && continue
  encoded+="/$(encode_segment "$part")"
done

key="$(ah_resolve_key)"
auth_args=()
[[ -n "$key" ]] && auth_args+=(-H "x-api-key: $key")

curl -fsS "${auth_args[@]}" "${AGENT_HUB_URL}/design-files/${id}${encoded}"
