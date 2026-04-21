#!/usr/bin/env bash
# designs-messages.sh — replay a design's user/assistant/system transcript.
#
# Usage:
#   designs-messages.sh <designId>

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/../../agent-hub/scripts/ah-api.sh"

id="${1:-}"
if [[ -z "$id" ]]; then
  echo "usage: designs-messages.sh <designId>" >&2
  exit 2
fi

ah_api GET "/api/designs/$id/messages"
