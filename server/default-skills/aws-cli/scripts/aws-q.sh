#!/usr/bin/env bash
# scripts/aws-q.sh — Generic AWS read-query helper.
# Injects --profile and --region automatically; masks secrets in output.
#
# Usage:
#   scripts/aws-q.sh [--profile <name>] [--region <name>] <service> <operation> [AWS_FLAGS…]
#
# Examples:
#   scripts/aws-q.sh ec2 describe-instances
#   scripts/aws-q.sh ec2 describe-instances \
#     --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output table
#   scripts/aws-q.sh s3api list-buckets
#   scripts/aws-q.sh lambda list-functions --max-items 20
#   scripts/aws-q.sh logs describe-log-groups --log-group-name-prefix /aws/lambda
#   scripts/aws-q.sh --profile staging ec2 describe-instances
#   scripts/aws-q.sh --region ap-southeast-1 rds describe-db-instances
#
# Notes:
#   - Meant for READ operations. Do not use for writes — confirm with the user
#     first and call `aws` directly (with profile/region from _common.sh).
#   - Output is masked through mask_secrets() before printing.
#   - The AWS CLI auto-paginates by default (all pages merged). Pass --no-paginate
#     if you want ONLY the first page (e.g. quick sampling or manual paging).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/_common.sh"

require_aws_cli

# Strip --profile / --region from args; rest goes to aws
parse_common_flags "$@"

if [[ ${#REMAINING_ARGS[@]} -lt 2 ]]; then
  cat >&2 <<'USAGE'
usage: aws-q.sh [--profile <name>] [--region <name>] <service> <operation> [AWS_FLAGS…]

Examples:
  aws-q.sh ec2 describe-instances
  aws-q.sh s3api list-buckets
  aws-q.sh iam list-users --query 'Users[].UserName'
  aws-q.sh ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output table
USAGE
  exit 2
fi

echo "# Profile: ${RESOLVED_PROFILE}  Region: ${RESOLVED_REGION}" >&2
echo "" >&2

# Run the command; capture output for masking without letting set -e abort on failure
EXIT_CODE=0
OUTPUT="$(aws_cmd "${REMAINING_ARGS[@]}" 2>&1)" || EXIT_CODE=$?

# Mask any accidental credential material
SAFE_OUTPUT="$(mask_secrets "${OUTPUT}")"

printf '%s\n' "${SAFE_OUTPUT}"
exit "${EXIT_CODE}"
