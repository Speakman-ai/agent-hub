#!/usr/bin/env bash
# Ensure the OpenAI Codex CLI is installed for the current user.
#
# Invoked from the deploy workflows (deploy-dev.yml, deploy-prod-2.yml,
# release-prod.yml) inside the SSM inner script — runs as the app user with
# NVM sourced. Terraform bootstrap paths use root `npm install -g` instead
# (system Node, /usr/local/bin).
#
# Idempotent:
#   - If ~/.local/bin/codex exists and reports a version, do nothing.
#   - Otherwise `npm install -g @openai/codex`, then symlink into ~/.local/bin
#     so server/config.ts pickBin finds `codex` via COMMON_BIN_DIRS even when
#     the PM2-managed Node process inherits a sparse PATH.
#
# Official install docs: https://developers.openai.com/codex/quickstart/

set -euo pipefail

LOCAL_CODEX="${HOME}/.local/bin/codex"

if [ -x "${LOCAL_CODEX}" ]; then
  if VERSION="$("${LOCAL_CODEX}" --version 2>/dev/null)"; then
    echo "[ensure-codex] already installed: ${LOCAL_CODEX} (${VERSION})"
    exit 0
  fi
  echo "[ensure-codex] ${LOCAL_CODEX} exists but is not runnable; reinstalling" >&2
fi

echo "[ensure-codex] npm install -g @openai/codex"
npm install -g @openai/codex

PREFIX="$(npm prefix -g)"
GLOBAL_CODEX="${PREFIX}/bin/codex"
if [ ! -x "${GLOBAL_CODEX}" ]; then
  echo "[ensure-codex] install finished but ${GLOBAL_CODEX} is missing" >&2
  exit 1
fi

mkdir -p "${HOME}/.local/bin"
ln -sf "${GLOBAL_CODEX}" "${LOCAL_CODEX}"

echo "[ensure-codex] installed: ${LOCAL_CODEX} ($("${LOCAL_CODEX}" --version 2>/dev/null || echo 'unknown'))"
