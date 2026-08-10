#!/usr/bin/env bash
#
# Per-VM disk preparation, called by FirecrackerSessionEnv at boot.
#
# This is the one privileged operation the microVM backend needs (loop devices
# and mount), so it lives in a single auditable script installed by the host
# setup rather than inside the Hub process. The Hub is granted exactly this
# via a narrow sudoers rule; it never holds CAP_SYS_ADMIN itself.
#
# Two disks come out:
#
#   rootfs   A copy-on-write clone of the shared base image. `cp --reflink`
#            makes this near-instant and near-free on a CoW filesystem
#            (xfs/btrfs); on ext4 it degrades to a full copy, which is correct
#            but slow — which is why the host setup formats the VM directory
#            as xfs.
#   workspace  A fresh ext4 image seeded with the session worktree. Firecracker
#            has no virtio-fs and no 9p, so a bind mount is not available: the
#            worktree has to be *in* a block device.
#
# Usage:
#   fc-prepare-disks.sh --base-rootfs PATH --rootfs-out PATH
#                       --workspace-out PATH --workspace-size-mib N
#                       --worktree PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f /usr/local/lib/agent-hub/fc-path-guard.sh ]]; then
  # shellcheck disable=SC1091
  source /usr/local/lib/agent-hub/fc-path-guard.sh
elif [[ -f "${SCRIPT_DIR}/fc-path-guard.sh" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/fc-path-guard.sh"
fi

BASE_ROOTFS=""
ROOTFS_OUT=""
WORKSPACE_OUT=""
WORKSPACE_SIZE_MIB="32768"
WORKTREE=""
# Must match the uid the guest's workspace user has, or every file in the
# worktree looks like it belongs to someone else once the VM boots.
WORKSPACE_UID="${AGENT_HUB_WORKSPACE_UID:-1000}"
WORKSPACE_GID="${AGENT_HUB_WORKSPACE_GID:-1000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-rootfs) BASE_ROOTFS="$2"; shift 2 ;;
    --rootfs-out) ROOTFS_OUT="$2"; shift 2 ;;
    --workspace-out) WORKSPACE_OUT="$2"; shift 2 ;;
    --workspace-size-mib) WORKSPACE_SIZE_MIB="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "fc-prepare-disks: unknown argument: $1" >&2; exit 2 ;;
  esac
done

for required in BASE_ROOTFS ROOTFS_OUT WORKSPACE_OUT WORKTREE; do
  if [[ -z "${!required}" ]]; then
    echo "fc-prepare-disks: missing required --${required,,}" | tr '_' '-' >&2
    exit 2
  fi
done

# Refuse agent-controlled paths outside the host's configured Firecracker roots.
# Inputs (base image, worktree) vs outputs (per-VM disks) use different root
# sets so a Hub-writable worktree symlink cannot retarget truncate/mkfs at /dev.
fc_assert_under_roots 'base-rootfs' "${BASE_ROOTFS}" ARTIFACT_DIR RUN_DIR
fc_assert_output_under_roots 'rootfs-out' "${ROOTFS_OUT}"
fc_assert_output_under_roots 'workspace-out' "${WORKSPACE_OUT}"
fc_assert_worktree_under_roots 'worktree' "${WORKTREE}"

[[ -f "${BASE_ROOTFS}" ]] || { echo "fc-prepare-disks: base rootfs not found: ${BASE_ROOTFS}" >&2; exit 1; }
[[ -d "${WORKTREE}" ]] || { echo "fc-prepare-disks: worktree not found: ${WORKTREE}" >&2; exit 1; }

mkdir -p "$(dirname "${ROOTFS_OUT}")" "$(dirname "${WORKSPACE_OUT}")"

# ── rootfs clone ──────────────────────────────────────────────────
# --reflink=auto: share blocks where the filesystem supports it, fall back to
# a real copy where it does not, rather than failing.
cp --reflink=auto "${BASE_ROOTFS}" "${ROOTFS_OUT}"

# ── workspace disk ────────────────────────────────────────────────
truncate -s "${WORKSPACE_SIZE_MIB}M" "${WORKSPACE_OUT}"
mkfs.ext4 -q -F -L agent-hub-workspace "${WORKSPACE_OUT}"

MOUNT_DIR="$(mktemp -d)"
cleanup() {
  umount "${MOUNT_DIR}" 2>/dev/null || true
  rmdir "${MOUNT_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

mount -o loop "${WORKSPACE_OUT}" "${MOUNT_DIR}"

# Copy the worktree in wholesale, including the .git directory: the session
# has to be able to commit, and a worktree without its git metadata is not a
# checkout, it is a pile of files.
tar -C "${WORKTREE}" -cf - . | tar -C "${MOUNT_DIR}" -xf -

chown -R "${WORKSPACE_UID}:${WORKSPACE_GID}" "${MOUNT_DIR}"

sync
cleanup
trap - EXIT

echo "fc-prepare-disks: rootfs=${ROOTFS_OUT} workspace=${WORKSPACE_OUT}"
