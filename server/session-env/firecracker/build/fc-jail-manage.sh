#!/usr/bin/env bash
# Narrow root helper for jailer chroot lifecycle.
#
#   fc-jail-manage.sh clean <jailTree>
#     Remove `<chrootBase>/firecracker/<vmId>` after the VMM is proven stopped.
#
#   fc-jail-manage.sh stage <chrootRoot> <kernel> <rootfs> <workspace> <uid> <gid> <configSrc>
#     Create the jail root, hardlink/copy kernel+disks, install vm-config.json,
#     and assign ownership/modes so the jailer UID can read/write RW disks.
#     See firecracker jailer.md Observations.
#
# Authorized via sudoers — do not expand this into a general shell.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f /usr/local/lib/agent-hub/fc-path-guard.sh ]]; then
  # shellcheck disable=SC1091
  source /usr/local/lib/agent-hub/fc-path-guard.sh
elif [[ -f "${SCRIPT_DIR}/fc-path-guard.sh" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/fc-path-guard.sh"
fi

cmd=${1:?command required}
shift

case "$cmd" in
  clean)
    tree=${1:?jail tree required}
    fc_assert_under_roots 'jail tree' "$tree"
    if [[ "$tree" != */firecracker/* ]]; then
      echo "fc-jail-manage: clean path must contain /firecracker/: $tree" >&2
      exit 2
    fi
    # Refuse cleaning anything that is not a leaf under .../firecracker/<id>
    # (never /firecracker itself or host root).
    base=${tree%/}
    leaf=${base##*/}
    parent=${base%/*}
    if [[ -z "$leaf" || "$leaf" == firecracker || "$parent" != */firecracker ]]; then
      echo "fc-jail-manage: clean path must be .../firecracker/<vmId>: $tree" >&2
      exit 2
    fi
    rm -rf -- "$tree"
    ;;
  stage)
    root=${1:?chroot root required}
    kernel=${2:?kernel required}
    rootfs=${3:?rootfs required}
    workspace=${4:?workspace required}
    uid=${5:?uid required}
    gid=${6:?gid required}
    config_src=${7:?config source required}
    fc_assert_under_roots 'chroot root' "$root"
    fc_assert_under_roots 'kernel' "$kernel"
    fc_assert_under_roots 'rootfs' "$rootfs"
    fc_assert_under_roots 'workspace' "$workspace"
    fc_assert_under_roots 'config source' "$config_src"
    if [[ ! "$uid" =~ ^[0-9]+$ || ! "$gid" =~ ^[0-9]+$ ]]; then
      echo "fc-jail-manage: uid/gid must be numeric (got uid=$uid gid=$gid)" >&2
      exit 2
    fi
    if [[ "$root" != */firecracker/*/root ]]; then
      echo "fc-jail-manage: stage root must match */firecracker/*/root: $root" >&2
      exit 2
    fi
    if [[ ! -f "$kernel" || ! -f "$rootfs" || ! -f "$workspace" || ! -f "$config_src" ]]; then
      echo "fc-jail-manage: stage source missing (kernel/rootfs/workspace/config)" >&2
      exit 2
    fi
    mkdir -p -- "$root"
    stage_one() {
      local src=$1 dest=$2
      rm -f -- "$dest"
      if ln -- "$src" "$dest" 2>/dev/null; then
        return 0
      fi
      cp -f -- "$src" "$dest"
    }
    stage_one "$kernel" "$root/vmlinux"
    stage_one "$rootfs" "$root/rootfs.ext4"
    stage_one "$workspace" "$root/workspace.ext4"
    # Config is written by this helper (not the unprivileged Hub) so the
    # chroot can stay owned by the jailer UID without an EACCES on create.
    cp -f -- "$config_src" "$root/vm-config.json"

    # Least-privilege ownership for the jailer/Firecracker UID. Kernel is
    # read-only; both ext4 images are RW in the VM config and must be
    # writable by that UID (jailer.md Observations).
    chown -R "$uid:$gid" "$root"
    chmod 0755 "$root"
    chmod 0444 "$root/vmlinux"
    chmod 0660 "$root/rootfs.ext4" "$root/workspace.ext4"
    chmod 0644 "$root/vm-config.json"
    ;;
  *)
    echo "fc-jail-manage: unknown command: $cmd" >&2
    exit 2
    ;;
esac
