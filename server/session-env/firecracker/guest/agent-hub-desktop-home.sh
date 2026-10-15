#!/bin/sh
# Desktop computers keep the workspace user's home on the persistent data disk
# (/workspace, the second drive) because the rootfs is re-cloned every boot.
# First boot seeds the disk from the image's home so baked-in CLIs and
# dotfiles are there; later boots reuse it as-is, so files, downloads and
# app logins survive stop/resume.
set -eu

USER_NAME="${AGENT_HUB_DESKTOP_USER:-runner}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
DATA_HOME=/workspace/home
SEEDED="$DATA_HOME/.agent-hub-seeded"

[ -n "$HOME_DIR" ] || { echo "agent-hub-desktop-home: no home for $USER_NAME" >&2; exit 1; }
mountpoint -q /workspace || { echo "agent-hub-desktop-home: /workspace is not mounted" >&2; exit 1; }

if [ ! -f "$SEEDED" ]; then
  mkdir -p "$DATA_HOME"
  cp -a "$HOME_DIR/." "$DATA_HOME/"
  chown -R "$(id -u "$USER_NAME"):$(id -g "$USER_NAME")" "$DATA_HOME"
  touch "$SEEDED"
fi

mountpoint -q "$HOME_DIR" || mount --bind "$DATA_HOME" "$HOME_DIR"
