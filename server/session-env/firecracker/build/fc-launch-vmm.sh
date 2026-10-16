#!/usr/bin/env bash
# Narrow root helper: start Firecracker or jailer and chown its vsock and API
# sockets to the Hub.
#
# Invoked as:
#   fc-launch-vmm.sh <vsockPath> <uid:gid> firecracker <firecracker-args...>
#   fc-launch-vmm.sh <vsockPath> <uid:gid> jailer <jailer-args...>
#
# The mode token selects a hard-coded binary under /usr/bin. Caller argv never
# chooses the executable — that is the isolation boundary this helper exists
# to enforce. Jailer launches must pass `--exec-file /usr/bin/firecracker`.
#
# Authorized via sudoers (local exec) or used as the docker VMM entrypoint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f /usr/local/lib/agent-hub/fc-path-guard.sh ]]; then
  # shellcheck disable=SC1091
  source /usr/local/lib/agent-hub/fc-path-guard.sh
elif [[ -f "${SCRIPT_DIR}/fc-path-guard.sh" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/fc-path-guard.sh"
fi

sock=${1:?vsock path required}
owner=${2:?owner uid:gid required}
mode=${3:?mode required (firecracker|jailer)}
shift 3

fc_assert_under_roots 'vsock path' "$sock"
if [[ ! "$owner" =~ ^[0-9]+:[0-9]+$ ]]; then
  echo "fc-launch-vmm: owner must be uid:gid numeric (got: $owner)" >&2
  exit 2
fi

case "$mode" in
  firecracker)
    bin=/usr/bin/firecracker
    ;;
  jailer)
    bin=/usr/bin/jailer
    # Jailer exec's Firecracker after chroot; pin that path too.
    exec_file=
    prev=
    for arg in "$@"; do
      if [[ "$prev" == --exec-file ]]; then
        exec_file=$arg
      fi
      prev=$arg
    done
    if [[ "$exec_file" != /usr/bin/firecracker ]]; then
      echo "fc-launch-vmm: jailer requires --exec-file /usr/bin/firecracker (got: ${exec_file:-missing})" >&2
      exit 2
    fi
    ;;
  *)
    echo "fc-launch-vmm: refused mode '$mode' (only firecracker|jailer)" >&2
    exit 2
    ;;
esac

# Every absolute path in the remaining argv must sit under configured roots
# (api sock, config, chroot base, jail id paths, log files, …).
fc_assert_argv_paths_under_roots "$@"

"$bin" "$@" &
vmm=$!
# The API socket sits beside the vsock socket in both exec modes (the jail
# root, or the per-VM control dir). The Hub needs it for pause / snapshot /
# snapshot load. A VMM started for a snapshot load creates api.sock first and
# vsock.sock only once the Hub has loaded the snapshot, so hand api.sock over
# as soon as it appears rather than after the vsock.
api_sock="$(dirname -- "$sock")/api.sock"
api_done=0
open_ancestors() {
  # Every ancestor up through JAILER_DIR must be other-executable (setup uses
  # 0711 on the jailer base) so uid/gid `owner` can traverse without the tree
  # being Hub-writable.
  fc_load_roots
  local dir
  dir=$(dirname -- "$1")
  while [[ -n "$dir" && "$dir" != / ]]; do
    chmod a+x -- "$dir" 2>/dev/null || true
    cdir=$(fc_canonical_root "$dir" 2>/dev/null || echo "$dir")
    cjail=$(fc_canonical_root "${JAILER_DIR}" 2>/dev/null || echo "${JAILER_DIR}")
    if [[ "$cdir" == "$cjail" ]]; then
      break
    fi
    parent=$(dirname -- "$dir")
    [[ "$parent" == "$dir" ]] && break
    dir=$parent
  done
}
i=0
while [ "$i" -lt 600 ]; do
  if [ "$api_done" = 0 ] && [ -S "$api_sock" ] && [ ! -L "$api_sock" ]; then
    open_ancestors "$api_sock"
    chown "$owner" "$api_sock"
    api_done=1
  fi
  if [ -S "$sock" ]; then
    open_ancestors "$sock"
    chown "$owner" "$sock"
    if [ "$api_done" = 0 ] && [ -S "$api_sock" ] && [ ! -L "$api_sock" ]; then
      chown "$owner" "$api_sock"
    fi
    break
  fi
  i=$((i + 1))
  sleep 0.1
done
wait "$vmm"
