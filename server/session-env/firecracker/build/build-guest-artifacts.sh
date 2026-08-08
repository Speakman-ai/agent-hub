#!/usr/bin/env bash
#
# Build the two artifacts every session microVM boots from:
#
#   vmlinux      — uncompressed ELF kernel. Firecracker on x86_64 will not
#                  take a compressed bzImage, which is why we cannot simply
#                  reuse the distro's /boot/vmlinuz.
#   rootfs.ext4  — the guest filesystem, derived from the *same* finalize
#                  runner image CI uses, so a command behaves identically in
#                  a session and in the gate. Divergence between those two is
#                  the thing this whole subsystem exists to prevent.
#
# Both are content-addressed by a build id so a host can hold several versions
# and roll back without a rebuild.
#
# Usage:
#   build-guest-artifacts.sh [--out DIR] [--kernel-version 6.1.130]
#                            [--runner-image IMAGE] [--skip-kernel]
#                            [--vm-agent-bundle PATH]
#
# Runs on any Linux host with docker. The kernel compile is the slow part
# (~10 min on 4 vCPU); --skip-kernel reuses an existing vmlinux while
# iterating on the rootfs.
#
# By default the agent is bundled here, which needs the repo's server/
# node_modules. Deployment hosts do not have a checkout, so --vm-agent-bundle
# takes an already-bundled vm-agent.mjs instead and the builder only needs
# this directory, ../guest/systemd, and docker.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

OUT_DIR="/var/lib/agent-hub/firecracker"
KERNEL_VERSION="6.1.130"
RUNNER_IMAGE="agent-hub/finalize-runner:ubuntu-24.04"
SKIP_KERNEL=0
VM_AGENT_BUNDLE=""
# Sized for a full node_modules plus a build cache; the image is sparse, so
# this costs only what is written.
ROOTFS_SIZE_MIB="${ROOTFS_SIZE_MIB:-12288}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --kernel-version) KERNEL_VERSION="$2"; shift 2 ;;
    --runner-image) RUNNER_IMAGE="$2"; shift 2 ;;
    --skip-kernel) SKIP_KERNEL=1; shift ;;
    --vm-agent-bundle) VM_AGENT_BUNDLE="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: guest artifacts must be built on Linux (mkfs.ext4 + loop mounts)." >&2
  echo "       Run this on the Hub host or any Linux builder." >&2
  exit 1
fi

command -v docker >/dev/null || { echo "error: docker is required" >&2; exit 1; }

mkdir -p "${OUT_DIR}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

# ── 1. Kernel ─────────────────────────────────────────────────────
# Options whose absence is silent at build time and fatal (or baffling) at
# runtime. Not the whole fragment — just the ones that have already cost a
# debugging session, plus the storage/exec basics a container runtime needs.
REQUIRED_KERNEL_OPTIONS="
CONFIG_VIRTIO_BLK
CONFIG_VIRTIO_NET
CONFIG_VIRTIO_VSOCKETS
CONFIG_EXT4_FS
CONFIG_OVERLAY_FS
CONFIG_BRIDGE
CONFIG_VETH
CONFIG_NF_TABLES
CONFIG_NFT_COMPAT
CONFIG_NETFILTER_XT_MATCH_ADDRTYPE
CONFIG_NETFILTER_XT_MATCH_CONNTRACK
CONFIG_NETFILTER_XT_NAT
CONFIG_IP_NF_NAT
CONFIG_NF_NAT_MASQUERADE
CONFIG_MEMCG
CONFIG_CGROUP_BPF
CONFIG_USER_NS
CONFIG_SECCOMP_FILTER
"

if [[ "${SKIP_KERNEL}" -eq 0 ]]; then
  echo "==> Building guest kernel ${KERNEL_VERSION} (this takes a while)"
  cp "${SCRIPT_DIR}/guest-kernel.config" "${WORK_DIR}/fragment.config"

  docker run --rm \
    -v "${WORK_DIR}:/work" \
    -w /work \
    -e "REQUIRED_KERNEL_OPTIONS=${REQUIRED_KERNEL_OPTIONS}" \
    ubuntu:24.04 \
    bash -euxc "
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends \
        build-essential bc bison flex libelf-dev libssl-dev curl ca-certificates \
        xz-utils kmod cpio
      major=\$(echo '${KERNEL_VERSION}' | cut -d. -f1)
      curl -fsSL -o linux.tar.xz \
        \"https://cdn.kernel.org/pub/linux/kernel/v\${major}.x/linux-${KERNEL_VERSION}.tar.xz\"
      tar xf linux.tar.xz
      cd 'linux-${KERNEL_VERSION}'
      make defconfig
      # merge_config.sh reports any option the fragment asked for that the
      # build silently dropped — a dependency it could not satisfy. Those are
      # exactly the failures that would otherwise surface much later as
      # 'dockerd cannot start' inside a booted guest.
      ./scripts/kconfig/merge_config.sh -m .config /work/fragment.config
      make olddefconfig
      # merge_config only reports what the *merge* dropped; olddefconfig can
      # drop more when a dependency resolves away. Everything below has a
      # failure mode that appears long after boot as a confusing userspace
      # error (a dockerd that will not start, a workspace that never mounts),
      # so assert on the final .config rather than discovering it in a guest.
      missing=''
      for opt in \${REQUIRED_KERNEL_OPTIONS}; do
        grep -qx \"\${opt}=y\" .config || missing=\"\${missing} \${opt}\"
      done
      if [ -n \"\${missing}\" ]; then
        echo \"ERROR: required kernel options missing from the built config:\${missing}\" >&2
        exit 1
      fi
      make -j\"\$(nproc)\" vmlinux
      cp vmlinux /work/vmlinux
    "

  install -m 0644 "${WORK_DIR}/vmlinux" "${OUT_DIR}/vmlinux"
  echo "==> Kernel written to ${OUT_DIR}/vmlinux"
else
  echo "==> Skipping kernel build (--skip-kernel)"
  [[ -f "${OUT_DIR}/vmlinux" ]] || { echo "error: no existing ${OUT_DIR}/vmlinux to reuse" >&2; exit 1; }
fi

# ── 2. Guest agent bundle ─────────────────────────────────────────
# Bundled rather than shipped as loose TypeScript so the guest and the host
# share one copy of the protocol codec. Two hand-maintained implementations of
# a binary framing protocol drift, and the drift shows up as corrupted
# terminal output.
if [[ -n "${VM_AGENT_BUNDLE}" ]]; then
  echo "==> Using prebuilt vm-agent bundle ${VM_AGENT_BUNDLE}"
  [[ -f "${VM_AGENT_BUNDLE}" ]] || { echo "error: no bundle at ${VM_AGENT_BUNDLE}" >&2; exit 1; }
  install -m 0644 "${VM_AGENT_BUNDLE}" "${WORK_DIR}/vm-agent.mjs"
else
  echo "==> Bundling vm-agent"
  (
    cd "${REPO_ROOT}/server"
    ./node_modules/.bin/esbuild \
      session-env/firecracker/guest/vm-agent.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --external:node-pty \
      --outfile="${WORK_DIR}/vm-agent.mjs"
  )
fi

# ── 3. Root filesystem ────────────────────────────────────────────
echo "==> Exporting ${RUNNER_IMAGE} into a rootfs"

docker build -t agent-hub/fc-guest:latest \
  --build-arg "RUNNER_IMAGE=${RUNNER_IMAGE}" \
  -f "${SCRIPT_DIR}/Dockerfile.guest" \
  "${SCRIPT_DIR}"

CONTAINER_ID="$(docker create agent-hub/fc-guest:latest /bin/true)"
trap 'docker rm -f "${CONTAINER_ID}" >/dev/null 2>&1 || true; rm -rf "${WORK_DIR}"' EXIT

ROOTFS_IMG="${WORK_DIR}/rootfs.ext4"
truncate -s "${ROOTFS_SIZE_MIB}M" "${ROOTFS_IMG}"
mkfs.ext4 -q -F -L agent-hub-root "${ROOTFS_IMG}"

MOUNT_DIR="${WORK_DIR}/mnt"
mkdir -p "${MOUNT_DIR}"
sudo mount -o loop "${ROOTFS_IMG}" "${MOUNT_DIR}"
# shellcheck disable=SC2064  # expand MOUNT_DIR now, while it is still set
trap "sudo umount '${MOUNT_DIR}' 2>/dev/null || true; docker rm -f '${CONTAINER_ID}' >/dev/null 2>&1 || true; rm -rf '${WORK_DIR}'" EXIT

docker export "${CONTAINER_ID}" | sudo tar -x -C "${MOUNT_DIR}"

# The agent and its units are installed here rather than in the Dockerfile so
# a rebuild after an agent change does not re-export the whole image.
sudo install -D -m 0644 "${WORK_DIR}/vm-agent.mjs" "${MOUNT_DIR}/usr/local/lib/agent-hub/vm-agent.mjs"
# The guest resolver writer runs before anything that needs DNS.
sudo install -D -m 0755 "${SCRIPT_DIR}/../guest/agent-hub-write-resolv.sh" \
  "${MOUNT_DIR}/usr/local/bin/agent-hub-write-resolv"

# Seed a working resolver. This cannot be done in the Dockerfile: docker
# bind-mounts /etc/resolv.conf over the image during build and the export drops
# it, leaving a zero-byte file that silently means "no DNS". The boot-time
# service replaces this with the host's own resolvers when it gets them.
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:2\n' \
  | sudo tee "${MOUNT_DIR}/etc/resolv.conf" >/dev/null
sudo chmod 0644 "${MOUNT_DIR}/etc/resolv.conf"

for unit in agent-hub-vm-agent.service agent-hub-vsock-bridge.service workspace.mount \
            agent-hub-resolv.service; do
  sudo install -D -m 0644 "${SCRIPT_DIR}/../guest/systemd/${unit}" \
    "${MOUNT_DIR}/etc/systemd/system/${unit}"
done

# Enable by symlink: `systemctl enable` needs a booted system, and this image
# is not one yet.
sudo mkdir -p "${MOUNT_DIR}/etc/systemd/system/multi-user.target.wants" \
              "${MOUNT_DIR}/etc/systemd/system/sysinit.target.wants" \
              "${MOUNT_DIR}/etc/systemd/system/local-fs.target.wants" \
              "${MOUNT_DIR}/workspace"
sudo ln -sf ../agent-hub-resolv.service \
  "${MOUNT_DIR}/etc/systemd/system/sysinit.target.wants/agent-hub-resolv.service"
sudo ln -sf ../agent-hub-vm-agent.service \
  "${MOUNT_DIR}/etc/systemd/system/multi-user.target.wants/agent-hub-vm-agent.service"
sudo ln -sf ../agent-hub-vsock-bridge.service \
  "${MOUNT_DIR}/etc/systemd/system/multi-user.target.wants/agent-hub-vsock-bridge.service"
sudo ln -sf ../workspace.mount \
  "${MOUNT_DIR}/etc/systemd/system/local-fs.target.wants/workspace.mount"

sudo sync
sudo umount "${MOUNT_DIR}"

# Shrink to what is actually used: the image ships as a base every VM clones,
# so the difference is multiplied by every concurrent session.
e2fsck -y -f "${ROOTFS_IMG}" >/dev/null 2>&1 || true
resize2fs -M "${ROOTFS_IMG}" >/dev/null 2>&1 || true

install -m 0644 "${ROOTFS_IMG}" "${OUT_DIR}/rootfs.ext4"

echo
echo "==> Guest artifacts ready:"
ls -lh "${OUT_DIR}/vmlinux" "${OUT_DIR}/rootfs.ext4"
