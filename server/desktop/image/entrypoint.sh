#!/usr/bin/env bash
# Boot the virtual display and window manager, then hand PID 1's child slot to
# the control daemon. If the X server dies, the daemon is killed too so the
# container exits and the host sees it, rather than a daemon whose every
# screenshot fails.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${DESKTOP_WIDTH:=1280}"
: "${DESKTOP_HEIGHT:=800}"
export DISPLAY

if [[ -z "${DESKTOP_CONTROL_TOKEN:-}" ]]; then
  echo "desktop: DESKTOP_CONTROL_TOKEN is required" >&2
  exit 2
fi

display_num="${DISPLAY#:}"
display_num="${display_num%%.*}"
rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}"

Xvfb "$DISPLAY" -screen 0 "${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24" -nolisten tcp -ac &
xvfb_pid=$!

for _ in $(seq 1 100); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "desktop: Xvfb exited during startup" >&2
    exit 1
  fi
  sleep 0.1
done
xdpyinfo >/dev/null 2>&1 || { echo "desktop: Xvfb did not come up on $DISPLAY" >&2; exit 1; }

openbox --sm-disable &

node /opt/agent-hub-desktop/control-daemon.ts &
daemon_pid=$!

# Exit as soon as either the X server or the daemon goes away.
wait -n "$xvfb_pid" "$daemon_pid" || true
kill "$daemon_pid" "$xvfb_pid" 2>/dev/null || true
exit 1
