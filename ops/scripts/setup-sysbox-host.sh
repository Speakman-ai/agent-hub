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
#   --address-pool-base <cidr>
#                         Widen Docker's default-address-pools so per-session
#                         compose previews don't exhaust the stock pool (~31
#                         subnets). OFF unless set. The CIDR MUST NOT overlap
#                         this host's VPC/subnet range — a wrong base silently
#                         breaks host<->container routing. e.g. 10.128.0.0/9.
#   --address-pool-size <n>
#                         Prefix length carved for each preview network from the
#                         base (default 24 → 256 addrs/network). Must be >= the
#                         base prefix and <= 30.
#
# Env overrides:
#   SYSBOX_VERSION                       Package/source tag (default 0.7.0).
#   AGENT_HUB_DOCKER_ADDRESS_POOL_BASE   Same as --address-pool-base.
#   AGENT_HUB_DOCKER_ADDRESS_POOL_SIZE   Same as --address-pool-size.
#
# Companion doc: docs/deployment/SYSBOX-HOST-SETUP.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYSBOX_VERSION="${SYSBOX_VERSION:-0.7.0}"
VERIFY_RUN=0
SKIP_DOCKER_RESTART=0
ADDRESS_POOL_BASE="${AGENT_HUB_DOCKER_ADDRESS_POOL_BASE:-}"
ADDRESS_POOL_SIZE="${AGENT_HUB_DOCKER_ADDRESS_POOL_SIZE:-24}"
# Tracks an *explicit* --address-pool-base flag so a present-but-empty value
# (`--address-pool-base` at end of line, or `--address-pool-base=`) is rejected
# as a malformed opt-in rather than silently treated as opt-out. Per-branch
# shifts (no trailing shift) so a value flag with no argument can't run `shift`
# past the end and trip `set -e`.
BASE_FLAG_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --verify-run) VERIFY_RUN=1; shift ;;
    --skip-docker-restart) SKIP_DOCKER_RESTART=1; shift ;;
    --address-pool-base)
      BASE_FLAG_GIVEN=1; ADDRESS_POOL_BASE="${2-}"; shift 2 2>/dev/null || shift ;;
    --address-pool-base=*)
      BASE_FLAG_GIVEN=1; ADDRESS_POOL_BASE="${1#*=}"; shift ;;
    --address-pool-size)
      ADDRESS_POOL_SIZE="${2-}"; shift 2 2>/dev/null || shift ;;
    --address-pool-size=*)
      ADDRESS_POOL_SIZE="${1#*=}"; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log()  { echo "[sysbox-setup] $*"; }
fail() { echo "[sysbox-setup] ERROR: $*" >&2; exit 1; }

# A typed --address-pool-base must carry a value; an empty one is a malformed
# opt-in, never a silent "leave pools unchanged". (An unset flag / unset env is
# the real opt-out and leaves ADDRESS_POOL_BASE empty with BASE_FLAG_GIVEN=0.)
if [ "$BASE_FLAG_GIVEN" = "1" ] && [ -z "$ADDRESS_POOL_BASE" ]; then
  fail "--address-pool-base requires a CIDR value (e.g. 10.128.0.0/9); omit the flag to leave default-address-pools unchanged"
fi

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

# ── Configure the Docker daemon (runtime + optional address pools) ───────────
# One idempotent merge covers both the sysbox-runc runtime and, when the
# operator opts in, a widened default-address-pools. Kept independent of the
# "runtime already registered" check so re-running the script purely to add or
# change pools works on an already-sysbox host. dockerd is restarted only when
# the merged config actually differs (a needless restart bounces containers).
DAEMON_JSON=/etc/docker/daemon.json
mkdir -p /etc/docker
[ -f "$DAEMON_JSON" ] || echo '{}' > "$DAEMON_JSON"

# Canonicalise JSON (sorted keys, no whitespace noise) through one tool so a
# semantic no-op never triggers a restart just because of formatting drift.
canon_json() {
  if command -v jq >/dev/null 2>&1; then
    jq -S -c . "$1"
  else
    python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])),sort_keys=True,separators=(",",":")))' "$1"
  fi
}

if [ -n "$ADDRESS_POOL_BASE" ]; then
  # Fully parse and canonicalize every input BEFORE the daemon config is touched
  # — a malformed base or size written into daemon.json wedges the subsequent
  # `systemctl restart docker` after the live config has already been replaced.
  # A real IPv4 parser (not digits-and-dots globs) rejects bad octets, an
  # out-of-range prefix, host-bits-set, and non-IPv4, and normalizes the base.
  command -v python3 >/dev/null 2>&1 || fail "python3 is required to validate --address-pool-base"
  ADDRESS_POOL_BASE="$(python3 "$SCRIPT_DIR/validate-ipv4-network.py" "$ADDRESS_POOL_BASE")" \
    || fail "invalid --address-pool-base (want a valid IPv4 network base, e.g. 10.128.0.0/9)"
  BASE_PREFIX="${ADDRESS_POOL_BASE#*/}"
  # Size is only meaningful with a base, so validate it strictly here.
  case "$ADDRESS_POOL_SIZE" in (*[!0-9]*|"") fail "invalid --address-pool-size '$ADDRESS_POOL_SIZE' (want an integer 1..30)";; esac
  [ "$ADDRESS_POOL_SIZE" -ge 1 ] && [ "$ADDRESS_POOL_SIZE" -le 30 ] || fail "--address-pool-size must be 1..30"
  [ "$ADDRESS_POOL_SIZE" -ge "$BASE_PREFIX" ] || fail "--address-pool-size ($ADDRESS_POOL_SIZE) must be >= base prefix (/$BASE_PREFIX)"
  log "WARN: widening default-address-pools to base=$ADDRESS_POOL_BASE size=$ADDRESS_POOL_SIZE — verify this does NOT overlap the host VPC/subnet CIDR"
else
  # Default-off path: no base supplied, so the pool is never emitted and size is
  # irrelevant. Force a safe value so a stray --address-pool-size / env var can
  # never reach `jq --argjson` (or fail validation) and abort the sysbox install.
  ADDRESS_POOL_SIZE=24
fi

TMP="$(mktemp)"
if command -v jq >/dev/null 2>&1; then
  jq --arg base "$ADDRESS_POOL_BASE" --argjson size "$ADDRESS_POOL_SIZE" \
    -f "$SCRIPT_DIR/daemon-json-merge.jq" "$DAEMON_JSON" > "$TMP"
else
  ADDRESS_POOL_BASE="$ADDRESS_POOL_BASE" ADDRESS_POOL_SIZE="$ADDRESS_POOL_SIZE" \
  python3 - "$DAEMON_JSON" > "$TMP" <<'PY'
import json, os, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
# Add the sysbox-runc runtime only when absent — never overwrite an operator's
# existing (possibly customized) entry. Mirrors daemon-json-merge.jq.
runtimes = cfg.setdefault("runtimes", {})
if "sysbox-runc" not in runtimes:
    runtimes["sysbox-runc"] = {"path": "/usr/bin/sysbox-runc"}
base = os.environ.get("ADDRESS_POOL_BASE", "")
if base:
    cfg["default-address-pools"] = [{"base": base, "size": int(os.environ["ADDRESS_POOL_SIZE"])}]
print(json.dumps(cfg, indent=2))
PY
fi

if [ "$(canon_json "$DAEMON_JSON")" = "$(canon_json "$TMP")" ]; then
  log "docker daemon already configured (sysbox-runc${ADDRESS_POOL_BASE:+ + default-address-pools}); no change"
  rm -f "$TMP"
else
  log "updating $DAEMON_JSON (sysbox-runc runtime${ADDRESS_POOL_BASE:+, default-address-pools})"
  cp -a "$DAEMON_JSON" "${DAEMON_JSON}.bak.sysbox-setup"
  mv "$TMP" "$DAEMON_JSON"
  if [ "$SKIP_DOCKER_RESTART" = "1" ]; then
    log "WARN: --skip-docker-restart set — daemon.json updated but dockerd not restarted; run 'systemctl restart docker' to activate"
  else
    log "restarting docker (running containers with --restart policies will come back)"
    systemctl restart docker
    docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"' \
      || fail "runtime not visible after docker restart"
    log "docker daemon configured"
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
