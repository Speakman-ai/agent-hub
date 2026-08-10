#!/usr/bin/env bash
# Narrow root helper for jailer chroot lifecycle.
#
#   fc-jail-manage.sh clean <jailTree>
#     Remove `<chrootBase>/firecracker/<vmId>` after the VMM is proven stopped.
#
#   fc-jail-manage.sh stage <chrootRoot> <kernel> <rootfs> <workspace>
#     Create the jail root and hardlink (or copy) kernel/disk images into it.
#
# Authorized via sudoers — do not expand this into a general shell.
set -euo pipefail

cmd=${1:?command required}
shift

case "$cmd" in
  clean)
    tree=${1:?jail tree required}
    # Refuse path traversal / unexpected shapes.
    case "$tree" in
      *..*|*"\n"*|*""*)
        echo "fc-jail-manage: refused unclean path: $tree" >&2
        exit 2
        ;;
    esac
    if [[ "$tree" != */firecracker/* ]]; then
      echo "fc-jail-manage: clean path must contain /firecracker/: $tree" >&2
      exit 2
    fi
    rm -rf -- "$tree"
    ;;
  stage)
    root=${1:?chroot root required}
    kernel=${2:?kernel required}
    rootfs=${3:?rootfs required}
    workspace=${4:?workspace required}
    case "$root" in
      *..*|*"\n"*|*" "*)
        echo "fc-jail-manage: refused unclean path: $root" >&2
        exit 2
        ;;
    esac
    if [[ "$root" != */firecracker/*/root ]]; then
      echo "fc-jail-manage: stage root must match */firecracker/*/root: $root" >&2
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
    ;;
  *)
    echo "fc-jail-manage: unknown command: $cmd" >&2
    exit 2
    ;;
esac
