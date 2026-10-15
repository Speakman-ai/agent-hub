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
#   rootfs-desktop.ext4
#                — the same guest plus the agent desktop layer (Xvfb on :99,
#                  openbox, Chromium, xdotool, scrot, x11vnc on 5900), booted
#                  by desktop computers. The layer is installed by
#                  server/desktop/image/install-desktop.sh, the script the
#                  container desktop image runs too.
#
# Both are content-addressed by a build id so a host can hold several versions
# and roll back without a rebuild.
#
# Usage:
#   build-guest-artifacts.sh [--out DIR] [--kernel-version 6.1.130]
#                            [--runner-image IMAGE] [--skip-kernel]
#                            [--vm-agent-bundle PATH]
#                            [--variant session|desktop|all]
#                            [--desktop-installer PATH]
#
# Runs on any Linux host with docker. The kernel compile is the slow part
# (~10 min on 4 vCPU); --skip-kernel reuses an existing vmlinux while
# iterating on the rootfs.
#
# By default the agent is bundled here, which needs the repo's server/
# node_modules. Deployment hosts do not have a checkout, so --vm-agent-bundle
# takes an already-bundled vm-agent.mjs instead and the builder only needs
# this directory, ../guest, docker, and (for the desktop variant)
# install-desktop.sh, which --desktop-installer points at when it is not in
# its repo location.
#
# --variant picks which rootfs to build (default: all). Both come from the
# same guest image build, so rebuilding them together keeps them in step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

OUT_DIR="/var/lib/agent-hub/firecracker"
KERNEL_VERSION="6.1.130"
RUNNER_IMAGE="agent-hub/finalize-runner:ubuntu-24.04"
SKIP_KERNEL=0
VM_AGENT_BUNDLE=""
VARIANT="all"
DESKTOP_INSTALLER="${REPO_ROOT}/server/desktop/image/install-desktop.sh"
# Started at boot in the desktop rootfs only.
DESKTOP_UNITS=(agent-hub-desktop-display.service agent-hub-desktop-wm.service
               agent-hub-desktop-vnc.service)
# Sized for a full node_modules plus a build cache; the image is sparse, so
# this costs only what is written.
ROOTFS_SIZE_MIB="${ROOTFS_SIZE_MIB:-12288}"
# Asserted after assembly. The runner-derived image is itself ~3.5GiB, so the
# built size alone says nothing about how much room a session actually gets.
MIN_FREE_MIB="${MIN_FREE_MIB:-6144}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --kernel-version) KERNEL_VERSION="$2"; shift 2 ;;
    --runner-image) RUNNER_IMAGE="$2"; shift 2 ;;
    --skip-kernel) SKIP_KERNEL=1; shift ;;
    --vm-agent-bundle) VM_AGENT_BUNDLE="$2"; shift 2 ;;
    --variant) VARIANT="$2"; shift 2 ;;
    --desktop-installer) DESKTOP_INSTALLER="$2"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "${VARIANT}" in
  session) BUILD_SESSION=1; BUILD_DESKTOP=0 ;;
  desktop) BUILD_SESSION=0; BUILD_DESKTOP=1 ;;
  all)     BUILD_SESSION=1; BUILD_DESKTOP=1 ;;
  *) echo "error: --variant must be session, desktop or all (got ${VARIANT})" >&2; exit 2 ;;
esac
if [[ "${BUILD_DESKTOP}" -eq 1 && ! -f "${DESKTOP_INSTALLER}" ]]; then
  echo "error: desktop installer not found at ${DESKTOP_INSTALLER} (pass --desktop-installer)" >&2
  exit 1
fi

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

# ── 3. Root filesystems ───────────────────────────────────────────
echo "==> Building the guest image from ${RUNNER_IMAGE}"

docker build -t agent-hub/fc-guest:latest \
  --build-arg "RUNNER_IMAGE=${RUNNER_IMAGE}" \
  -f "${SCRIPT_DIR}/Dockerfile.guest" \
  "${SCRIPT_DIR}"

if [[ "${BUILD_DESKTOP}" -eq 1 ]]; then
  echo "==> Building the desktop guest image"
  # A two-file context: the deployment-host builder may not have the rest of
  # the repo, and the desktop layer needs nothing else.
  DESKTOP_CTX="${WORK_DIR}/desktop-context"
  mkdir -p "${DESKTOP_CTX}"
  install -m 0755 "${DESKTOP_INSTALLER}" "${DESKTOP_CTX}/install-desktop.sh"
  install -m 0644 "${SCRIPT_DIR}/Dockerfile.guest-desktop" "${DESKTOP_CTX}/Dockerfile"
  docker build -t agent-hub/fc-guest-desktop:latest \
    --build-arg "BASE_IMAGE=agent-hub/fc-guest:latest" \
    "${DESKTOP_CTX}"
fi

GUEST_DIR="${SCRIPT_DIR}/../guest"
CONTAINER_ID=""
MOUNT_DIR=""
cleanup() {
  if [[ -n "${MOUNT_DIR}" ]]; then sudo umount "${MOUNT_DIR}" 2>/dev/null || true; fi
  if [[ -n "${CONTAINER_ID}" ]]; then docker rm -f "${CONTAINER_ID}" >/dev/null 2>&1 || true; fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

enable_unit() {
  # Enable by symlink: `systemctl enable` needs a booted system, and this
  # image is not one yet.
  local unit="$1" target="$2"
  sudo mkdir -p "${MOUNT_DIR}/etc/systemd/system/${target}.wants"
  sudo ln -sf "../${unit}" "${MOUNT_DIR}/etc/systemd/system/${target}.wants/${unit}"
}

# assemble_rootfs IMAGE OUTPUT_NAME VARIANT
#   Export IMAGE into a fresh ext4 filesystem, install the guest agent and
#   units, and write it to ${OUT_DIR}/OUTPUT_NAME. VARIANT is `session` or
#   `desktop`; the desktop variant also gets the display, window manager and
#   VNC units.
assemble_rootfs() {
  local image="$1" out_name="$2" variant="$3"
  echo "==> Assembling ${out_name} from ${image}"

  CONTAINER_ID="$(docker create "${image}" /bin/true)"

  local rootfs_img="${WORK_DIR}/${out_name}"
  truncate -s "${ROOTFS_SIZE_MIB}M" "${rootfs_img}"
  mkfs.ext4 -q -F -L agent-hub-root "${rootfs_img}"

  MOUNT_DIR="${WORK_DIR}/mnt"
  mkdir -p "${MOUNT_DIR}"
  sudo mount -o loop "${rootfs_img}" "${MOUNT_DIR}"

  docker export "${CONTAINER_ID}" | sudo tar -x -C "${MOUNT_DIR}"
  docker rm -f "${CONTAINER_ID}" >/dev/null 2>&1 || true
  CONTAINER_ID=""

  # The agent and its units are installed here rather than in the Dockerfile so
  # a rebuild after an agent change does not re-export the whole image.
  sudo install -D -m 0644 "${WORK_DIR}/vm-agent.mjs" "${MOUNT_DIR}/usr/local/lib/agent-hub/vm-agent.mjs"
  # The guest resolver writer runs before anything that needs DNS.
  sudo install -D -m 0755 "${GUEST_DIR}/agent-hub-write-resolv.sh" \
    "${MOUNT_DIR}/usr/local/bin/agent-hub-write-resolv"
  # Desktop computers bind the workspace user's home onto the persistent disk.
  sudo install -D -m 0755 "${GUEST_DIR}/agent-hub-desktop-home.sh" \
    "${MOUNT_DIR}/usr/local/bin/agent-hub-desktop-home"

  # Seed a working resolver. This cannot be done in the Dockerfile: docker
  # bind-mounts /etc/resolv.conf over the image during build and the export drops
  # it, leaving a zero-byte file that silently means "no DNS". The boot-time
  # service replaces this with the host's own resolvers when it gets them.
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:2\n' \
    | sudo tee "${MOUNT_DIR}/etc/resolv.conf" >/dev/null
  sudo chmod 0644 "${MOUNT_DIR}/etc/resolv.conf"

  local units=(agent-hub-vm-agent.service agent-hub-vsock-bridge.service workspace.mount
               agent-hub-resolv.service agent-hub-desktop-home.service)
  if [[ "${variant}" == "desktop" ]]; then
    units+=("${DESKTOP_UNITS[@]}")
  fi
  for unit in "${units[@]}"; do
    sudo install -D -m 0644 "${GUEST_DIR}/systemd/${unit}" \
      "${MOUNT_DIR}/etc/systemd/system/${unit}"
  done

  sudo mkdir -p "${MOUNT_DIR}/workspace"
  enable_unit agent-hub-resolv.service sysinit.target
  enable_unit agent-hub-vm-agent.service multi-user.target
  enable_unit agent-hub-vsock-bridge.service multi-user.target
  enable_unit workspace.mount local-fs.target
  enable_unit agent-hub-desktop-home.service multi-user.target
  if [[ "${variant}" == "desktop" ]]; then
    for unit in "${DESKTOP_UNITS[@]}"; do
      enable_unit "${unit}" multi-user.target
    done
  fi

  sudo sync
  sudo umount "${MOUNT_DIR}"
  MOUNT_DIR=""

  e2fsck -y -f "${rootfs_img}" >/dev/null 2>&1 || true

  # This image used to be shrunk to its minimum size (`resize2fs -M`) on the
  # theory that a base every VM clones multiplies any slack per session. It does
  # not: the clone is `cp --reflink=auto` onto a reflink filesystem (xfs/btrfs —
  # setup-firecracker-host.sh warns when it is missing), so clones share blocks
  # and cost only what they subsequently write, and the image is sparse besides.
  # What the shrink actually multiplied was a guest with ~0 bytes free, where the
  # first `npm ci` filled the root filesystem and hung with no error — the
  # process just stopped making progress. Leave the filesystem at its built size.
  local free_mib
  free_mib=$(( $(dumpe2fs -h "${rootfs_img}" 2>/dev/null | awk '/Free blocks:/ {print $3}') \
    * $(dumpe2fs -h "${rootfs_img}" 2>/dev/null | awk '/Block size:/ {print $3}') / 1048576 ))
  if [[ "${free_mib}" -lt "${MIN_FREE_MIB}" ]]; then
    echo "error: ${out_name} has only ${free_mib}MiB free, need >= ${MIN_FREE_MIB}MiB." >&2
    echo "       A dev environment installs npm/pip packages and pulls container" >&2
    echo "       images into this filesystem; too little room hangs the first build." >&2
    echo "       Raise ROOTFS_SIZE_MIB (currently ${ROOTFS_SIZE_MIB})." >&2
    exit 1
  fi
  echo "==> ${out_name} has ${free_mib}MiB free"

  install -m 0644 "${rootfs_img}" "${OUT_DIR}/${out_name}"
  rm -f "${rootfs_img}"
}

BUILT=("${OUT_DIR}/vmlinux")
if [[ "${BUILD_SESSION}" -eq 1 ]]; then
  assemble_rootfs agent-hub/fc-guest:latest rootfs.ext4 session
  BUILT+=("${OUT_DIR}/rootfs.ext4")
fi
if [[ "${BUILD_DESKTOP}" -eq 1 ]]; then
  assemble_rootfs agent-hub/fc-guest-desktop:latest rootfs-desktop.ext4 desktop
  BUILT+=("${OUT_DIR}/rootfs-desktop.ext4")
fi

echo
echo "==> Guest artifacts ready:"
ls -lh "${BUILT[@]}"
