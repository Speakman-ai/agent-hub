#!/usr/bin/env bash
# Start inner dockerd for Finalize DinD runners, then hold the container open.
set -euo pipefail

# Must NOT live in /tmp. /tmp is world-writable and sticky, so when
# fs.protected_regular=1 the kernel's may_create_in_sticky() refuses an O_CREAT
# open of a file owned by another user — and it has no CAP_DAC_OVERRIDE bypass,
# so even root is refused. The entrypoint runs as `runner` while the dockerd
# redirect below runs under sudo, so a /tmp path makes root fail to open the
# runner-owned log with EACCES and dockerd never starts. The Finalize fleet AMI
# sets the sysctl to 0, which is why only Hub-host DinD (session envs) hit it.
DOCKERD_LOG=/var/log/dockerd.log

RUNNER_USER="${RUNNER_USER:-runner}"

# The session worktree is bind-mounted from the host, so its files carry the
# uid/gid of the process that created them — the Hub, typically uid 1000. A
# container user on a different uid gets an effectively read-only workspace and
# git refuses the checkout as "dubious ownership", which makes the session
# unusable for editing, building, or committing. The Dockerfile therefore pins
# $RUNNER_USER to 1000:1000 to match; this only verifies the result.
#
# Repairing a mismatch here is not possible, which is why this checks instead of
# fixing. The entrypoint runs AS $RUNNER_USER, and nothing can renumber the
# account a live process is using: `usermod` refuses ("user runner is currently
# used by process 1", exit 8) and rewriting /etc/passwd orphans the running uid,
# after which every `sudo` — including the one that starts dockerd — dies with
# "you do not exist in the passwd database". Both were tried; both leave the
# container dead in a way that reads as a mystery start failure.
#
# So a mismatch is reported as the build-time problem it actually is, rather than
# handing back a container whose workspace silently rejects every write.
# AGENT_HUB_WORKSPACE_UID unset means no check, which is the Finalize path.
align_runner_identity() {
  local want_uid="${AGENT_HUB_WORKSPACE_UID:-}"
  local want_gid="${AGENT_HUB_WORKSPACE_GID:-}"
  if [ -z "$want_uid" ]; then
    return 0
  fi

  local cur_uid cur_gid
  cur_uid="$(id -u "$RUNNER_USER")"
  cur_gid="$(id -g "$RUNNER_USER")"
  want_gid="${want_gid:-$cur_gid}"
  if [ "$want_uid" = "$cur_uid" ] && [ "$want_gid" = "$cur_gid" ]; then
    return 0
  fi

  echo "[finalize-runner] FATAL: workspace is owned by ${want_uid}:${want_gid} but ${RUNNER_USER} is ${cur_uid}:${cur_gid}." >&2
  echo "[finalize-runner] A running account cannot be renumbered from inside its own container." >&2
  echo "[finalize-runner] Rebuild this image with ${RUNNER_USER} on ${want_uid}:${want_gid} (see the useradd step in the Dockerfile)." >&2
  return 1
}

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

# Poll `docker info` up to (attempts * 0.5s), echoing readiness for $driver.
# Returns 0 as soon as the daemon answers, 1 on timeout.
wait_for_dockerd() {
  local driver="$1" attempts="$2" attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    if docker info >/dev/null 2>&1; then
      echo "[finalize-runner] dockerd ready (${driver})"
      return 0
    fi
    sleep 0.5
    attempt=$((attempt + 1))
  done
  return 1
}

start_dockerd() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  # Created as root so the sudo'd append below is opening its own file, and
  # 0644 so the failure `tail` at the end of this function can still read it.
  sudo sh -c ": > ${DOCKERD_LOG} && chmod 0644 ${DOCKERD_LOG}"

  # A healthy overlay2 daemon is ready in a few seconds; cap the wait at ~30s so
  # a genuinely broken overlay2 falls through to vfs fast instead of burning 60s.
  start_dockerd_with_driver overlay2
  if wait_for_dockerd overlay2 60; then
    return 0
  fi

  echo "[finalize-runner] overlay2 failed; retrying with vfs..." >&2
  sudo pkill dockerd 2>/dev/null || true
  sleep 1
  start_dockerd_with_driver vfs

  if wait_for_dockerd vfs 120; then
    return 0
  fi

  echo "[finalize-runner] dockerd failed to start — see ${DOCKERD_LOG}" >&2
  tail -50 "${DOCKERD_LOG}" >&2 || true
  return 1
}

case "${1:-}" in
  daemon)
    align_runner_identity
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
