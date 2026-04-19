#!/usr/bin/env bash
# scripts/server.sh — server metadata + projects + agents + skills registry.
#
# Subcommands:
#   config                   /api/config  (port, models, auth status)
#   projects                 /api/projects  (all projects)
#   project                  /api/projects/$PROJECT_ID
#   agents                   /api/agents  (all agents)
#   skills                   /api/skills/registry  (marketplace)
#   skills <category>        filter registry by category

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

cmd="${1:-help}"
shift || true

case "$cmd" in
  config)   hub_api GET "/api/config" ;;
  projects) hub_api GET "/api/projects" ;;
  project)
    require_var PROJECT_ID
    hub_api GET "/api/projects/$PROJECT_ID"
    ;;
  agents)
    hub_api GET "/api/agents"
    ;;
  skills)
    cat_q="${1:-}"
    if [[ -n "$cat_q" ]]; then
      hub_api GET "/api/skills/registry?category=$cat_q"
    else
      hub_api GET "/api/skills/registry"
    fi
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: server.sh <subcommand>
  config
  projects
  project
  agents
  skills [category]
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try server.sh help)"
    ;;
esac
