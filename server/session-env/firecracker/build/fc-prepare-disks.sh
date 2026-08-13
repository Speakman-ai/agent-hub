#!/usr/bin/env bash
#
# Per-VM disk preparation, called by FirecrackerSessionEnv at boot.
#
# This is the one privileged operation the microVM backend needs (loop devices
# and mount), so it lives in a single auditable script installed by the host
# setup rather than inside the Hub process. The Hub is granted exactly this
# via a narrow sudoers rule; it never holds CAP_SYS_ADMIN itself.
#
# Output paths are NEVER taken from the caller. The helper constructs
# `$RUN_DIR/<vm-id>/{rootfs,workspace}.ext4` under the root-owned RUN_DIR from
# firecracker-roots.conf, so an unprivileged rename/symlink cannot retarget
# truncate/mkfs between validation and use (Firecracker prod-host-setup /
# jailer observations: parent dirs must not be writable by unprivileged users).
#
# Usage:
#   fc-prepare-disks.sh --vm-id ID --base-rootfs PATH --worktree PATH
#                       [--workspace-size-mib N]
#   fc-prepare-disks.sh clean --vm-id ID

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f /usr/local/lib/agent-hub/fc-path-guard.sh ]]; then
  # shellcheck disable=SC1091
  source /usr/local/lib/agent-hub/fc-path-guard.sh
elif [[ -f "${SCRIPT_DIR}/fc-path-guard.sh" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/fc-path-guard.sh"
fi

CMD="prepare"
BASE_ROOTFS=""
VM_ID=""
WORKSPACE_SIZE_MIB="32768"
WORKTREE=""
WORKSPACE_UID="${AGENT_HUB_WORKSPACE_UID:-1000}"
WORKSPACE_GID="${AGENT_HUB_WORKSPACE_GID:-1000}"

if [[ "${1:-}" == "clean" ]]; then
  CMD="clean"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm-id) VM_ID="$2"; shift 2 ;;
    --base-rootfs) BASE_ROOTFS="$2"; shift 2 ;;
    --workspace-size-mib) WORKSPACE_SIZE_MIB="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    # Legacy output flags are refused — outputs are constructed from --vm-id.
    --rootfs-out|--workspace-out)
      echo "fc-prepare-disks: refusing caller-supplied output path ($1); use --vm-id" >&2
      exit 2
      ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "fc-prepare-disks: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${VM_ID}" || ! "${VM_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "fc-prepare-disks: --vm-id required (alnum/._-, max 64)" >&2
  exit 2
fi

fc_load_roots
# Canonicalize the root-owned run dir; refuse if missing (must be pre-created
# by setup as root:root and not Hub-writable).
if [[ ! -d "${RUN_DIR}" ]]; then
  echo "fc-prepare-disks: RUN_DIR does not exist: ${RUN_DIR}" >&2
  exit 1
fi
RUN_DIR_REAL=$(fc_canonical_root "${RUN_DIR}")
VM_DIR="${RUN_DIR_REAL}/${VM_ID}"

if [[ "${CMD}" == "clean" ]]; then
  # Only remove the leaf under RUN_DIR — never anything else.
  if [[ -e "${VM_DIR}" || -L "${VM_DIR}" ]]; then
    if [[ -L "${VM_DIR}" ]]; then
      echo "fc-prepare-disks: refusing to clean symlink at ${VM_DIR}" >&2
      exit 2
    fi
    rm -rf -- "${VM_DIR}"
  fi
  echo "fc-prepare-disks: cleaned ${VM_DIR}"
  exit 0
fi

for required in BASE_ROOTFS WORKTREE; do
  if [[ -z "${!required}" ]]; then
    echo "fc-prepare-disks: missing required --${required,,}" | tr '_' '-' >&2
    exit 2
  fi
done

fc_assert_under_roots 'base-rootfs' "${BASE_ROOTFS}" ARTIFACT_DIR
fc_assert_worktree_under_roots 'worktree' "${WORKTREE}"
fc_assert_no_symlink_components 'base-rootfs' "${BASE_ROOTFS}"
fc_assert_no_symlink_components 'worktree' "${WORKTREE}"

BASE_ROOTFS=$(fc_canonicalize "${BASE_ROOTFS}")
WORKTREE=$(fc_canonicalize "${WORKTREE}")

[[ -f "${BASE_ROOTFS}" ]] || { echo "fc-prepare-disks: base rootfs not found: ${BASE_ROOTFS}" >&2; exit 1; }
[[ -d "${WORKTREE}" ]] || { echo "fc-prepare-disks: worktree not found: ${WORKTREE}" >&2; exit 1; }

# Create the per-VM directory as root under the fixed RUN_DIR. Never follow a
# pre-existing symlink leaf planted by an unprivileged user.
if [[ -L "${VM_DIR}" ]]; then
  echo "fc-prepare-disks: refusing symlink at ${VM_DIR}" >&2
  exit 2
fi
mkdir -m 0700 -p "${VM_DIR}"

ROOTFS_OUT="${VM_DIR}/rootfs.ext4"
WORKSPACE_OUT="${VM_DIR}/workspace.ext4"
WORKSPACE_READY="${VM_DIR}/workspace.ready"
# Rootfs is the guest OS — always clone a fresh one. The workspace disk is
# the session's only copy of the worktree; destroying it on every boot is
# what rolled Firecracker sessions back to the scaffold on follow-up turns.
rm -f -- "${ROOTFS_OUT}"

# ── rootfs clone ──────────────────────────────────────────────────
cp --reflink=auto -- "${BASE_ROOTFS}" "${ROOTFS_OUT}"

if [[ -f "${WORKSPACE_READY}" && -s "${WORKSPACE_OUT}" && ! -L "${WORKSPACE_OUT}" ]]; then
  echo "fc-prepare-disks: reusing workspace=${WORKSPACE_OUT}"
  echo "fc-prepare-disks: rootfs=${ROOTFS_OUT} workspace=${WORKSPACE_OUT}"
  exit 0
fi

rm -f -- "${WORKSPACE_OUT}" "${WORKSPACE_READY}"

# ── workspace disk ────────────────────────────────────────────────
truncate -s "${WORKSPACE_SIZE_MIB}M" -- "${WORKSPACE_OUT}"
# ext4 volume labels are capped at 16 bytes; longer names only warn and truncate.
mkfs.ext4 -q -F -L ah-workspace "${WORKSPACE_OUT}"

MOUNT_DIR="$(mktemp -d)"
cleanup() {
  umount "${MOUNT_DIR}" 2>/dev/null || true
  rmdir "${MOUNT_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

mount -o loop -- "${WORKSPACE_OUT}" "${MOUNT_DIR}"

# Materialize the worktree as the workspace user — never as root. The session
# `.git` is attacker-controlled (smudge filters / hooks / config); Git must not
# run against it with uid 0. Dropping to WORKSPACE_UID also satisfies
# safe.directory / dubious-ownership when the tar stream lands uid-1000 files
# into a root-mounted image (Docker helper path).
chown "${WORKSPACE_UID}:${WORKSPACE_GID}" "${MOUNT_DIR}"
# Drop to the workspace uid *and* set no_new_privs. The Finalize helper image
# grants uid 1000 (`runner`) passwordless sudo, and the container is launched
# --privileged — without no_new_privs a repo-controlled smudge filter can
# `sudo -n` back to root. setpriv is required (runuser alone cannot set this).
run_as_workspace() {
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "fc-prepare-disks: setpriv required to drop privileges with no_new_privs" >&2
    exit 1
  fi
  setpriv \
    --reuid="${WORKSPACE_UID}" \
    --regid="${WORKSPACE_GID}" \
    --clear-groups \
    --no-new-privs \
    -- "$@"
}

# Archive the worktree through an O_NOFOLLOW directory walk so a symlink swap
# after canonicalize cannot retarget the read to another host path.
export AGENT_HUB_WORKSPACE_SIZE_MIB="${WORKSPACE_SIZE_MIB}"
run_as_workspace python3 - "${WORKTREE}" "${MOUNT_DIR}" <<'PY'
import os
import stat
import subprocess
import sys

worktree, dest = sys.argv[1], sys.argv[2]
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)

def open_nofollow_dir(abs_path: str) -> int:
    if not abs_path.startswith("/"):
        raise SystemExit("worktree must be absolute")
    fd = os.open("/", flags)
    try:
        for part in abs_path.strip("/").split("/"):
            if part in ("", ".", ".."):
                raise SystemExit(f"refusing unclean worktree component: {part!r}")
            nxt = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except OSError as e:
        try:
            os.close(fd)
        except OSError:
            pass
        raise SystemExit(f"worktree open failed (symlink?): {e}") from e

def stream_worktree(src_fd: int, dest_dir: str) -> None:
    # `/proc/self/fd/N` is wrong here: tar is a subprocess, so "self" is tar's
    # fd table (empty for N). Point at *this* process's still-open dir fd.
    src = f"/proc/{os.getpid()}/fd/{src_fd}"
    # Stream producer → extractor. Never buffer the whole archive in RAM —
    # multi-GB worktrees (or sparse bombs) would OOM the host.
    max_bytes = int(os.environ.get("AGENT_HUB_FC_WORKTREE_TAR_MAX_BYTES", "0")) or (
        int(os.environ.get("AGENT_HUB_WORKSPACE_SIZE_MIB", "32768")) * 1024 * 1024 * 2
    )
    produced = 0

    def limited_read(stream, size):
        nonlocal produced
        chunk = stream.read(size)
        if chunk:
            produced += len(chunk)
            if produced > max_bytes:
                raise SystemExit(
                    f"worktree archive exceeded {max_bytes} byte ceiling during copy"
                )
        return chunk

    # Skip generated trees. Survey Tracker (and most Node/Python repos) keep
    # live `node_modules` / venvs in the host worktree — often still being
    # written by a background install. Archiving them (a) takes minutes and
    # stalls "Waiting for first event…", (b) races GNU tar ("file changed as
    # we read it" / "File shrank") and fails the VM boot. The guest installs
    # its own deps; host `node_modules` is a host-filesystem trick with no
    # meaning across the VM boundary.
    tar_create = [
        "tar",
        "-C",
        src,
        "--exclude-vcs-ignores",
        "--exclude=node_modules",
        "--exclude=__pycache__",
        "--exclude=.venv",
        "--exclude=venv",
        "--exclude=.tox",
        "--exclude=.angular",
        "--exclude=.next",
        "--exclude=.nuxt",
        "--exclude=.turbo",
        "--exclude=.parcel-cache",
        "--exclude=coverage",
        "--exclude=.cache",
        "-cf",
        "-",
        ".",
    ]
    prod = subprocess.Popen(
        tar_create,
        stdout=subprocess.PIPE,
        # Keep the dir fd open across exec so /proc/<pid>/fd/N stays valid for
        # the child's open(); close_fds alone is fine because we open by path.
        pass_fds=(src_fd,),
    )
    assert prod.stdout is not None
    cons = subprocess.Popen(
        ["tar", "-C", dest_dir, "-xf", "-"],
        stdin=subprocess.PIPE,
    )
    assert cons.stdin is not None
    try:
        while True:
            chunk = limited_read(prod.stdout, 1024 * 1024)
            if not chunk:
                break
            cons.stdin.write(chunk)
        cons.stdin.close()
        prod_rc = prod.wait()
        cons_rc = cons.wait()
    except Exception:
        prod.kill()
        cons.kill()
        raise
    # GNU tar exits 1 when some files changed during the read. That is
    # expected on a live worktree; exit 2+ is a real archive failure.
    if prod_rc not in (0, 1):
        raise SystemExit(f"tar archive failed with exit {prod_rc}")
    if cons_rc != 0:
        raise SystemExit(f"tar extract failed with exit {cons_rc}")

    # `--exclude-vcs-ignores` omits paths matching .gitignore even when they
    # are tracked (force-added `sample.env`, ignored `.vscode/`, …). The guest
    # then looks like those files were deleted, and the Changes badge fills
    # with false positives against the base branch. Re-materialize every
    # index entry from the copied `.git` so tracked files always land.
    git_dir = os.path.join(dest_dir, ".git")
    if os.path.isdir(git_dir):
        restore = subprocess.run(
            ["git", "-C", dest_dir, "checkout-index", "-a", "-f"],
            capture_output=True,
            text=True,
        )
        if restore.returncode != 0:
            detail = (restore.stderr or restore.stdout or "").strip() or "no output"
            raise SystemExit(
                f"git checkout-index failed (exit {restore.returncode}): {detail}"
            )
        # checkout-index restores the index blob, which clobbers dirty
        # working-tree edits on tracked files. Re-apply dirty paths from the
        # live source. Destination writes must never follow a symlink that
        # checkout-index may have recreated (absolute symlink → host path as
        # root). Walk dest components with O_NOFOLLOW and unlinkat the leaf
        # before writing.
        dirty = subprocess.run(
            ["git", "-C", worktree, "diff", "--name-only", "-z", "HEAD"],
            capture_output=True,
        )
        if dirty.returncode == 0 and dirty.stdout:
            dest_root_fd = os.open(dest_dir, os.O_RDONLY | os.O_DIRECTORY)
            # Source walks must use the same O_NOFOLLOW dirfd discipline as
            # dest. Joining `worktree/rel` then open/stat/lexists follows an
            # intermediate repo-controlled symlink (escape → /etc) and would
            # copy host files into the guest as root.
            src_root_fd = open_nofollow_dir(worktree)
            nofollow = getattr(os, "O_NOFOLLOW", 0)

            def copy_dirty_nofollow(rel_s: str) -> None:
                parts = [p for p in rel_s.split("/") if p not in ("", ".", "..")]
                if not parts or any(p in ("", ".", "..") for p in rel_s.split("/")):
                    raise SystemExit(f"refusing unclean dirty path: {rel_s!r}")

                def walk_src_parent():
                    dir_fd = src_root_fd
                    opened = []
                    try:
                        for part in parts[:-1]:
                            nxt = os.open(
                                part,
                                os.O_RDONLY | os.O_DIRECTORY | nofollow,
                                dir_fd=dir_fd,
                            )
                            opened.append(nxt)
                            dir_fd = nxt
                        return dir_fd, opened
                    except FileNotFoundError:
                        return None, opened
                    except OSError as e:
                        for fd in reversed(opened):
                            os.close(fd)
                        raise SystemExit(
                            f"refusing dirty source path with symlink escape: {rel_s!r} ({e})"
                        ) from e

                src_parent, src_opened = walk_src_parent()
                try:
                    leaf = parts[-1]
                    src_missing = src_parent is None
                    if not src_missing:
                        try:
                            os.lstat(leaf, dir_fd=src_parent)
                        except FileNotFoundError:
                            src_missing = True
                    if src_missing:
                        # Deleted in the live tree — drop the index restore too.
                        dir_fd = dest_root_fd
                        opened = []
                        try:
                            for part in parts[:-1]:
                                nxt = os.open(
                                    part,
                                    os.O_RDONLY | os.O_DIRECTORY | nofollow,
                                    dir_fd=dir_fd,
                                )
                                opened.append(nxt)
                                dir_fd = nxt
                            try:
                                os.unlink(leaf, dir_fd=dir_fd)
                            except FileNotFoundError:
                                pass
                        except FileNotFoundError:
                            pass
                        finally:
                            for fd in reversed(opened):
                                os.close(fd)
                        return

                    try:
                        src_st = os.lstat(leaf, dir_fd=src_parent)
                    except OSError as e:
                        raise SystemExit(
                            f"refusing dirty source lstat failure: {rel_s!r} ({e})"
                        ) from e
                    # Directories are not expected from `git diff --name-only`.
                    if stat.S_ISDIR(src_st.st_mode) and not stat.S_ISLNK(src_st.st_mode):
                        return

                    dir_fd = dest_root_fd
                    opened = []
                    try:
                        for part in parts[:-1]:
                            try:
                                nxt = os.open(
                                    part,
                                    os.O_RDONLY | os.O_DIRECTORY | nofollow,
                                    dir_fd=dir_fd,
                                )
                            except FileNotFoundError:
                                os.mkdir(part, 0o755, dir_fd=dir_fd)
                                nxt = os.open(
                                    part,
                                    os.O_RDONLY | os.O_DIRECTORY | nofollow,
                                    dir_fd=dir_fd,
                                )
                            opened.append(nxt)
                            dir_fd = nxt
                        try:
                            os.unlink(leaf, dir_fd=dir_fd)
                        except FileNotFoundError:
                            pass
                        if stat.S_ISLNK(src_st.st_mode):
                            os.symlink(os.readlink(leaf, dir_fd=src_parent), leaf, dir_fd=dir_fd)
                        else:
                            flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | nofollow
                            out_fd = os.open(leaf, flags, 0o644, dir_fd=dir_fd)
                            try:
                                in_fd = os.open(leaf, os.O_RDONLY | nofollow, dir_fd=src_parent)
                                try:
                                    while True:
                                        chunk = os.read(in_fd, 1024 * 1024)
                                        if not chunk:
                                            break
                                        os.write(out_fd, chunk)
                                finally:
                                    os.close(in_fd)
                            finally:
                                os.close(out_fd)
                            try:
                                os.chmod(leaf, stat.S_IMODE(src_st.st_mode), dir_fd=dir_fd)
                            except OSError:
                                pass
                    finally:
                        for fd in reversed(opened):
                            os.close(fd)
                finally:
                    for fd in reversed(src_opened):
                        os.close(fd)

            try:
                for rel in dirty.stdout.split(b"\0"):
                    if not rel:
                        continue
                    try:
                        rel_s = rel.decode("utf-8")
                    except UnicodeDecodeError:
                        continue
                    copy_dirty_nofollow(rel_s)
            finally:
                os.close(src_root_fd)
                os.close(dest_root_fd)

fd = open_nofollow_dir(worktree)
try:
    stream_worktree(fd, dest)
finally:
    os.close(fd)
PY

chown -R "${WORKSPACE_UID}:${WORKSPACE_GID}" "${MOUNT_DIR}"

sync
cleanup
trap - EXIT

touch -- "${WORKSPACE_READY}"
echo "fc-prepare-disks: rootfs=${ROOTFS_OUT} workspace=${WORKSPACE_OUT}"
