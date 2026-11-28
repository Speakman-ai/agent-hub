#!/bin/bash
# Snapshot of a host run script written by user-data before the agent desktop
# image existed. push-image-workflow.test.ts patches it with the rollout step.
set -e
IMAGE_URI="public.ecr.aws/h9t4v7h0/agent-hub:main"
RUNNER_IMAGE_URI="public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main"

# CI / manual deploy writes the moving tag here before systemctl restart.
# Override the baked-in image URI so pull-on-start tracks the tag that was
# just published rather than whatever tag was embedded at host bootstrap.
if [ -f /etc/agent-hub/image-tag ]; then
  DEPLOY_TAG="$(tr -d '[:space:]' < /etc/agent-hub/image-tag)"
  if [ -n "$DEPLOY_TAG" ]; then
    IMAGE_BASE="${IMAGE_URI%:*}"
    IMAGE_URI="$IMAGE_BASE:$DEPLOY_TAG"
    if [ -n "$RUNNER_IMAGE_URI" ]; then
      RUNNER_BASE="${RUNNER_IMAGE_URI%:*}"
      RUNNER_IMAGE_URI="$RUNNER_BASE:$DEPLOY_TAG"
    fi
  fi
fi

REPO_DIR="/home/agenthub/agent-hub"
DATA_ROOT="/var/lib/agent-hub"
APP_PORT="3051"

# Pull-on-start: cheap when the digest is unchanged (a few hundred bytes for the
# manifest), and the only correctness-preserving way to redeploy on reboot.
#
# CRITICAL: this loop MUST exit non-zero if all attempts fail. The original
# implementation fell through to  on a pull failure, which
# silently launched the container on the stale cached image — and systemd +
# CI both reported success. Observed 2026-05-11: dev sandbox stuck on v1.16.0
# for 3 days under disk-full conditions because pull failures were swallowed.
# See kanban card 89903017 for the post-mortem.
PULL_OK=0
for i in 1 2 3; do
  if docker pull --quiet "$IMAGE_URI"; then
    PULL_OK=1
    break
  fi
  echo "docker pull failed (attempt $i); retrying in 10s..." >&2
  sleep 10
done
if [ "$PULL_OK" != "1" ]; then
  echo "FATAL: docker pull $IMAGE_URI failed after 3 attempts. Refusing to start with stale local image." >&2
  echo "       Check disk space (df -h /var/lib/docker) and ECR connectivity." >&2
  exit 1
fi

if [ -n "$RUNNER_IMAGE_URI" ]; then
  RUNNER_PULL_OK=0
  for i in 1 2 3; do
    if docker pull --quiet "$RUNNER_IMAGE_URI"; then
      RUNNER_PULL_OK=1
      break
    fi
    echo "finalize runner pull failed (attempt $i); retrying in 10s..." >&2
    sleep 10
  done
  if [ "$RUNNER_PULL_OK" != "1" ]; then
    # The finalize runner image is OPTIONAL (in-box Finalize CI only). Never let a
    # missing/unpublished runner image block the server — that would restart-loop
    # the whole Hub. Warn, drop the image, and start the server without it;
    # remote-fleet CI is unaffected.
    echo "WARN: docker pull $RUNNER_IMAGE_URI failed after 3 attempts — starting WITHOUT the in-box finalize runner image." >&2
    RUNNER_IMAGE_URI=""
  fi
fi

docker rm -f agenthub-server 2>/dev/null || true
# Compose session previews: Hub shells out to the host Docker daemon.
DOCKER_GID=993
DOCKER_GROUP_ARG=""
if [ -n "$DOCKER_GID" ]; then
  DOCKER_GROUP_ARG="--group-add $DOCKER_GID"
fi
# Bind-mount layout: each host data dir is mounted TWICE — once at the
# legacy in-container path (/home/node/projects, /home/node/.agent-hub/
# workspaces) that agents read/write, and once at its host-absolute path
# ($DATA_ROOT/projects, $DATA_ROOT/workspaces) so the in-container
# docker CLI can  build contexts at the host path that
#  emits. Without the host-path alias, compose-go
# (running inside this container) fails with "unable to prepare context:
# path \"$DATA_ROOT/projects/<slug>/<svc>\" not found" the moment a
# preview compose file declares  — because that path exists on
# the daemon (the host) but not in the container's filesystem namespace.
# Two -v flags for the same source are aliases for one inode; agents
# keep using /home/node/... unchanged.
# Firecracker: mount host artifact/control dir at the same absolute path the
# Hub and privileged VMM helper both dial. PRIVILEGED_IMAGE runs the VMM in a
# sibling container (this Hub stays unprivileged; no /dev/kvm here).
MEM_TOTAL_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
HUB_MEM_PCT="${AGENT_HUB_CONTAINER_MEMORY_PCT:-75}"
HUB_MEM_ARGS=""
if [ -n "$MEM_TOTAL_KB" ] && [ "$HUB_MEM_PCT" -gt 0 ] 2>/dev/null; then
  HUB_MEM_KB=$(( MEM_TOTAL_KB * HUB_MEM_PCT / 100 ))
  HUB_MEM_ARGS="--memory ${HUB_MEM_KB}k --memory-swap ${HUB_MEM_KB}k"
fi
exec docker run --rm --name agenthub-server \
  -p "$APP_PORT:3051" \
  $HUB_MEM_ARGS \
  --ulimit core=0 \
  -v "$DATA_ROOT/data:/data" -v "$DATA_ROOT/uploads:/app/uploads" \
  -v "$DATA_ROOT/projects:/home/node/projects" \
  -v "$DATA_ROOT/workspaces:/home/node/.agent-hub/workspaces" \
  -v "$DATA_ROOT/projects:$DATA_ROOT/projects" \
  -v "$DATA_ROOT/workspaces:$DATA_ROOT/workspaces" \
  -v "$DATA_ROOT/firecracker:$DATA_ROOT/firecracker" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host=host.docker.internal:host-gateway \
  $DOCKER_GROUP_ARG \
  -e "AGENT_HUB_HOST_PROJECTS_DIR=$DATA_ROOT/projects" \
  -e "AGENT_HUB_HOST_WORKSPACES_DIR=$DATA_ROOT/workspaces" \
  -e "AGENT_HUB_CONTAINER_PROJECTS_DIR=/home/node/projects" \
  -e "AGENT_HUB_CONTAINER_WORKSPACES_DIR=/home/node/.agent-hub/workspaces" \
  -e "AGENT_HUB_PREVIEW_HEALTH_HOST=host.docker.internal" \
  -e "AGENT_HUB_FIRECRACKER_DIR=$DATA_ROOT/firecracker" \
  ${RUNNER_IMAGE_URI:+-e "FINALIZE_RUNNER_IMAGE_UBUNTU_24_04=$RUNNER_IMAGE_URI"} \
  ${RUNNER_IMAGE_URI:+-e "AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE=$RUNNER_IMAGE_URI"} \
  --env-file "$REPO_DIR/.env" \
  "$IMAGE_URI"

