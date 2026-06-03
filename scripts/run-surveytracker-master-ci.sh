#!/usr/bin/env bash
# Run surveytracker master Finalize CI (.agent-hub/ci.yaml) inside DinD runners.
#
# Mirrors Agent Hub: backend ∥ frontend concurrently, one privileged runner per job.
#
# Usage:
#   ./scripts/run-surveytracker-master-ci.sh [worktree-path]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEBUG="$ROOT/scripts/debug-finalize-runner.sh"
SECRETS="$ROOT/scripts/load-finalize-project-secrets.sh"
WT="${1:-/tmp/surveytracker-master}"
BACKEND_CONTAINER="${FINALIZE_BACKEND_CONTAINER:-finalize-st-backend}"
FRONTEND_CONTAINER="${FINALIZE_FRONTEND_CONTAINER:-finalize-st-frontend}"
PROJECT_ID="${FINALIZE_PROJECT_ID:-surveytracker}"

if [[ ! -f "$WT/.agent-hub/ci.yaml" ]]; then
  echo "Missing $WT/.agent-hub/ci.yaml — update worktree:" >&2
  echo "  cd $WT && git reset --hard origin/master" >&2
  exit 1
fi

export FINALIZE_ENV_FILE="/tmp/finalize-project-env.${PROJECT_ID}"
if "$SECRETS" "$PROJECT_ID" "$FINALIZE_ENV_FILE"; then
  echo "Loaded Hub project secrets into $FINALIZE_ENV_FILE"
else
  echo "Warning: could not load project secrets — backend/E2E may fail on AWS" >&2
fi

run_job() {
  local job="$1"
  local container="$2"
  local compose_project="$3"
  shift 3
  local -a steps=("$@")
  local i=0

  echo ""
  echo "========== Job: $job ($container) =========="
  COMPOSE_PROJECT_NAME="$compose_project" "$DEBUG" start "$WT" "$container"

  for step_script in "${steps[@]}"; do
    i=$((i + 1))
    echo ""
    echo "--- $job step $i ---"
    if COMPOSE_PROJECT_NAME="$compose_project" "$DEBUG" exec "$container" "$step_script"; then
      echo "✓ $job step $i passed"
    else
      echo "✗ $job step $i failed" >&2
      COMPOSE_PROJECT_NAME="$compose_project" "$DEBUG" stop "$container" || true
      return 1
    fi
  done

  COMPOSE_PROJECT_NAME="$compose_project" "$DEBUG" stop "$container"
  echo "✓ Job $job passed"
}

# Step bodies from .agent-hub/ci.yaml on master.
BACKEND_LINT='
set -euo pipefail
PYBIN="$(command -v python3.11 || command -v python3.12 || command -v python3)"
[ -d .venv ] || "$PYBIN" -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q flake8 black==25.1.0
.venv/bin/python -m flake8 backend/
.venv/bin/python -m black --check --diff backend/
'

BACKEND_TESTS='
set -euo pipefail
PYBIN="$(command -v python3.11 || command -v python3.12 || command -v python3)"
[ -d .venv ] || "$PYBIN" -m venv .venv
. .venv/bin/activate
python -c "import pytest, psycopg2, coverage, django" 2>/dev/null || python -m pip install -q -r backend/requirements-docker.txt
[ -f .env ] || touch .env
./run_api_tests
'

FRONTEND_INSTALL='
set -euo pipefail
cd frontend
npm ci
npm run lint:quiet
npm run check:cad-orphans
'

FRONTEND_BUILD='
set -euo pipefail
cd frontend && npm run build:production
'

FRONTEND_COMPONENT='
set -euo pipefail
cd frontend && npx cypress run --component
'

FRONTEND_E2E='
set -euo pipefail
sudo ./setup_local_tenants
./run_e2e_tests headless
'

run_backend() {
  run_job backend "$BACKEND_CONTAINER" "finalize-st-backend" "$BACKEND_LINT" "$BACKEND_TESTS"
}

run_frontend() {
  run_job frontend "$FRONTEND_CONTAINER" "finalize-st-frontend" \
    "$FRONTEND_INSTALL" "$FRONTEND_BUILD" "$FRONTEND_COMPONENT" "$FRONTEND_E2E"
}

echo "Worktree: $WT ($(git -C "$WT" log -1 --oneline))"
echo "ci.yaml: backend ∥ frontend (concurrent DinD job containers)"
echo "Runner image: ${FINALIZE_RUNNER_IMAGE:-agent-hub/finalize-runner:ubuntu-24.04}"

FAILED=0
run_backend &
PID_B=$!
run_frontend &
PID_F=$!
wait "$PID_B" || FAILED=1
wait "$PID_F" || FAILED=1

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo "All ci.yaml jobs passed in concurrent DinD runners."
else
  echo "One or more ci.yaml jobs failed." >&2
  exit 1
fi
