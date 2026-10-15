#!/usr/bin/env bash
# Install the agent desktop layer: Xvfb, openbox, a Chromium-family browser,
# xdotool, scrot and a VNC server. Shared by both desktop backends so the two
# computers an agent can land on carry the same tools:
#
#   --target container   server/desktop/image/Dockerfile (Debian bookworm)
#   --target vm          server/session-env/firecracker/build/Dockerfile.guest-desktop
#                        (the Ubuntu 24.04 Firecracker guest, built on the
#                        Finalize runner image)
#
# Whatever the target, `chromium` on PATH opens the browser, so the computer
# tool's exec op and the smoke tests can say `chromium <url>` on either backend.
set -euo pipefail

TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    *) echo "install-desktop: unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$TARGET" in
  container|vm) ;;
  *) echo "install-desktop: --target must be container or vm" >&2; exit 2 ;;
esac

export DEBIAN_FRONTEND=noninteractive

PACKAGES=(
  xvfb openbox xdotool scrot x11-utils x11vnc
  fonts-dejavu-core fonts-liberation xdg-utils
)

# Ubuntu's `chromium` package is a snap shim, and snapd cannot run in a
# container build or a guest without snapd. The VM guest already ships Google
# Chrome from the runner image, so it only gets a `chromium` wrapper.
if command -v google-chrome >/dev/null 2>&1; then
  BROWSER=google-chrome
else
  . /etc/os-release
  if [[ "${ID:-}" == "ubuntu" ]]; then
    echo "install-desktop: no google-chrome on Ubuntu and the chromium package is a snap" >&2
    exit 1
  fi
  BROWSER=chromium
  PACKAGES+=(chromium)
fi

apt-get update
apt-get install -y --no-install-recommends "${PACKAGES[@]}"
rm -rf /var/lib/apt/lists/*

# Chromium's own sandbox needs user namespaces, which Docker's default seccomp
# profile refuses to an unprivileged container, so there the container is the
# sandbox. A microVM has its own kernel and keeps Chromium's sandbox on.
FLAGS="--disable-dev-shm-usage --no-first-run --no-default-browser-check --password-store=basic"
if [[ "$TARGET" == "container" ]]; then
  FLAGS="--no-sandbox ${FLAGS}"
fi

if [[ "$BROWSER" == "chromium" ]]; then
  # Debian's launcher sources every file in /etc/chromium.d.
  printf 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS %s"\n' "$FLAGS" > /etc/chromium.d/agent-hub
else
  # --class keeps the X window class `chromium`, so window lookups by class
  # behave the same on both backends.
  cat > /usr/local/bin/chromium <<EOF
#!/bin/sh
exec google-chrome --class=chromium ${FLAGS} "\$@"
EOF
  chmod 0755 /usr/local/bin/chromium
fi

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

for bin in Xvfb openbox xdotool scrot xdpyinfo x11vnc chromium; do
  command -v "$bin" >/dev/null || { echo "install-desktop: $bin missing after install" >&2; exit 1; }
done
echo "install-desktop: desktop layer installed for $TARGET (browser: $BROWSER)"
