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
#   fc-jail-manage.sh stash-snapshot <jailTree>
#     After the VMM wrote snapshot.vmstate + snapshot.mem into the jail root
#     and is proven stopped, move them and the jail's rootfs copy (the disk
#     state the snapshot's memory refers to) to `$RUN_DIR/<vmId>/snapshot/`,
#     so they survive the jail clean that follows.
#
#   fc-jail-manage.sh restore-snapshot <chrootRoot> <uid> <gid>
#     After `stage`, move the stashed snapshot into the jail root as
#     rootfs.ext4 + restore.vmstate + restore.mem. The stash is consumed: once
#     the guest resumes, its disks diverge from the snapshot. Exit 3 when there
#     is no complete stash.
#
#   fc-jail-manage.sh discard-snapshot <vmId>
#     Remove `$RUN_DIR/<vmId>/snapshot/`.
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

assert_vm_id() {
  if [[ ! "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    echo "fc-jail-manage: invalid vm id: $1" >&2
    exit 2
  fi
}

# `.../firecracker/<vmId>` under JAILER_DIR, never /firecracker itself.
assert_jail_tree() {
  local tree=$1 base leaf parent
  fc_assert_jailer_under_roots 'jail tree' "$tree"
  fc_assert_no_symlink_components 'jail tree' "$tree"
  if [[ "$tree" != */firecracker/* ]]; then
    echo "fc-jail-manage: clean path must contain /firecracker/: $tree" >&2
    exit 2
  fi
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
}

# Per-VM disk dir under the root-owned RUN_DIR (same layout as fc-prepare-disks).
run_vm_dir() {
  assert_vm_id "$1"
  fc_load_roots
  echo "$(fc_canonical_root "${RUN_DIR}")/$1"
}

case "$cmd" in
  clean)
    tree=${1:?jail tree required}
    assert_jail_tree "$tree"
    # File bind-mount leftover from a cross-filesystem stage. Harmless no-op
    # when the workspace was hard-linked (the common same-FS path).
    umount -f "${tree%/}/root/workspace.ext4" 2>/dev/null || true
    rm -rf -- "$tree"
    ;;
  stash-snapshot)
    tree=${1:?jail tree required}
    assert_jail_tree "$tree"
    base=${tree%/}
    vm_id=${base##*/}
    jroot="$base/root"
    vm_dir=$(run_vm_dir "$vm_id")
    for f in rootfs.ext4 snapshot.vmstate snapshot.mem; do
      if [[ ! -f "$jroot/$f" || -L "$jroot/$f" ]]; then
        echo "fc-jail-manage: stash-snapshot: $jroot/$f missing or not a regular file" >&2
        exit 3
      fi
    done
    if [[ ! -d "$vm_dir" || -L "$vm_dir" ]]; then
      echo "fc-jail-manage: stash-snapshot: VM disk dir missing: $vm_dir" >&2
      exit 3
    fi
    tmp="$vm_dir/snapshot.tmp"
    rm -rf -- "$tmp"
    mkdir -m 0700 -- "$tmp"
    mv -f -- "$jroot/rootfs.ext4" "$tmp/rootfs.ext4"
    mv -f -- "$jroot/snapshot.vmstate" "$tmp/vmstate"
    mv -f -- "$jroot/snapshot.mem" "$tmp/mem"
    # Left owned by the jailer uid: the 0700 root-owned VM dir already keeps
    # that uid (and the Hub) out.
    rm -rf -- "$vm_dir/snapshot"
    mv -- "$tmp" "$vm_dir/snapshot"
    ;;
  restore-snapshot)
    root=${1:?chroot root required}
    uid=${2:?uid required}
    gid=${3:?gid required}
    fc_assert_jailer_under_roots 'chroot root' "$root"
    fc_assert_no_symlink_components 'chroot root' "$root"
    if [[ "$root" != */firecracker/*/root ]]; then
      echo "fc-jail-manage: restore-snapshot root must match */firecracker/*/root: $root" >&2
      exit 2
    fi
    if [[ ! "$uid" =~ ^[0-9]+$ || ! "$gid" =~ ^[0-9]+$ ]]; then
      echo "fc-jail-manage: uid/gid must be numeric (got uid=$uid gid=$gid)" >&2
      exit 2
    fi
    if [[ ! -d "$root" || -L "$root" ]]; then
      echo "fc-jail-manage: restore-snapshot: jail root not staged: $root" >&2
      exit 2
    fi
    vm_tree=${root%/root}
    vm_id=${vm_tree##*/}
    assert_vm_id "$vm_id"
    snap="$(run_vm_dir "$vm_id")/snapshot"
    if [[ -L "$snap" ]]; then
      echo "fc-jail-manage: refusing symlink snapshot dir: $snap" >&2
      exit 2
    fi
    for f in rootfs.ext4 vmstate mem; do
      if [[ ! -f "$snap/$f" || -L "$snap/$f" ]]; then
        echo "fc-jail-manage: restore-snapshot: no complete snapshot for $vm_id" >&2
        exit 3
      fi
    done
    rm -f -- "$root/rootfs.ext4" "$root/restore.vmstate" "$root/restore.mem"
    mv -f -- "$snap/rootfs.ext4" "$root/rootfs.ext4"
    mv -f -- "$snap/vmstate" "$root/restore.vmstate"
    mv -f -- "$snap/mem" "$root/restore.mem"
    rm -rf -- "$snap"
    chown "$uid:$gid" "$root/rootfs.ext4" "$root/restore.vmstate" "$root/restore.mem"
    chmod 0660 "$root/rootfs.ext4"
    chmod 0600 "$root/restore.vmstate" "$root/restore.mem"
    ;;
  discard-snapshot)
    vm_id=${1:?vm id required}
    assert_vm_id "$vm_id"
    vm_dir=$(run_vm_dir "$vm_id")
    if [[ -L "$vm_dir" || -L "$vm_dir/snapshot" ]]; then
      echo "fc-jail-manage: refusing symlink under $vm_dir" >&2
      exit 2
    fi
    rm -rf -- "$vm_dir/snapshot" "$vm_dir/snapshot.tmp"
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
