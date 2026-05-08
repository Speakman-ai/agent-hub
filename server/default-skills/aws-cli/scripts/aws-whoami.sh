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

# Call STS
IDENTITY_JSON="$(aws_cmd sts get-caller-identity --output json 2>&1)"

# Detect common errors
if echo "${IDENTITY_JSON}" | grep -qi "ExpiredToken\|ExpiredTokenException"; then
  echo "error: AWS session token has expired." >&2
  echo ""
  echo "For SSO profiles, run:" >&2
  echo "  aws sso login --profile ${RESOLVED_PROFILE}" >&2
  echo ""
  echo "For assumed-role / short-lived credentials, re-run the assume-role step." >&2
  exit 1
fi

if echo "${IDENTITY_JSON}" | grep -qi "NoCredentialProviders\|Unable to locate credentials"; then
  echo "error: No AWS credentials found for profile '${RESOLVED_PROFILE}'." >&2
  echo ""
  echo "Configure credentials via one of:" >&2
  echo "  aws configure --profile ${RESOLVED_PROFILE}" >&2
  echo "  aws sso login --profile ${RESOLVED_PROFILE}   (for SSO profiles)" >&2
  echo "  export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=..." >&2
  exit 1
fi

# Mask any accidental key material before printing
IDENTITY_MASKED="$(mask_secrets "${IDENTITY_JSON}")"

# Pretty-print key fields
ACCOUNT="$(echo "${IDENTITY_MASKED}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Account','?'))" 2>/dev/null || echo '?')"
USER_ID="$(echo "${IDENTITY_MASKED}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('UserId','?'))" 2>/dev/null || echo '?')"
ARN="$(echo "${IDENTITY_MASKED}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Arn','?'))" 2>/dev/null || echo '?')"

echo "Account  : ${ACCOUNT}"
echo "UserId   : ${USER_ID}"
echo "ARN      : ${ARN}"
echo ""
echo "--- Raw JSON ---"
echo "${IDENTITY_MASKED}"
