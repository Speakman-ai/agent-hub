#!/usr/bin/env bash
# Ensure the xAI Grok Build CLI is installed for the current user.
#
# Invoked from the deploy workflows (deploy-dev.yml, deploy-prod-2.yml,
# release-prod.yml) inside the SSM inner script — which runs as the app
# user (typically `agenthub`) via setpriv. Also reused by Terraform
# user_data on fresh provisioning.
#
# Idempotent:
#   - If `$HOME/.local/bin/grok` is already present and reports a version,
#     do nothing.
#   - Otherwise run the official per-user installer
#     (https://x.ai/cli/install.sh), which drops the `grok` binary and
#     symlinks it at $HOME/.local/bin/grok.
#
# The server's `grokBin` default (server/config.ts) is
# $HOME/.local/bin/grok — intentionally matching the installer's symlink
# so no config.json override is needed on fresh boxes. Auth is the
# XAI_API_KEY env var (headless) or an interactive `grok login`.
#
# Verified against https://docs.x.ai/build/overview on 2026-06-15.

set -euo pipefail

GROK_BIN="${HOME}/.local/bin/grok"

if [ -x "${GROK_BIN}" ]; then
  if VERSION="$("${GROK_BIN}" --version 2>/dev/null)"; then
    echo "[ensure-grok] already installed: ${GROK_BIN} (${VERSION})"
    exit 0
  fi
  echo "[ensure-grok] ${GROK_BIN} exists but is not runnable; reinstalling" >&2
fi

echo "[ensure-grok] installing Grok Build CLI from https://x.ai/cli/install.sh"
curl -fsS https://x.ai/cli/install.sh | bash

if [ ! -x "${GROK_BIN}" ]; then
  echo "[ensure-grok] installer finished but ${GROK_BIN} is missing" >&2
  exit 1
fi

echo "[ensure-grok] installed: ${GROK_BIN} ($("${GROK_BIN}" --version 2>/dev/null || echo 'unknown'))"
