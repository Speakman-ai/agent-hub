#!/usr/bin/env bash
#
# Prepare an Agent Hub host to run session microVMs.
#
# Run once per host, after nested virtualization is on (see
# enable-nested-virtualization.sh) and before restarting the Hub. Everything
# here is idempotent, so re-running after an upgrade is safe.
#
# What it sets up:
#   1. firecracker + jailer binaries
#   2. /dev/kvm access for the Hub user
#   3. the shared bridge session taps attach to, with NAT for guest egress
#   4. a narrow sudoers rule for the two privileged operations the Hub needs
#   5. the VM scratch directory, on XFS so rootfs clones are copy-on-write
#
# It deliberately does NOT build the guest kernel/rootfs — that is
# server/session-env/firecracker/build/build-guest-artifacts.sh, which takes
# ~10 minutes and is usually run once and copied to hosts.
#
# Usage: sudo ops/scripts/setup-firecracker-host.sh [--hub-user ubuntu]
#                                                   [--version 1.16.1]
#                                                   [--tarball PATH]
#
# --tarball installs from an already-downloaded release archive instead of
# fetching from GitHub, for hosts with restricted egress.

set -euo pipefail

HUB_USER="${SUDO_USER:-ubuntu}"
# The Hub writes the per-VM config and dials the vsock socket itself, so it
# needs the scratch tree writable. When it runs as a container there is no
# matching host account — only a uid — so ownership is set numerically. 1000 is
# the `node` user the server image runs as.
HUB_UID="1000"
HUB_GID="1000"
FIRECRACKER_VERSION="1.16.1"
FIRECRACKER_TARBALL=""
ARTIFACT_DIR="/var/lib/agent-hub/firecracker"
RUN_DIR="/run/agent-hub/vms"
VM_SCRATCH="/var/lib/agent-hub/firecracker/vms"
BRIDGE="ahfc0"
BRIDGE_CIDR="172.30.0.1/16"
SUBNET="172.30.0.0/16"
HELPER_SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-user) HUB_USER="$2"; shift 2 ;;
    --hub-uid) HUB_UID="$2"; shift 2 ;;
    --hub-gid) HUB_GID="$2"; shift 2 ;;
    --version) FIRECRACKER_VERSION="$2"; shift 2 ;;
    --tarball) FIRECRACKER_TARBALL="$2"; shift 2 ;;
    --helper) HELPER_SRC="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || { echo "error: run with sudo" >&2; exit 1; }
[[ "$(uname -s)" == "Linux" ]] || { echo "error: Linux only" >&2; exit 1; }

ARCH="$(uname -m)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -n "${HELPER_SRC}" ]] || \
  HELPER_SRC="${REPO_ROOT}/server/session-env/firecracker/build/fc-prepare-disks.sh"

echo "==> Host: $(hostname), arch ${ARCH}, hub user ${HUB_USER}"

# ── 1. KVM ────────────────────────────────────────────────────────
if [[ ! -c /dev/kvm ]]; then
  echo "error: /dev/kvm is missing." >&2
  echo "       On EC2 this means nested virtualization is not enabled on this" >&2
  echo "       instance. Run ops/scripts/enable-nested-virtualization.sh first" >&2
  echo "       (it requires a stop/start), then re-run this script." >&2
  exit 1
fi

# The Hub opens /dev/kvm indirectly through firecracker, which runs as the Hub
# user; without group membership every VM boot fails with EACCES. When the Hub
# runs as a container the VMM is launched root-in-container with --device
# /dev/kvm instead, so a missing account here is not fatal — only the
# bare-metal deployment depends on the membership.
groupadd -f kvm
if id -u "${HUB_USER}" >/dev/null 2>&1; then
  usermod -aG kvm "${HUB_USER}"
else
  echo "note: no local user '${HUB_USER}'; skipping kvm group membership."
  echo "      Fine for a containerized Hub; pass --hub-user if it runs on the host."
fi
cat >/etc/udev/rules.d/99-agent-hub-kvm.rules <<'RULES'
# Keep /dev/kvm group-writable across reboots. Without this the node is
# usable until the next reboot and then silently stops booting VMs.
KERNEL=="kvm", GROUP="kvm", MODE="0660"
RULES
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger --name-match=kvm 2>/dev/null || true
chgrp kvm /dev/kvm && chmod 0660 /dev/kvm

# ── 2. Packages ───────────────────────────────────────────────────
# socat is not needed on the host (it runs in the guest), but the ip tooling,
# e2fsprogs, and xfsprogs are: taps, workspace images, and the CoW scratch
# filesystem respectively. Amazon Linux 2023 is the deployed host OS and Ubuntu
# is what most developer boxes run, so support both rather than assuming.
if command -v dnf >/dev/null 2>&1; then
  # AL2023 calls the package `iproute`, and `curl-minimal` is preinstalled and
  # conflicts with `curl` — asking for it would fail the whole transaction.
  dnf install -y -q iproute iptables-nft e2fsprogs xfsprogs ca-certificates >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    iproute2 iptables e2fsprogs xfsprogs curl ca-certificates >/dev/null
else
  echo "error: neither dnf nor apt-get found; install iproute/e2fsprogs/xfsprogs manually" >&2
  exit 1
fi

for tool in ip mkfs.ext4 iptables; do
  command -v "${tool}" >/dev/null \
    || { echo "error: ${tool} still missing after package install" >&2; exit 1; }
done

# ── 3. firecracker + jailer ───────────────────────────────────────
case "${ARCH}" in
  x86_64) FC_ARCH="x86_64" ;;
  aarch64) FC_ARCH="aarch64" ;;
  *) echo "error: unsupported architecture ${ARCH}" >&2; exit 1 ;;
esac

INSTALLED_VERSION="$(firecracker --version 2>/dev/null | head -1 | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' || true)"
if [[ "${INSTALLED_VERSION#v}" != "${FIRECRACKER_VERSION}" ]]; then
  echo "==> Installing firecracker ${FIRECRACKER_VERSION} (found: ${INSTALLED_VERSION:-none})"
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT
  if [[ -n "${FIRECRACKER_TARBALL}" ]]; then
    [[ -f "${FIRECRACKER_TARBALL}" ]] \
      || { echo "error: no tarball at ${FIRECRACKER_TARBALL}" >&2; exit 1; }
    cp "${FIRECRACKER_TARBALL}" "${TMP}/fc.tgz"
  else
    # GitHub redirects release assets to a separate CDN host, so a network that
    # allows github.com can still fail here. Retry before giving up.
    for attempt in 1 2 3; do
      if curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 300 \
        -o "${TMP}/fc.tgz" \
        "https://github.com/firecracker-microvm/firecracker/releases/download/v${FIRECRACKER_VERSION}/firecracker-v${FIRECRACKER_VERSION}-${FC_ARCH}.tgz"; then
        break
      fi
      echo "   download attempt ${attempt} failed" >&2
      [[ "${attempt}" -lt 3 ]] || {
        echo "error: could not download firecracker. On a restricted-egress host," >&2
        echo "       stage the release archive and pass --tarball PATH." >&2
        exit 1
      }
      sleep 5
    done
  fi
  tar -xzf "${TMP}/fc.tgz" -C "${TMP}"
  install -m 0755 "${TMP}/release-v${FIRECRACKER_VERSION}-${FC_ARCH}/firecracker-v${FIRECRACKER_VERSION}-${FC_ARCH}" /usr/bin/firecracker
  install -m 0755 "${TMP}/release-v${FIRECRACKER_VERSION}-${FC_ARCH}/jailer-v${FIRECRACKER_VERSION}-${FC_ARCH}" /usr/bin/jailer
  rm -rf "${TMP}"
  trap - EXIT
else
  echo "==> firecracker ${FIRECRACKER_VERSION} already installed"
fi

# ── 4. Bridge + NAT ───────────────────────────────────────────────
# One bridge for every session tap. This is what lets the Hub dial a guest IP
# directly and reuse container-IP port routing instead of publishing ports.
if ! ip link show "${BRIDGE}" >/dev/null 2>&1; then
  ip link add "${BRIDGE}" type bridge
fi
ip addr replace "${BRIDGE_CIDR}" dev "${BRIDGE}"
ip link set "${BRIDGE}" up

# Guests need outbound access (npm install, docker pull, pip, apt). Masquerade
# their subnet behind the host's primary interface.
#
# The Hub also re-applies these rules on every boot sweep
# (`reconcileFirecrackerHost` → `ensureFirecrackerGuestNat`). That matters
# because Docker restarts and AMI rollouts often leave `ahfc0` up while
# dropping the MASQUERADE rule — the failure mode is preview
# `apt-get exited with code 100` / "Temporary failure resolving …".
UPLINK="$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)"
if [[ -n "${UPLINK}" ]]; then
  sysctl -qw net.ipv4.ip_forward=1
  # Bridged guest↔guest traffic is L2 and skips iptables FORWARD unless
  # br_netfilter is loaded — without it the ahfc0→ahfc0 DROP is a no-op.
  modprobe br_netfilter 2>/dev/null || true
  sysctl -qw net.bridge.bridge-nf-call-iptables=1 2>/dev/null || true
  sysctl -qw net.bridge.bridge-nf-call-ip6tables=1 2>/dev/null || true
  {
    printf 'net.ipv4.ip_forward = 1\n'
    printf 'net.bridge.bridge-nf-call-iptables = 1\n'
    printf 'net.bridge.bridge-nf-call-ip6tables = 1\n'
  } > /etc/sysctl.d/99-agent-hub-firecracker.conf
  # -C tests for the rule first so re-running does not stack duplicates that
  # would survive as a growing NAT table across upgrades.
  iptables -t nat -C POSTROUTING -s "${SUBNET}" -o "${UPLINK}" -j MASQUERADE 2>/dev/null \
    || iptables -t nat -A POSTROUTING -s "${SUBNET}" -o "${UPLINK}" -j MASQUERADE
  iptables -C FORWARD -i "${BRIDGE}" -o "${BRIDGE}" -j DROP 2>/dev/null \
    || iptables -I FORWARD -i "${BRIDGE}" -o "${BRIDGE}" -j DROP
  iptables -C FORWARD -i "${BRIDGE}" -o "${UPLINK}" -j ACCEPT 2>/dev/null \
    || iptables -A FORWARD -i "${BRIDGE}" -o "${UPLINK}" -j ACCEPT
  iptables -C FORWARD -i "${UPLINK}" -o "${BRIDGE}" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
    || iptables -A FORWARD -i "${UPLINK}" -o "${BRIDGE}" -m state --state RELATED,ESTABLISHED -j ACCEPT
  # Prefer DOCKER-USER when present so Docker's isolation chains cannot drop
  # guest egress as collateral of docker0 rules. Scope to the uplink — a bare
  # `-i ahfc0 -j ACCEPT` would also open routes onto docker0 / sibling containers.
  if iptables -nL DOCKER-USER >/dev/null 2>&1; then
    iptables -C DOCKER-USER -i "${BRIDGE}" -o "${UPLINK}" -j ACCEPT 2>/dev/null \
      || iptables -I DOCKER-USER -i "${BRIDGE}" -o "${UPLINK}" -j ACCEPT
    iptables -C DOCKER-USER -i "${UPLINK}" -o "${BRIDGE}" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
      || iptables -I DOCKER-USER -i "${UPLINK}" -o "${BRIDGE}" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  fi
  echo "==> NAT configured: ${SUBNET} -> ${UPLINK}"
else
  echo "warning: no default route found; guests will have no outbound network" >&2
fi
# ── 5. Directories ────────────────────────────────────────────────
# Recursive in both branches. The Hub creates a directory per VM under
# VM_SCRATCH, so it needs write access to the tree, not just the top level —
# and guest artifacts are usually staged into ARTIFACT_DIR as root before or
# after this script runs, which leaves them unreadable to a Hub that is not
# root. A non-recursive chown here fails later as an EACCES on `mkdir` at the
# first session start, far from the cause.
mkdir -p "${ARTIFACT_DIR}" "${RUN_DIR}" "${VM_SCRATCH}"
if id -u "${HUB_USER}" >/dev/null 2>&1; then
  chown -R "${HUB_USER}:${HUB_USER}" "${ARTIFACT_DIR}" "${RUN_DIR}" "${VM_SCRATCH}"
else
  chown -R "${HUB_UID}:${HUB_GID}" "${ARTIFACT_DIR}" "${RUN_DIR}" "${VM_SCRATCH}"
  echo "==> Scratch owned by uid ${HUB_UID}:${HUB_GID} (containerized Hub)"
fi

# The rootfs clone uses `cp --reflink=auto`. On ext4 that degrades to a full
# multi-GB copy on every VM boot; on XFS it is a near-instant CoW clone. The
# difference is seconds per session start, so warn loudly when it is missing.
SCRATCH_FSTYPE="$(stat -f -c %T "${VM_SCRATCH}" 2>/dev/null || echo unknown)"
if [[ "${SCRATCH_FSTYPE}" != "xfs" && "${SCRATCH_FSTYPE}" != "btrfs" ]]; then
  echo "warning: ${VM_SCRATCH} is on ${SCRATCH_FSTYPE}, which has no reflink support." >&2
  echo "         Every VM boot will fully copy the base rootfs instead of cloning it." >&2
  echo "         Consider mounting an XFS volume there." >&2
fi

# ── 6. Disk helper + sudoers ──────────────────────────────────────
if [[ -f "${HELPER_SRC}" ]]; then
  install -D -m 0755 "${HELPER_SRC}" /usr/local/lib/agent-hub/fc-prepare-disks.sh
  echo "==> Installed fc-prepare-disks.sh"
else
  echo "warning: disk helper not found at ${HELPER_SRC}; pass --helper PATH" >&2
fi

# Privileged operations the Hub runs via `sudo -n` in local exec mode, named
# explicitly. A blanket NOPASSWD:ALL would make the microVM boundary pointless.
#
# Only meaningful for a Hub running directly on the host. A containerized Hub
# has no account here and reaches these operations through a privileged helper
# container instead (AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE).
if id -u "${HUB_USER}" >/dev/null 2>&1; then
  cat >/etc/sudoers.d/agent-hub-firecracker <<SUDOERS
# Managed by ops/scripts/setup-firecracker-host.sh
${HUB_USER} ALL=(root) NOPASSWD: /usr/local/lib/agent-hub/fc-prepare-disks.sh
${HUB_USER} ALL=(root) NOPASSWD: /usr/sbin/ip, /sbin/ip, /usr/bin/ip
${HUB_USER} ALL=(root) NOPASSWD: /usr/sbin/modprobe, /sbin/modprobe
${HUB_USER} ALL=(root) NOPASSWD: /usr/sbin/sysctl, /sbin/sysctl
${HUB_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables, /sbin/iptables, /usr/sbin/iptables-nft, /usr/sbin/xtables-nft-multi
${HUB_USER} ALL=(root) NOPASSWD: /usr/bin/firecracker, /usr/bin/jailer
SUDOERS
  chmod 0440 /etc/sudoers.d/agent-hub-firecracker
  visudo -cf /etc/sudoers.d/agent-hub-firecracker >/dev/null
fi

# ── Summary ───────────────────────────────────────────────────────
echo
echo "==> Firecracker host ready"
firecracker --version | head -1
echo "    bridge:    ${BRIDGE} (${BRIDGE_CIDR})"
echo "    artifacts: ${ARTIFACT_DIR}"
echo
if [[ ! -f "${ARTIFACT_DIR}/vmlinux" || ! -f "${ARTIFACT_DIR}/rootfs.ext4" ]]; then
  echo "    STILL NEEDED: guest artifacts are not staged. Build them with"
  echo "      server/session-env/firecracker/build/build-guest-artifacts.sh --out ${ARTIFACT_DIR}"
  echo "    Until then the capability probe will decline; with"
  echo "    sessionEnvAdapter=firecracker the Hub fails closed, and with auto"
  echo "    it uses sysbox (or host) instead."
else
  echo "    Guest artifacts present. Restart the Hub to pick up the backend."
fi
echo
if id -u "${HUB_USER}" >/dev/null 2>&1; then
  echo "    ${HUB_USER} was added to the kvm group — that only takes effect in a"
  echo "    new login session, so restart the Hub process (not just the shell)."
fi
