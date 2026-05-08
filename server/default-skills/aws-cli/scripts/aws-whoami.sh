#!/usr/bin/env bash
# scripts/aws-whoami.sh — STS caller identity + resolved profile/region.
#
# Usage:
#   scripts/aws-whoami.sh [--profile <name>] [--region <name>]
#
# Output:
#   Profile  : <resolved profile>
#   Region   : <resolved region>
#   Account  : <AWS account ID>
#   UserId   : <IAM user/role ID>
#   ARN      : <caller ARN>
#   --- (JSON from sts get-caller-identity) ---

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/_common.sh"

require_aws_cli

# Parse --profile / --region flags
parse_common_flags "$@"

echo "Profile  : ${RESOLVED_PROFILE}"
echo "Region   : ${RESOLVED_REGION}"
echo ""

# Call STS — capture output + exit code without letting set -e abort the script.
# Using || so set -e does not fire; we handle the error explicitly below so
# the friendly guidance is always reachable.
IDENTITY_EXIT=0
IDENTITY_JSON="$(aws_cmd sts get-caller-identity --output json 2>&1)" || IDENTITY_EXIT=$?

if [[ ${IDENTITY_EXIT} -ne 0 ]]; then
  # Detect common credential errors and surface actionable guidance.
  if echo "${IDENTITY_JSON}" | grep -qi "ExpiredToken\|ExpiredTokenException"; then
    echo "error: AWS session token has expired." >&2
    echo "" >&2
    echo "For SSO profiles, run:" >&2
    echo "  aws sso login --profile ${RESOLVED_PROFILE}" >&2
    echo "" >&2
    echo "For assumed-role / short-lived credentials, re-run the assume-role step." >&2
    exit 1
  fi

  if echo "${IDENTITY_JSON}" | grep -qi "NoCredentialProviders\|Unable to locate credentials"; then
    echo "error: No AWS credentials found for profile '${RESOLVED_PROFILE}'." >&2
    echo "" >&2
    echo "Configure credentials via one of:" >&2
    echo "  aws configure --profile ${RESOLVED_PROFILE}" >&2
    echo "  aws sso login --profile ${RESOLVED_PROFILE}   (for SSO profiles)" >&2
    echo "  export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=..." >&2
    exit 1
  fi

  # Unknown error — surface the raw aws message so nothing is swallowed.
  echo "error: aws sts get-caller-identity failed (exit ${IDENTITY_EXIT}):" >&2
  echo "${IDENTITY_JSON}" >&2
  exit "${IDENTITY_EXIT}"
fi

# Mask any accidental key material before printing
IDENTITY_MASKED="$(mask_secrets "${IDENTITY_JSON}")"

# Pretty-print key fields (jq preferred; falls back to '?' if jq is absent)
ACCOUNT="$(echo "${IDENTITY_MASKED}" | jq -r '.Account // "?"' 2>/dev/null || echo '?')"
USER_ID="$(echo "${IDENTITY_MASKED}" | jq -r '.UserId  // "?"' 2>/dev/null || echo '?')"
ARN="$(echo "${IDENTITY_MASKED}"     | jq -r '.Arn     // "?"' 2>/dev/null || echo '?')"

echo "Account  : ${ACCOUNT}"
echo "UserId   : ${USER_ID}"
echo "ARN      : ${ARN}"
echo ""
echo "--- Raw JSON ---"
printf '%s\n' "${IDENTITY_MASKED}"
