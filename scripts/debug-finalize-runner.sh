#!/usr/bin/env bash
# Debug a Finalize DinD runner locally — same image/flags Hub uses.
#
# Usage:
#   ./scripts/debug-finalize-runner.sh start <worktree-path> [container-name]
#   ./scripts/debug-finalize-runner.sh exec <container-name> '<shell command>'
#   ./scripts/debug-finalize-runner.sh shell <container-name>
#   ./scripts/debug-finalize-runner.sh stop <container-name>
#
# Examples (a project's session worktree):
#   WT=~/.agent-hub/data/.agent-hub/workspaces/<project>/session-<id>
#   ./scripts/debug-finalize-runner.sh start "$WT"
#   ./scripts/debug-finalize-runner.sh exec finalize-debug 'python3 -m venv /tmp/v && echo ok'
#   ./scripts/debug-finalize-runner.sh exec finalize-debug 'cd frontend && npm ci'
#   ./scripts/debug-finalize-runner.sh stop finalize-debug
#
# Requires: docker, agent-hub/finalize-runner image (see scripts/build-finalize-runner.sh)
# Apple Silicon local dev: FINALIZE_RUNNER_IMAGE=agent-hub/finalize-runner:ubuntu-24.04-arm64
# Linux / GHA parity:       FINALIZE_RUNNER_IMAGE=agent-hub/finalize-runner:ubuntu-24.04

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${FINALIZE_RUNNER_IMAGE:-agent-hub/finalize-runner:ubuntu-24.04}"
WORKSPACE="/github/workspace"
CMD="${1:-}"

runner_env_args() {
  printf '%s\n' \
    -e HOME=/home/runner \
    -e USER=runner \
    -e AGENT_HUB_RUNNER=1 \
    -e NPM_CONFIG_CACHE=/tmp/.npm \
    -e "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-finalize-debug}"
  if [[ -n "${FINALIZE_ENV_FILE:-}" && -f "$FINALIZE_ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" =~ ^# ]] && continue
      printf '%s\n' -e "$line"
    done < "$FINALIZE_ENV_FILE"
  fi
}

start_runner() {
  local wt="${1:?worktree path required}"
  local name="${2:-finalize-debug}"
  local graph="${name}-graph"
  local host_wt
  if [[ -d "${AGENT_HUB_HOST_WORKSPACES_DIR:-}" ]]; then
    # When invoked from inside Hub server container, translate mount paths.
    host_wt="${AGENT_HUB_HOST_WORKSPACES_DIR}/${wt#*workspaces/}"
  else
    host_wt="$(cd "$wt" && pwd)"
  fi

  docker rm -f "$name" 2>/dev/null || true
  docker volume rm "$graph" 2>/dev/null || true

  echo "Starting $name (image=$IMAGE, mount=$host_wt)..."
  docker run -d \
    --privileged \
    --cgroupns=host \
    --name "$name" \
    -v "${host_wt}:${WORKSPACE}:rw" \
    -v "${graph}:/var/lib/docker" \
    -v "finalize-image-cache:/finalize-cache" \
    -w "$WORKSPACE" \
    $(runner_env_args) \
    "$IMAGE" /usr/local/bin/runner-entrypoint.sh daemon

  echo -n "Waiting for inner dockerd"
  for _ in $(seq 1 120); do
    if docker exec -u runner "$name" docker info >/dev/null 2>&1; then
      echo " ready."
      docker exec -u runner "$name" docker version --format '{{.Server.Version}}' || true
      echo "Run: $0 exec $name '<command>'  or  $0 shell $name"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo
  echo "Inner dockerd not ready — logs:" >&2
  docker exec "$name" cat /tmp/dockerd.log 2>/dev/null || docker logs "$name" >&2
  exit 1
}

exec_runner() {
  local name="${1:?container name required}"
  local run="${2:?shell command required}"
  docker exec -i -u runner -w "$WORKSPACE" $(runner_env_args) "$name" bash -euo pipefail -c "$run"
}

shell_runner() {
  local name="${1:?container name required}"
  docker exec -it -u runner -w "$WORKSPACE" $(runner_env_args) "$name" bash
}

stop_runner() {
  local name="${1:?container name required}"
  docker rm -f -v "$name" 2>/dev/null || true
  docker volume rm "${name}-graph" 2>/dev/null || true
  echo "Stopped $name"
}

case "$CMD" in
  start) start_runner "${2:-}" "${3:-}" ;;
  exec)  exec_runner "${2:-}" "${3:-}" ;;
  shell) shell_runner "${2:-}" ;;
  stop)  stop_runner "${2:-}" ;;
  *)
    sed -n '2,16p' "$0" >&2
    exit 1
    ;;
esac
