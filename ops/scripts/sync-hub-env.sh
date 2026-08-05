#!/usr/bin/env bash
#
# sync-hub-env.sh — adopt Terraform-rendered Hub env on a RUNNING instance.
#
# Why this exists: the Hub's .env is rendered into EC2 user-data, but cloud-init
# does not re-run on an existing host. So a `terraform apply` that changes an env
# value updates state and leaves the live Hub untouched — historically the gap was
# closed by replacing the instance, which wipes the box and changes its public IP.
# This script closes it in place instead: upsert the managed keys over SSM and
# restart the container.
#
# Contract:
#   - Input is the `hub_env_managed` Terraform output (KEY=VALUE lines). That
#     output already excludes secret-bearing keys — an SSM SendCommand payload is
#     retained in command history / CloudTrail, so secrets must never travel this
#     path — and excludes keys the in-app UI owns. See local.hub_env_managed_lines.
#   - Upserts are order-preserving and value-safe (awk with the value passed as a
#     variable, never interpolated into a regex).
#   - Idempotent: if the resulting file is byte-identical, nothing is written,
#     nothing is backed up, and the Hub is NOT restarted. Safe to run on every
#     release.
#   - Values are never echoed. Only key names, so this is safe in a public repo's
#     Actions log.
#
# Usage:
#   sync-hub-env.sh --instance-id i-0123... --env-file managed.env \
#                   --remote-path /home/agenthub/agent-hub/.env [--region us-east-2] \
#                   [--container agenthub-server] [--service agenthub-server] \
#                   [--dry-run]
#
# Requires: aws CLI (with credentials for ssm:SendCommand on the target), jq.

set -euo pipefail

INSTANCE_ID=""
ENV_FILE=""
REMOTE_PATH=""
REGION="${AWS_REGION:-us-east-2}"
CONTAINER="agenthub-server"
SERVICE="agenthub-server"
DRY_RUN="false"

die() {
  echo "error: $*" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --remote-path) REMOTE_PATH="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    -h | --help)
      sed -n '2,36p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "${INSTANCE_ID}" ]] || die "--instance-id is required"
[[ -n "${ENV_FILE}" ]] || die "--env-file is required"
[[ -n "${REMOTE_PATH}" ]] || die "--remote-path is required"
[[ -f "${ENV_FILE}" ]] || die "env file not found: ${ENV_FILE}"
command -v jq >/dev/null 2>&1 || die "jq is required but not installed"
command -v aws >/dev/null 2>&1 || die "aws CLI is required but not installed"

# Drop blanks/comments so the remote loop and the key listing agree.
MANAGED="$(grep -Ev '^[[:space:]]*(#|$)' "${ENV_FILE}" || true)"
if [[ -z "${MANAGED}" ]]; then
  echo "No managed env lines to sync (empty ${ENV_FILE}); nothing to do."
  exit 0
fi

# Every line must be KEY=VALUE — a stray line would otherwise be upserted as a
# bogus key on the live host.
while IFS= read -r line; do
  [[ "${line}" == *"="* ]] || die "malformed env line (expected KEY=VALUE): ${line%%=*}"
  key="${line%%=*}"
  [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid env key: ${key}"
done <<<"${MANAGED}"

echo "Managed keys for ${INSTANCE_ID} (${REGION}) -> ${REMOTE_PATH}:"
while IFS= read -r line; do
  echo "  - ${line%%=*}"
done <<<"${MANAGED}"

DESIRED_B64="$(printf '%s\n' "${MANAGED}" | base64 | tr -d '\n')"

# The SSM payload is a few exports followed verbatim by the host-side script.
# Single-quoting the values is safe because each is validated above to contain no
# single quote.
REMOTE_SRC="$(dirname "${BASH_SOURCE[0]}")/hub-env-upsert.remote.sh"
[[ -f "${REMOTE_SRC}" ]] || die "host-side script missing: ${REMOTE_SRC}"

for value in "${REMOTE_PATH}" "${CONTAINER}" "${SERVICE}"; do
  [[ "${value}" != *"'"* ]] || die "single quotes are not supported in --remote-path/--container/--service"
done

REMOTE_FILE="$(mktemp)"
cleanup() { rm -f "${REMOTE_FILE}"; }
trap cleanup EXIT

{
  echo "export HUB_ENV_FILE='${REMOTE_PATH}'"
  echo "export HUB_ENV_CONTAINER='${CONTAINER}'"
  echo "export HUB_ENV_SERVICE='${SERVICE}'"
  echo "export HUB_ENV_DESIRED_B64='${DESIRED_B64}'"
  cat "${REMOTE_SRC}"
} >"${REMOTE_FILE}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo ""
  echo "--- dry run: SSM payload (env blob redacted) ---"
  sed "s/^export HUB_ENV_DESIRED_B64=.*/export HUB_ENV_DESIRED_B64='<redacted>'/" "${REMOTE_FILE}"
  exit 0
fi

PARAMS_JSON="$(jq -Rcs '{commands: split("\n") | map(select(length > 0))}' "${REMOTE_FILE}")"

CMD_ID="$(
  aws ssm send-command \
    --region "${REGION}" \
    --instance-ids "${INSTANCE_ID}" \
    --document-name "AWS-RunShellScript" \
    --comment "Sync Terraform-managed Hub env (no instance replacement)" \
    --parameters "${PARAMS_JSON}" \
    --query 'Command.CommandId' \
    --output text
)"
echo "SSM CommandId=${CMD_ID}"

STATUS="Pending"
for _ in $(seq 1 60); do
  STATUS="$(
    aws ssm get-command-invocation \
      --region "${REGION}" \
      --command-id "${CMD_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --query 'Status' \
      --output text 2>/dev/null || echo Pending
  )"
  case "${STATUS}" in
    Success | Failed | Cancelled | TimedOut) break ;;
  esac
  sleep 5
done

INVOCATION="$(
  aws ssm get-command-invocation \
    --region "${REGION}" \
    --command-id "${CMD_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --output json
)"

echo "--- remote stdout ---"
jq -r '.StandardOutputContent // ""' <<<"${INVOCATION}"
STDERR="$(jq -r '.StandardErrorContent // ""' <<<"${INVOCATION}")"
if [[ -n "${STDERR}" ]]; then
  echo "--- remote stderr ---" >&2
  printf '%s\n' "${STDERR}" >&2
fi

if [[ "${STATUS}" != "Success" ]]; then
  echo "error: SSM env sync finished with status ${STATUS}" >&2
  exit 1
fi

echo "Env sync complete (status=${STATUS})."
