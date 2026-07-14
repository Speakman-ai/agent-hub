#!/usr/bin/env bash
#
# Install sysbox-runc on the Agent Hub host and register it as a Docker
# runtime, so the Hub's SessionEnv sysbox adapter can run per-session dev
# environments in rootless system containers (no --privileged, no host
# docker socket).
#
# Supported paths:
#   * Ubuntu / Debian  — official sysbox-ce package (.deb).
#   * Amazon Linux 2023 (and other kernel >= 5.12 distros) — build from
#     source (officially listed as a build-from-source target in sysbox's
#     distro-compat.md; kernel 6.1 on AL2023 clears every kernel gate).
#
# Idempotent: re-running skips completed steps. Requires root.
#
# Usage:
#   sudo ./setup-sysbox-host.sh [--verify-run] [--skip-docker-restart]
#
#   --verify-run          After install, launch a throwaway container with
#                         --runtime=sysbox-runc to prove the runtime works.
#   --skip-docker-restart Register the runtime in daemon.json but do NOT
#                         restart dockerd (do it in a maintenance window;
#                         the runtime is unusable until the restart).
#
# Env overrides:
#   SYSBOX_VERSION   Package/source tag to install (default 0.7.0).
#
# Companion doc: docs/deployment/SYSBOX-HOST-SETUP.md
set -euo pipefail

SYSBOX_VERSION="${SYSBOX_VERSION:-0.7.0}"
VERIFY_RUN=0
SKIP_DOCKER_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --verify-run) VERIFY_RUN=1 ;;
    --skip-docker-restart) SKIP_DOCKER_RESTART=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log()  { echo "[sysbox-setup] $*"; }
fail() { echo "[sysbox-setup] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "must run as root (sudo)"
[ "$(uname -s)" = "Linux" ] || fail "sysbox requires Linux"

# ── Kernel feature verification ──────────────────────────────────────────────
# Non-shiftfs distros (AL2023, Fedora, RHEL, ...) need idmapped mounts:
# kernel >= 5.12 required, >= 5.19 recommended (no shiftfs anywhere).
KREL="$(uname -r)"
KMAJ="${KREL%%.*}"
KMIN="$(echo "$KREL" | cut -d. -f2)"
case "$KMAJ$KMIN" in (*[!0-9]*) fail "cannot parse kernel release '$KREL'";; esac
if [ "$KMAJ" -lt 5 ] || { [ "$KMAJ" -eq 5 ] && [ "$KMIN" -lt 12 ]; }; then
  fail "kernel $KREL < 5.12 — sysbox needs idmapped mounts on this distro"
fi
if [ "$KMAJ" -eq 5 ] && [ "$KMIN" -lt 19 ]; then
  log "WARN: kernel $KREL is in the 5.12–5.18 band; >= 5.19 recommended"
fi
log "kernel $KREL OK"

USERNS_MAX="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 0)"
if [ "${USERNS_MAX:-0}" -le 0 ]; then
  fail "unprivileged user namespaces disabled (/proc/sys/user/max_user_namespaces=$USERNS_MAX). Enable with: sysctl -w user.max_user_namespaces=63398 (persist in /etc/sysctl.d/)"
fi
log "user namespaces OK (max_user_namespaces=$USERNS_MAX)"

command -v docker >/dev/null 2>&1 || fail "docker not installed"
if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
  fail "Docker installed via snap is incompatible with sysbox — install docker natively"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  DEB_ARCH=amd64 ;;
  aarch64) DEB_ARCH=arm64 ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac

. /etc/os-release
DISTRO_ID="${ID:-unknown}"

# ── Install sysbox-runc ──────────────────────────────────────────────────────
if command -v sysbox-runc >/dev/null 2>&1; then
  log "sysbox-runc already installed: $(sysbox-runc --version | head -1)"
else
  case "$DISTRO_ID" in
    ubuntu|debian)
      log "installing sysbox-ce ${SYSBOX_VERSION} package (${DEB_ARCH})"
      DEB="/tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_${DEB_ARCH}.deb"
      curl -fSL -o "$DEB" \
        "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/sysbox-ce_${SYSBOX_VERSION}-0.linux_${DEB_ARCH}.deb"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      apt-get install -y jq
      # The package registers the docker runtime and installs the sysbox
      # systemd units itself.
      apt-get install -y "$DEB"
      rm -f "$DEB"
      ;;
    amzn|fedora|rhel|rocky|almalinux|centos|*)
      # Build-from-source path (sysbox has no rpm/AL2023 package). Builds
      # inside a container (make sysbox-static) so the host stays clean.
      log "no package for distro '$DISTRO_ID' — building sysbox v${SYSBOX_VERSION} from source"
      command -v git  >/dev/null 2>&1 || fail "git required for the source build"
      command -v make >/dev/null 2>&1 || fail "make required for the source build"
      BUILD_DIR="/opt/sysbox-build"
      if [ ! -d "$BUILD_DIR/.git" ]; then
        git clone --recursive --branch "v${SYSBOX_VERSION}" \
          https://github.com/nestybox/sysbox.git "$BUILD_DIR"
      fi
      ( cd "$BUILD_DIR" && make sysbox-static && make install )
      # The source build installs binaries only; provide the systemd units
      # the package would have shipped (sysbox-mgr + sysbox-fs daemons).
      cat >/etc/systemd/system/sysbox-mgr.service <<'UNIT'
[Unit]
Description=sysbox-mgr (sysbox manager daemon)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/sysbox-mgr
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
      cat >/etc/systemd/system/sysbox-fs.service <<'UNIT'
[Unit]
Description=sysbox-fs (sysbox FUSE filesystem daemon)
After=sysbox-mgr.service
Wants=sysbox-mgr.service

[Service]
Type=simple
ExecStart=/usr/bin/sysbox-fs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable --now sysbox-mgr.service sysbox-fs.service
      ;;
  esac
  command -v sysbox-runc >/dev/null 2>&1 || fail "sysbox-runc missing after install"
  log "installed: $(sysbox-runc --version | head -1)"
fi

# ── Register the Docker runtime ──────────────────────────────────────────────
DAEMON_JSON=/etc/docker/daemon.json
if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"sysbox-runc"'; then
  log "docker runtime 'sysbox-runc' already registered"
else
  log "registering 'sysbox-runc' runtime in $DAEMON_JSON"
  mkdir -p /etc/docker
  [ -f "$DAEMON_JSON" ] || echo '{}' > "$DAEMON_JSON"
  cp -a "$DAEMON_JSON" "${DAEMON_JSON}.bak.sysbox-setup"
  TMP="$(mktemp)"
  if command -v jq >/dev/null 2>&1; then
    jq '.runtimes["sysbox-runc"] = {"path": "/usr/bin/sysbox-runc"}' "$DAEMON_JSON" > "$TMP"
  else
    python3 - "$DAEMON_JSON" > "$TMP" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
cfg.setdefault("runtimes", {})["sysbox-runc"] = {"path": "/usr/bin/sysbox-runc"}
print(json.dumps(cfg, indent=2))
PY
  fi
  mv "$TMP" "$DAEMON_JSON"
  if [ "$SKIP_DOCKER_RESTART" = "1" ]; then
    log "WARN: --skip-docker-restart set — runtime registered but dockerd not restarted; run 'systemctl restart docker' to activate"
  else
    log "restarting docker (running containers with --restart policies will come back)"
    systemctl restart docker
    docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"' \
      || fail "runtime not visible after docker restart"
    log "docker runtime registered"
  fi
fi

# ── Optional end-to-end verification ─────────────────────────────────────────
if [ "$VERIFY_RUN" = "1" ]; then
  log "verify: launching a sysbox container"
  OUT="$(docker run --runtime=sysbox-runc --rm alpine:3 sh -c 'echo sysbox-ok')" \
    || fail "sysbox container run failed"
  [ "$OUT" = "sysbox-ok" ] || fail "unexpected verify output: $OUT"
  log "verify OK"
fi

log "done. The Hub's boot probe will now select the sysbox adapter"
log "(sessionEnvAdapter=auto). Force with AGENT_HUB_SESSION_ENV_ADAPTER."
