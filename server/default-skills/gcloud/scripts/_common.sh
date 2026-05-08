#!/usr/bin/env bash
# scripts/_common.sh — shared helpers for gcloud skill scripts.
# Source, don't exec:
#
#     DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "${DIR}/_common.sh"
#
# Exposes:
#   resolve_config      → prints resolved gcloud configuration name
#   resolve_project     → prints resolved GCP project ID
#   resolve_account     → prints resolved active account
#   gcloud_cmd [ARGS…]  → gcloud wrapper with --configuration/--project injected
#   mask_secrets TEXT   → redacts OAuth tokens, SA JSON keys, refresh tokens
#   gcloud_die MESSAGE  → print to stderr + exit 1
#   require_gcloud      → asserts gcloud SDK is available or exits 2
#   RESOLVED_CONFIG     → set after first call to resolve_config
#   RESOLVED_PROJECT    → set after first call to resolve_project
#   RESOLVED_ACCOUNT    → set after first call to resolve_account

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration resolution
# Priority: --config flag (caller sets GCLOUD_CLI_CONFIG) →
#           CLOUDSDK_ACTIVE_CONFIG_NAME → active config from gcloud → "default"
# ---------------------------------------------------------------------------
resolve_config() {
  if [[ -n "${GCLOUD_CLI_CONFIG:-}" ]]; then
    echo "${GCLOUD_CLI_CONFIG}"
    return
  fi
  if [[ -n "${CLOUDSDK_ACTIVE_CONFIG_NAME:-}" ]]; then
    echo "${CLOUDSDK_ACTIVE_CONFIG_NAME}"
    return
  fi

  # Try reading from gcloud's active configuration
  local active_config
  active_config="$(gcloud config configurations list \
    --filter="is_active=true" \
    --format="value(name)" 2>/dev/null | head -1 || true)"
  if [[ -n "${active_config}" ]]; then
    echo "${active_config}"
    return
  fi

  echo "default"
}

# ---------------------------------------------------------------------------
# Project resolution
# Priority: --project flag (caller sets GCLOUD_CLI_PROJECT) →
#           CLOUDSDK_CORE_PROJECT → config's core/project property
# ---------------------------------------------------------------------------
resolve_project() {
  if [[ -n "${GCLOUD_CLI_PROJECT:-}" ]]; then
    echo "${GCLOUD_CLI_PROJECT}"
    return
  fi
  if [[ -n "${CLOUDSDK_CORE_PROJECT:-}" ]]; then
    echo "${CLOUDSDK_CORE_PROJECT}"
    return
  fi

  # Read from the active/resolved configuration
  local cfg
  cfg="${RESOLVED_CONFIG:-$(resolve_config)}"
  local proj
  proj="$(gcloud config configurations describe "${cfg}" \
    --format="value(properties.core.project)" 2>/dev/null || true)"
  if [[ -n "${proj}" ]]; then
    echo "${proj}"
    return
  fi

  # Final fallback: global gcloud config get-value
  local global_proj
  global_proj="$(gcloud config get-value core/project 2>/dev/null || true)"
  if [[ -n "${global_proj}" ]]; then
    echo "${global_proj}"
    return
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# Account resolution
# ---------------------------------------------------------------------------
resolve_account() {
  local cfg
  cfg="${RESOLVED_CONFIG:-$(resolve_config)}"
  local acct
  acct="$(gcloud config configurations describe "${cfg}" \
    --format="value(properties.core.account)" 2>/dev/null || true)"
  if [[ -n "${acct}" ]]; then
    echo "${acct}"
    return
  fi

  # Fallback: active account from auth list
  local active_acct
  active_acct="$(gcloud auth list --filter="status=ACTIVE" \
    --format="value(account)" 2>/dev/null | head -1 || true)"
  echo "${active_acct}"
}

# Export resolved values (populated on first source)
RESOLVED_CONFIG="$(resolve_config)"
RESOLVED_PROJECT="$(resolve_project)"
RESOLVED_ACCOUNT="$(resolve_account)"

# ---------------------------------------------------------------------------
# gcloud wrapper — injects --configuration and --project
# ---------------------------------------------------------------------------
gcloud_cmd() {
  local args=("$@")
  # Inject --configuration if we have one
  if [[ -n "${RESOLVED_CONFIG}" && "${RESOLVED_CONFIG}" != "default" ]]; then
    args=("--configuration=${RESOLVED_CONFIG}" "${args[@]}")
  fi
  # Inject --project if we have one
  if [[ -n "${RESOLVED_PROJECT}" ]]; then
    args=("--project=${RESOLVED_PROJECT}" "${args[@]}")
  fi
  gcloud "${args[@]}"
}

# ---------------------------------------------------------------------------
# Secret masking
# Redacts:
#   - OAuth access tokens:   ya29.[A-Za-z0-9_-]{20,}
#   - OAuth refresh tokens:  value after "refresh_token": "..."
#   - SA private keys:       -----BEGIN ... PRIVATE KEY-----...
#   - client_secret values
#   - access_token values
# ---------------------------------------------------------------------------
mask_secrets() {
  local input="$1"

  # Mask OAuth access tokens (ya29.xxx — may contain dots, slashes, plus signs)
  # GCP tokens look like: ya29.A0ARrd..., ya29.c.c0..., ya29.a.xxx etc.
  # Character class covers alphanumerics, dots, underscores, dashes, slashes, plus signs.
  input="$(echo "${input}" | sed -E 's/ya29\.[A-Za-z0-9._/+=-]{10,}/[REDACTED_ACCESS_TOKEN]/g')"

  # Mask refresh_token values (JSON string)
  input="$(echo "${input}" | sed -E 's|("refresh_token"[[:space:]]*:[[:space:]]*")[^"]*"|\1[REDACTED_REFRESH_TOKEN]"|g')"

  # Mask access_token values (JSON string)
  input="$(echo "${input}" | sed -E 's|("access_token"[[:space:]]*:[[:space:]]*")[^"]*"|\1[REDACTED_ACCESS_TOKEN]"|g')"

  # Mask client_secret values (JSON string)
  input="$(echo "${input}" | sed -E 's|("client_secret"[[:space:]]*:[[:space:]]*")[^"]*"|\1[REDACTED_CLIENT_SECRET]"|g')"

  # Mask private_key values (multi-line PEM blobs rendered as JSON string escape)
  # Matches the opening "-----BEGIN ... PRIVATE KEY-----" pattern inside JSON
  input="$(echo "${input}" | sed -E 's|("private_key"[[:space:]]*:[[:space:]]*")[^"]*"|\1[REDACTED_PRIVATE_KEY]"|g')"

  # Mask raw PEM blocks (for cases where JSON is not quoted)
  input="$(echo "${input}" | sed -E 's/-----BEGIN [A-Z ]+ PRIVATE KEY-----.*/[REDACTED_PRIVATE_KEY]/g')"

  echo "${input}"
}

# ---------------------------------------------------------------------------
# Error helper
# ---------------------------------------------------------------------------
gcloud_die() {
  echo "error: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
require_gcloud() {
  if ! command -v gcloud &>/dev/null; then
    cat >&2 <<'HELP'
error: gcloud CLI not found on PATH.

Install options:
  macOS:  brew install --cask google-cloud-sdk
  Linux:  curl https://sdk.cloud.google.com | bash
          (or see https://cloud.google.com/sdk/docs/install)

Verify:  gcloud version
HELP
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# Parse common flags: --config <name>, --project <id>
# Call early in script main:  parse_common_flags "$@"
# After parsing, remaining args are in REMAINING_ARGS array.
# ---------------------------------------------------------------------------
REMAINING_ARGS=()
parse_common_flags() {
  REMAINING_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config)
        shift
        export GCLOUD_CLI_CONFIG="${1:-}"
        RESOLVED_CONFIG="$(resolve_config)"
        RESOLVED_PROJECT="$(resolve_project)"
        RESOLVED_ACCOUNT="$(resolve_account)"
        ;;
      --project)
        shift
        export GCLOUD_CLI_PROJECT="${1:-}"
        RESOLVED_PROJECT="$(resolve_project)"
        ;;
      *)
        REMAINING_ARGS+=("$1")
        ;;
    esac
    shift
  done
}
