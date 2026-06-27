#!/usr/bin/env bash
# scripts/kanban-card-templates.sh — list or fetch kanban card templates.
#
# Usage:
#   kanban-card-templates.sh list
#   kanban-card-templates.sh get <templateId>
#
# Environment:
#   PROJECT_ID   required
#   AGENT_HUB_URL / API key — resolved by ah-api.sh
#
# Exit codes:
#   0  success; JSON on stdout
#   2  bad invocation
#   *  curl / API error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: kanban-card-templates.sh <command> [args]

Commands:
  list                 list all card templates for $PROJECT_ID
  get <templateId>     fetch one template by id

Examples:
  PROJECT_ID=agent-hub kanban-card-templates.sh list
  PROJECT_ID=agent-hub kanban-card-templates.sh get <uuid>
EOF
}

if [[ $# -lt 1 ]]; then
  echo "error: command required" >&2
  _usage >&2
  exit 2
fi

cmd="$1"
shift

case "$cmd" in
  -h|--help|help)
    _usage
    exit 0
    ;;
esac

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

case "$cmd" in
  list)
    ah_api GET "/api/projects/$PROJECT_ID/board/card-templates"
    ;;
  get)
    template_id="${1:-}"
    if [[ -z "$template_id" ]]; then
      echo "error: template id required" >&2
      exit 2
    fi
    AH_LIST="$(ah_api GET "/api/projects/$PROJECT_ID/board/card-templates")"
    AH_LIST="$AH_LIST" AH_TEMPLATE_ID="$template_id" python3 <<'PY'
import json, os, sys
rows = json.loads(os.environ["AH_LIST"])
tid = os.environ["AH_TEMPLATE_ID"]
for row in rows:
    if row.get("id") == tid:
        print(json.dumps(row))
        sys.exit(0)
sys.stderr.write(f"error: template not found: {tid}\n")
sys.exit(1)
PY
    ;;
  *)
    echo "error: unknown command '$cmd'" >&2
    _usage >&2
    exit 2
    ;;
esac
