#!/usr/bin/env bash
# Start inner dockerd for Finalize DinD runners, then hold the container open.
set -euo pipefail

DOCKERD_LOG=/tmp/dockerd.log

# Configure a registry pull-through cache / mirror for the inner dockerd when
# FINALIZE_REGISTRY_MIRROR is set (e.g. http://host.docker.internal:5000 locally,
# or an ECR pull-through endpoint in prod). This stops every isolated shard from
# re-pulling base images (node/python/postgres) straight from Docker Hub, which
# otherwise trips Docker Hub's anonymous pull-rate limit (429). Unset = no mirror.
configure_registry_mirror() {
  [ -z "${FINALIZE_REGISTRY_MIRROR:-}" ] && return 0
  local mirror="${FINALIZE_REGISTRY_MIRROR}"
  # An http mirror must also be listed as an insecure-registry; https needs nothing.
  local insecure="[]"
  case "$mirror" in
    http://*)
      local hostport="${mirror#http://}"
      insecure="[\"${hostport%%/*}\"]"
      ;;
  esac
  echo "[finalize-runner] registry mirror: ${mirror} (insecure=${insecure})"
  sudo mkdir -p /etc/docker
  printf '{\n  "registry-mirrors": ["%s"],\n  "insecure-registries": %s\n}\n' \
    "$mirror" "$insecure" | sudo tee /etc/docker/daemon.json >/dev/null
}

# The shared image-cache volume (/finalize-cache) mounts root-owned; make it
# writable by the non-root runner user so run_e2e_ci.sh can docker save/load
# build artifacts there. Idempotent across the shards that share the volume.
prepare_image_cache() {
  [ -d /finalize-cache ] || return 0
  sudo chown "${USER:-runner}:${USER:-runner}" /finalize-cache 2>/dev/null || true
}

start_dockerd_with_driver() {
  local driver="$1"
  echo "[finalize-runner] starting dockerd (${driver})..."
  # Redirect must run inside the root shell — the runner user cannot write /var/log.
  sudo sh -c "dockerd --storage-driver=${driver} >> ${DOCKERD_LOG} 2>&1 &"
}

start_dockerd() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  : > "${DOCKERD_LOG}" 2>/dev/null || sudo sh -c ": > ${DOCKERD_LOG}"

  start_dockerd_with_driver overlay2

  local attempt=0
  while [ "$attempt" -lt 60 ]; do
    if docker info >/dev/null 2>&1; then
      echo "[finalize-runner] dockerd ready (overlay2)"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "[finalize-runner] overlay2 failed; retrying with vfs..." >&2
  sudo pkill dockerd 2>/dev/null || true
  sleep 2
  start_dockerd_with_driver vfs

  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if docker info >/dev/null 2>&1; then
      echo "[finalize-runner] dockerd ready (vfs)"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "[finalize-runner] dockerd failed to start — see ${DOCKERD_LOG}" >&2
  tail -50 "${DOCKERD_LOG}" >&2 || true
  return 1
}

case "${1:-}" in
  daemon)
    configure_registry_mirror
    prepare_image_cache
    start_dockerd
    exec sleep infinity
    ;;
  agent)
    # Pull-based runner agent: claims jobs from the Hub and starts privileged
    # JOB containers via the host docker socket mounted into this task. No inner
    # dockerd here — each JOB container runs `daemon` mode (its own dockerd).
    exec node /usr/local/bin/runner-agent.mjs
    ;;
  *)
    exec "$@"
    ;;
esac
