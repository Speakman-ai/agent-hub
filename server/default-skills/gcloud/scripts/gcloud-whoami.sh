#!/usr/bin/env bash
# scripts/gcloud-whoami.sh — Active gcloud auth + resolved config/project/account.
#
# Usage:
#   scripts/gcloud-whoami.sh [--config <name>] [--project <id>]
#
# Output:
#   Configuration : <resolved config name>
#   Project       : <resolved GCP project ID>
#   Account       : <resolved active account>
#   --- (active account list from gcloud auth list) ---

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/_common.sh"

require_gcloud

# Parse --config / --project flags
parse_common_flags "$@"

echo "Configuration : ${RESOLVED_CONFIG}"
echo "Project       : ${RESOLVED_PROJECT:-<not set>}"
echo "Account       : ${RESOLVED_ACCOUNT:-<not authenticated>}"
echo ""

# Check for expired / missing credentials
AUTH_EXIT=0
AUTH_OUTPUT="$(gcloud auth list --format=json 2>&1)" || AUTH_EXIT=$?

if [[ ${AUTH_EXIT} -ne 0 ]]; then
  echo "error: gcloud auth list failed (exit ${AUTH_EXIT}):" >&2
  echo "${AUTH_OUTPUT}" >&2
  exit "${AUTH_EXIT}"
fi

# Mask any tokens that may appear in auth output
AUTH_SAFE="$(mask_secrets "${AUTH_OUTPUT}")"

# Parse with jq if available, else print raw
if command -v jq &>/dev/null; then
  ACTIVE_COUNT="$(echo "${AUTH_SAFE}" | jq '[.[] | select(.status=="ACTIVE")] | length' 2>/dev/null || echo "0")"
  if [[ "${ACTIVE_COUNT}" == "0" ]]; then
    cat >&2 <<'HELP'
error: No active Google Cloud credentials found.

For interactive sessions, run:
  gcloud auth login
  gcloud auth application-default login

For headless / service account sessions:
  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
  gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS"
HELP
    exit 1
  fi

  echo "--- Active accounts ---"
  echo "${AUTH_SAFE}" | jq -r '.[] | "\(.status)\t\(.account)"' 2>/dev/null \
    || echo "${AUTH_SAFE}"
else
  # Fallback: check for ACTIVE in raw output
  if ! echo "${AUTH_SAFE}" | grep -q "ACTIVE"; then
    cat >&2 <<'HELP'
error: No active Google Cloud credentials found.

For interactive sessions, run:
  gcloud auth login
  gcloud auth application-default login

For headless / service account sessions:
  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
  gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS"
HELP
    exit 1
  fi

  echo "--- Active accounts ---"
  echo "${AUTH_SAFE}"
fi

echo ""
echo "--- Active configuration properties ---"
# Capture config list output; mask secrets; print
CONFIG_EXIT=0
CONFIG_OUTPUT="$(gcloud config list 2>&1)" || CONFIG_EXIT=$?
if [[ ${CONFIG_EXIT} -ne 0 ]]; then
  echo "warning: gcloud config list failed: ${CONFIG_OUTPUT}" >&2
else
  mask_secrets "${CONFIG_OUTPUT}"
fi

# Check ADC status (non-fatal — just inform)
echo ""
echo "--- Application Default Credentials ---"
ADC_EXIT=0
ADC_OUTPUT="$(gcloud auth application-default print-access-token 2>&1)" || ADC_EXIT=$?
if [[ ${ADC_EXIT} -ne 0 ]]; then
  # Detect common ADC errors
  if echo "${ADC_OUTPUT}" | grep -qi "Could not automatically determine credentials\|credentials do not exist\|re-authentication required"; then
    echo "ADC status    : not configured" >&2
    echo "" >&2
    echo "To configure ADC for client libraries, run:" >&2
    echo "  gcloud auth application-default login" >&2
    echo "  -or- export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json" >&2
  else
    echo "ADC status    : error (exit ${ADC_EXIT})" >&2
    echo "${ADC_OUTPUT}" >&2
  fi
else
  # Token is valid — just confirm presence, don't print the token
  echo "ADC status    : configured (token present)"
  echo "ADC account   : ${RESOLVED_ACCOUNT:-unknown}"
fi
