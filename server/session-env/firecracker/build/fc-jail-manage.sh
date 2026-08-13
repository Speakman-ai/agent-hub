#!/usr/bin/env bash
# Narrow root helper for jailer chroot lifecycle.
#
#   fc-jail-manage.sh clean <jailTree>
#     Remove `<chrootBase>/firecracker/<vmId>` after the VMM is proven stopped.
#
#   fc-jail-manage.sh stage <chrootRoot> <kernel> <rootfs> <workspace> <uid> <gid> <configSrc>
#     Create the jail root, copy/reflink kernel+disks, install vm-config.json,
#     and assign ownership/modes so the jailer UID can read/write RW disks.
#     See firecracker jailer.md Observations.
#
# Destination paths must sit under the root-owned JAILER_DIR. Sources are
# constrained by class (artifact / run / control) — never under Hub-writable
# worktree roots — and symlink components are refused before any root write.
#
# Kernel and rootfs are copied (prefers reflink) — never hard-linked.
# Hard-linking the shared kernel then `chown -R` would retarget the
# ARTIFACT_DIR/vmlinux inode to the jailer uid.
# Workspace is hard-linked (bind-mount fallback) so guest writes land on the
# persistent RUN_DIR image and survive jail clean / VMM restart.
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
    fc_assert_jailer_under_roots 'jail tree' "$tree"
    fc_assert_no_symlink_components 'jail tree' "$tree"
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
    if [[ -L "$tree" ]]; then
      echo "fc-jail-manage: refusing to clean symlink at $tree" >&2
      exit 2
    fi
    # File bind-mount leftover from a cross-filesystem stage. Harmless no-op
    # when the workspace was hard-linked (the common same-FS path).
    umount -f "${tree%/}/root/workspace.ext4" 2>/dev/null || true
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
    # Exact root classes — destinations never under WORKTREE_ROOTS.
    fc_assert_jailer_under_roots 'chroot root' "$root"
    fc_assert_under_roots 'kernel' "$kernel" ARTIFACT_DIR
    fc_assert_under_roots 'rootfs' "$rootfs" RUN_DIR
    fc_assert_under_roots 'workspace' "$workspace" RUN_DIR
    fc_assert_control_under_roots 'config source' "$config_src"
    fc_assert_no_symlink_components 'chroot root' "$root"
    fc_assert_no_symlink_components 'kernel' "$kernel"
    fc_assert_no_symlink_components 'rootfs' "$rootfs"
    fc_assert_no_symlink_components 'workspace' "$workspace"
    fc_assert_no_symlink_components 'config source' "$config_src"
    if [[ ! "$uid" =~ ^[0-9]+$ || ! "$gid" =~ ^[0-9]+$ ]]; then
      echo "fc-jail-manage: uid/gid must be numeric (got uid=$uid gid=$gid)" >&2
      exit 2
    fi
    if [[ "$root" != */firecracker/*/root ]]; then
      echo "fc-jail-manage: stage root must match */firecracker/*/root: $root" >&2
      exit 2
    fi
    if [[ -L "$root" ]]; then
      echo "fc-jail-manage: refusing symlink chroot root: $root" >&2
      exit 2
    fi
    if [[ ! -f "$kernel" || ! -f "$rootfs" || ! -f "$workspace" || ! -f "$config_src" ]]; then
      echo "fc-jail-manage: stage source missing (kernel/rootfs/workspace/config)" >&2
      exit 2
    fi
    mkdir -p -- "$root"
    # Independent destination inode — never hard-link shared/trusted inputs.
    stage_one() {
      local src=$1 dest=$2
      rm -f -- "$dest"
      if cp --reflink=auto -f -- "$src" "$dest" 2>/dev/null; then
        return 0
      fi
      cp -f -- "$src" "$dest"
    }
    # Same inode as RUN_DIR so guest writes survive jail clean. Kernel/rootfs
    # stay copies: chown must not retarget ARTIFACT_DIR.
    attach_workspace() {
      local src=$1 dest=$2
      umount -f "$dest" 2>/dev/null || true
      rm -f -- "$dest"
      if ln "$src" "$dest" 2>/dev/null; then
        return 0
      fi
      touch -- "$dest"
      if mount --bind "$src" "$dest"; then
        return 0
      fi
      rm -f -- "$dest"
      echo "fc-jail-manage: failed to attach persistent workspace (ln and bind-mount both failed)" >&2
      exit 1
    }
    stage_one "$kernel" "$root/vmlinux"
    stage_one "$rootfs" "$root/rootfs.ext4"
    attach_workspace "$workspace" "$root/workspace.ext4"
    # Config is written by this helper (not the unprivileged Hub) so the
    # chroot can stay owned by the jailer UID without an EACCES on create.
    cp -f -- "$config_src" "$root/vm-config.json"

    # Least-privilege ownership for the jailer/Firecracker UID. Kernel is
    # read-only; both ext4 images are RW in the VM config and must be
    # writable by that UID (jailer.md Observations). Kernel/rootfs copies
    # are chowned independently of ARTIFACT_DIR. The workspace hardlink *is*
    # the RUN_DIR inode, so that session-private image becomes jailer-owned
    # too — required for Firecracker to write guest blocks.
    chown -R "$uid:$gid" "$root"
    chmod 0755 "$root"
    chmod 0444 "$root/vmlinux"
    chmod 0660 "$root/rootfs.ext4" "$root/workspace.ext4"
    chmod 0644 "$root/vm-config.json"
    # Hub must traverse JAILER_DIR → … → root to dial vsock (setup uses 0711
    # on the jailer base; keep intermediate dirs other-executable too).
    vm_tree=$(dirname -- "$root")
    fc_tree=$(dirname -- "$vm_tree")
    chmod 0755 "$vm_tree" "$fc_tree" 2>/dev/null || true
    chmod o+x "$vm_tree" "$fc_tree" 2>/dev/null || true
    ;;
  *)
    echo "fc-jail-manage: unknown command: $cmd" >&2
    exit 2
    ;;
esac
