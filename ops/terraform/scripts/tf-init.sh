#!/usr/bin/env bash
#
# tf-init.sh — bootstrap S3 remote state for an environment, then `terraform init`.
#
# Solves Terraform's chicken-and-egg: the S3 bucket that holds state can't be
# managed by the same config that uses it as a backend. Instead, we create the
# bucket (and optional DynamoDB lock table) out-of-band via the AWS CLI on the
# first run for a given environment, then hand off to `terraform init`.
#
# Idempotent: re-running against an existing bucket is a no-op. The script
# reads bucket / region / optional lock-table from the environment's
# backend.hcl so there's a single source of truth.
#
# Usage:
#   ./scripts/tf-init.sh <env> [extra terraform init args...]
#
# Examples:
#   AWS_PROFILE=dev ./scripts/tf-init.sh test123
#   AWS_PROFILE=dev ./scripts/tf-init.sh test123 -reconfigure
#   AWS_PROFILE=dev ./scripts/tf-init.sh prod -migrate-state
#
# Requires: aws CLI, terraform, jq not required.

set -euo pipefail

ENV_NAME="${1:-}"
if [[ -z "${ENV_NAME}" ]]; then
  echo "usage: $0 <env> [extra terraform init args...]" >&2
  echo "example: AWS_PROFILE=dev $0 test123" >&2
  exit 2
fi
shift || true

# Resolve paths relative to this script so the tool works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_HCL="${TF_DIR}/environments/${ENV_NAME}/backend.hcl"

if [[ ! -f "${BACKEND_HCL}" ]]; then
  echo "error: backend config not found at ${BACKEND_HCL}" >&2
  echo "       create it before running this script. See environments/test123/backend.hcl for a template." >&2
  exit 2
fi

# Parse a single top-level key from the HCL-ish backend file. Format is simple
# `key = "value"` or `key = true`, so a regex is sufficient; no HCL parser.
parse_backend_value() {
  local key="$1"
  # Strip comments, match the key, take the RHS, strip quotes+whitespace.
  sed -e 's/#.*$//' "${BACKEND_HCL}" \
    | awk -v k="${key}" -F= '$0 ~ "^[[:space:]]*"k"[[:space:]]*=" {
        sub(/^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*/, "", $0);
        gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", $0);
        print; exit
      }'
}

BUCKET="$(parse_backend_value bucket)"
REGION="$(parse_backend_value region)"
LOCK_TABLE="$(parse_backend_value dynamodb_table)"

if [[ -z "${BUCKET}" || -z "${REGION}" ]]; then
  echo "error: backend.hcl must set both 'bucket' and 'region'" >&2
  exit 2
fi

echo ">>> Environment: ${ENV_NAME}"
echo ">>> State bucket: s3://${BUCKET} (region: ${REGION})"
[[ -n "${LOCK_TABLE}" ]] && echo ">>> Lock table:   ${LOCK_TABLE} (DynamoDB)"

# ── Ensure the bucket exists ──────────────────────────────────────────────────
if aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  echo ">>> Bucket already exists — skipping create."
else
  echo ">>> Creating bucket ${BUCKET}..."
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${BUCKET}" --region us-east-1 >/dev/null
  else
    aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}" >/dev/null
  fi

  echo ">>> Enabling versioning..."
  aws s3api put-bucket-versioning --bucket "${BUCKET}" --region "${REGION}" \
    --versioning-configuration Status=Enabled >/dev/null

  echo ">>> Enabling default SSE-S3 encryption..."
  aws s3api put-bucket-encryption --bucket "${BUCKET}" --region "${REGION}" \
    --server-side-encryption-configuration '{
      "Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]
    }' >/dev/null

  echo ">>> Blocking all public access..."
  aws s3api put-public-access-block --bucket "${BUCKET}" --region "${REGION}" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

  echo ">>> Bucket ready."
fi

# ── Ensure the DynamoDB lock table exists (only if the user opted in) ─────────
if [[ -n "${LOCK_TABLE}" ]]; then
  if aws dynamodb describe-table --table-name "${LOCK_TABLE}" --region "${REGION}" >/dev/null 2>&1; then
    echo ">>> Lock table already exists — skipping create."
  else
    echo ">>> Creating DynamoDB lock table ${LOCK_TABLE}..."
    aws dynamodb create-table \
      --table-name "${LOCK_TABLE}" \
      --region "${REGION}" \
      --attribute-definitions AttributeName=LockID,AttributeType=S \
      --key-schema AttributeName=LockID,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST >/dev/null
    aws dynamodb wait table-exists --table-name "${LOCK_TABLE}" --region "${REGION}"
    echo ">>> Lock table ready."
  fi
fi

# ── terraform init with the per-env backend config ────────────────────────────
echo ">>> Running: terraform init -backend-config=${BACKEND_HCL} $*"
cd "${TF_DIR}"
terraform init -backend-config="${BACKEND_HCL}" -input=false "$@"

echo ">>> Done. Next: AWS_PROFILE=<profile> terraform plan -var-file=environments/${ENV_NAME}/${ENV_NAME}.tfvars"
