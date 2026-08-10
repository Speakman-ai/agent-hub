#!/usr/bin/env bash
# Narrow root helper: start Firecracker or jailer and chown the vsock to the Hub.
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

sock=${1:?vsock path required}
owner=${2:?owner uid:gid required}
mode=${3:?mode required (firecracker|jailer)}
shift 3

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

"$bin" "$@" &
vmm=$!
i=0
while [ "$i" -lt 200 ]; do
  if [ -S "$sock" ]; then
    chown "$owner" "$sock"
    break
  fi
  i=$((i + 1))
  sleep 0.1
done
wait "$vmm"
