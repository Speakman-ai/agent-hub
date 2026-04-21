#!/usr/bin/env bash
# Ensure the Cursor Agent CLI is installed for the current user.
#
# Invoked from the deploy workflows (deploy-dev.yml, deploy-prod-2.yml,
# release-prod.yml) inside the SSM inner script — which runs as the app
# user (typically `agenthub`) via setpriv. Also reused by Terraform
# user_data on fresh provisioning.
#
# Idempotent:
#   - If `$HOME/.local/bin/agent` is already present and reports a version,
#     do nothing.
#   - Otherwise run the official per-user installer
#     (https://cursor.com/install), which drops the binary under
#     $HOME/.local/share/cursor-agent/versions/<ver>/ and symlinks it at
#     $HOME/.local/bin/agent.
#
# The server's `cursorBin` default (server/config.ts) is
# $HOME/.local/bin/agent — intentionally matching the installer's symlink
# so no config.json override is needed on fresh boxes.
#
# Verified against https://cursor.com/docs/cli/installation on 2026-04-21.

set -euo pipefail

AGENT_BIN="${HOME}/.local/bin/agent"

if [ -x "${AGENT_BIN}" ]; then
  if VERSION="$("${AGENT_BIN}" --version 2>/dev/null)"; then
    echo "[ensure-cursor-agent] already installed: ${AGENT_BIN} (${VERSION})"
    exit 0
  fi
  echo "[ensure-cursor-agent] ${AGENT_BIN} exists but is not runnable; reinstalling" >&2
fi

echo "[ensure-cursor-agent] installing cursor-agent CLI from https://cursor.com/install"
curl -fsS https://cursor.com/install | bash

if [ ! -x "${AGENT_BIN}" ]; then
  echo "[ensure-cursor-agent] installer finished but ${AGENT_BIN} is missing" >&2
  exit 1
fi

echo "[ensure-cursor-agent] installed: ${AGENT_BIN} ($("${AGENT_BIN}" --version 2>/dev/null || echo 'unknown'))"
