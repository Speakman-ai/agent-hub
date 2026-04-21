#!/usr/bin/env bash
# designs-get.sh — fetch one design's metadata.
#
# Usage:
#   designs-get.sh <designId>
#
# Prints the JSON body for GET /api/designs/:id. Exits 22 (curl's HTTP-
# error exit) on 404.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/../../agent-hub/scripts/ah-api.sh"

id="${1:-}"
if [[ -z "$id" ]]; then
  echo "usage: designs-get.sh <designId>" >&2
  exit 2
fi

ah_api GET "/api/designs/$id"
