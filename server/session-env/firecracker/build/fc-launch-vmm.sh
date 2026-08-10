#!/usr/bin/env bash
# Narrow root helper: start a Firecracker/jailer VMM and chown its vsock to the Hub.
#
# Invoked as:
#   fc-launch-vmm.sh <vsockPath> <uid:gid> <vmm-argv...>
#
# Authorized via sudoers (local exec) or used as the docker VMM entrypoint.
# Do not replace this with `sudo sh -c` — the Hub user must not get a shell.
set -euo pipefail

sock=${1:?vsock path required}
owner=${2:?owner uid:gid required}
shift 2

"$@" &
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
