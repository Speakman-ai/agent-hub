#!/usr/bin/env bash
# scripts/gcloud-q.sh — Generic gcloud/gsutil/bq read-query helper.
# Injects --configuration and --project automatically; masks secrets in output.
#
# Usage:
#   scripts/gcloud-q.sh [--config <name>] [--project <id>] <service> <operation> [FLAGS…]
#
# Examples:
#   scripts/gcloud-q.sh compute instances list
#   scripts/gcloud-q.sh compute instances list \
#     --filter="status=RUNNING" --format="table(name,zone,status)"
#   scripts/gcloud-q.sh container clusters list
#   scripts/gcloud-q.sh run services list --platform=managed --region=us-central1
#   scripts/gcloud-q.sh --project=my-proj storage buckets list
#   scripts/gcloud-q.sh --config=staging iam service-accounts list
#   scripts/gcloud-q.sh projects list --format="value(projectId)"
#   scripts/gcloud-q.sh logging read "severity>=ERROR" --limit=20
#
# Notes:
#   - Meant for READ operations. Do not use for writes — confirm with the user
#     first and call `gcloud` directly (with config/project from _common.sh).
#   - Output (including error output) is masked through mask_secrets() before printing.
#   - gsutil and bq commands: pass "gsutil" or "bq" as the service, then the
#     operation and flags.  Config/project flags are NOT injected for these
#     (they have their own auth mechanisms); they are passed through as-is.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/_common.sh"

# Check argument count FIRST (before gcloud availability check) so that
# "usage" is always shown when no arguments are provided, regardless of
# whether gcloud is installed.
if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
usage: gcloud-q.sh [--config <name>] [--project <id>] <service> <operation> [FLAGS…]

Examples:
  gcloud-q.sh compute instances list
  gcloud-q.sh compute instances list --filter="status=RUNNING" --format="table(name,zone)"
  gcloud-q.sh container clusters list
  gcloud-q.sh run services list --platform=managed --region=us-central1
  gcloud-q.sh --project=my-proj iam service-accounts list
  gcloud-q.sh logging read "severity>=ERROR" --limit=20
  gcloud-q.sh projects list --format="value(projectId)"
USAGE
  exit 2
fi

require_gcloud

# Strip --config / --project from args; rest goes to gcloud/gsutil/bq
parse_common_flags "$@"

if [[ ${#REMAINING_ARGS[@]} -lt 1 ]]; then
  cat >&2 <<'USAGE'
usage: gcloud-q.sh [--config <name>] [--project <id>] <service> <operation> [FLAGS…]

Examples:
  gcloud-q.sh compute instances list
  gcloud-q.sh compute instances list --filter="status=RUNNING" --format="table(name,zone)"
  gcloud-q.sh container clusters list
  gcloud-q.sh run services list --platform=managed --region=us-central1
  gcloud-q.sh --project=my-proj iam service-accounts list
  gcloud-q.sh logging read "severity>=ERROR" --limit=20
  gcloud-q.sh projects list --format="value(projectId)"
USAGE
  exit 2
fi

# Determine if this is a gsutil or bq call (passed through directly)
FIRST_ARG="${REMAINING_ARGS[0]}"

if [[ "${FIRST_ARG}" == "gsutil" ]]; then
  # gsutil: pass through remaining args directly (skip "gsutil" word)
  REST_ARGS=("${REMAINING_ARGS[@]:1}")
  echo "# gsutil (project: ${RESOLVED_PROJECT:-<not set>})" >&2
  echo "" >&2

  EXIT_CODE=0
  OUTPUT="$(gsutil "${REST_ARGS[@]}" 2>&1)" || EXIT_CODE=$?
  SAFE_OUTPUT="$(mask_secrets "${OUTPUT}")"
  printf '%s\n' "${SAFE_OUTPUT}"
  exit "${EXIT_CODE}"
fi

if [[ "${FIRST_ARG}" == "bq" ]]; then
  # bq: pass through remaining args directly (skip "bq" word)
  REST_ARGS=("${REMAINING_ARGS[@]:1}")
  echo "# bq (project: ${RESOLVED_PROJECT:-<not set>})" >&2
  echo "" >&2

  EXIT_CODE=0
  OUTPUT="$(bq "${REST_ARGS[@]}" 2>&1)" || EXIT_CODE=$?
  SAFE_OUTPUT="$(mask_secrets "${OUTPUT}")"
  printf '%s\n' "${SAFE_OUTPUT}"
  exit "${EXIT_CODE}"
fi

# Default: gcloud command with config/project injection
echo "# Config: ${RESOLVED_CONFIG}  Project: ${RESOLVED_PROJECT:-<not set>}  Account: ${RESOLVED_ACCOUNT:-<not set>}" >&2
echo "" >&2

# Run the command; capture output for masking without letting set -e abort on failure.
EXIT_CODE=0
OUTPUT="$(gcloud_cmd "${REMAINING_ARGS[@]}" 2>&1)" || EXIT_CODE=$?

# Mask any accidental credential material in both success and error output.
SAFE_OUTPUT="$(mask_secrets "${OUTPUT}")"

printf '%s\n' "${SAFE_OUTPUT}"
exit "${EXIT_CODE}"
