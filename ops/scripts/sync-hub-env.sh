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
#     That filter is upstream and advisory; this script re-checks every desired
#     key against the same pattern before building the payload, so a hand-passed
#     --env-file or a Terraform regression cannot smuggle a secret into SSM.
#   - `--managed-keys-file` takes the `hub_env_managed_keys` output: every key the
#     sync owns, including ones the current config omits. Terraform drops a
#     feature's keys entirely once the feature is disabled, so the host needs the
#     inventory to tell "not ours" from "ours, now retracted" and delete the
#     stale lines. Without it the Hub keeps honouring the old setting.
#   - `--runtime-keys-file` takes the `hub_env_runtime_injected_keys` output: the
#     owned keys that stay visible in the container after removal because a
#     `docker run -e` flag or an image ENV line supplies them. The host verifies
#     retracted keys actually disappeared and exempts exactly these.
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
#                   [--managed-keys-file managed-keys.txt] \
#                   [--runtime-keys-file runtime-keys.txt] \
#                   [--container agenthub-server] [--service agenthub-server] \
#                   [--dry-run]
#
# Requires: aws CLI (with credentials for ssm:SendCommand on the target), jq.

set -euo pipefail

INSTANCE_ID=""
ENV_FILE=""
MANAGED_KEYS_FILE=""
RUNTIME_KEYS_FILE=""
REMOTE_PATH=""
REGION="${AWS_REGION:-us-east-2}"
CONTAINER="agenthub-server"
SERVICE="agenthub-server"
DRY_RUN="false"

die() {
  echo "error: $*" >&2
  exit 2
}

# Mirrors local.hub_env_secret_key_regex. Terraform already withholds these from
# hub_env_managed, but this script is the last gate before the payload is built,
# and an SSM SendCommand body is retained in command history and CloudTrail: a
# secret that reaches it is disclosed to anyone holding ssm:GetCommandInvocation
# and cannot be recalled. Enforced on the desired lines (which carry VALUES) and
# on the key lists alike, so a hand-run or a Terraform regression cannot leak one.
SECRET_KEY_RE='(KEY|TOKEN|PASSWORD|SECRET)'

# Read a file's non-blank, non-comment lines into FILTERED_LINES.
#
# grep exits 1 for "no matching lines" and 2+ for a real failure (unreadable
# file, I/O error). `|| true` collapses those into the same empty result, and an
# empty result is not inert here: an empty desired set alongside an inventory is
# the instruction that makes the host retract EVERY managed key and restart the
# live Hub. So an empty result is only accepted when grep actually read the file.
#
# Sets a global rather than printing, because `die` inside a command
# substitution would exit the subshell and leave the caller running.
FILTERED_LINES=""
read_filtered_lines() {
  local file="$1" label="$2" status=0
  FILTERED_LINES=""
  FILTERED_LINES="$(grep -Ev '^[[:space:]]*(#|$)' "${file}")" || status=$?
  if [[ "${status}" -gt 1 ]]; then
    die "failed to read ${label} (${file}): grep exited ${status}. Refusing to continue, because an unreadable file is not an empty set"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --managed-keys-file) MANAGED_KEYS_FILE="${2:-}"; shift 2 ;;
    --runtime-keys-file) RUNTIME_KEYS_FILE="${2:-}"; shift 2 ;;
    --remote-path) REMOTE_PATH="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    -h | --help)
      sed -n '2,45p' "$0"
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

# The inventory drives deletion on the live host, so it is validated harder than
# the desired lines: a secret-looking key here would mean Terraform leaked one
# into the syncable set, and a desired key missing from it would be a key we
# could write but never retract. Both are release-blocking drift, not warnings.
MANAGED_KEYS=""
MANAGED_KEYS_B64=""
if [[ -n "${MANAGED_KEYS_FILE}" ]]; then
  [[ -f "${MANAGED_KEYS_FILE}" ]] || die "managed keys file not found: ${MANAGED_KEYS_FILE}"
  read_filtered_lines "${MANAGED_KEYS_FILE}" 'managed keys file'
  MANAGED_KEYS="${FILTERED_LINES}"
  [[ -n "${MANAGED_KEYS}" ]] || die "managed keys file is empty: ${MANAGED_KEYS_FILE}"

  n=0
  while IFS= read -r key; do
    n=$((n + 1))
    # Withheld for the same reason as the desired lines: a --managed-keys-file
    # pointed at the wrong file would echo whatever it actually holds.
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      die "invalid managed key at position ${n} of ${MANAGED_KEYS_FILE}; expected a bare KEY name. Content withheld, it may contain a secret"
    [[ ! "${key}" =~ ${SECRET_KEY_RE} ]] ||
      die "refusing to manage secret-bearing key: ${key}"
  done <<<"${MANAGED_KEYS}"

  MANAGED_KEYS_B64="$(printf '%s\n' "${MANAGED_KEYS}" | base64 | tr -d '\n')"
fi

# Exemptions from the host's retraction check. Every entry must be an owned key:
# exempting something we never remove is dead weight that would quietly widen the
# check's blind spot if the inventory later grew that key for real.
RUNTIME_KEYS_B64=""
if [[ -n "${RUNTIME_KEYS_FILE}" ]]; then
  [[ -f "${RUNTIME_KEYS_FILE}" ]] || die "runtime keys file not found: ${RUNTIME_KEYS_FILE}"
  [[ -n "${MANAGED_KEYS}" ]] || die "--runtime-keys-file requires --managed-keys-file"
  read_filtered_lines "${RUNTIME_KEYS_FILE}" 'runtime keys file'
  RUNTIME_KEYS="${FILTERED_LINES}"
  if [[ -n "${RUNTIME_KEYS}" ]]; then
    n=0
    while IFS= read -r key; do
      n=$((n + 1))
      [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
        die "invalid runtime-injected key at position ${n} of ${RUNTIME_KEYS_FILE}; expected a bare KEY name. Content withheld, it may contain a secret"
      grep -qxF "${key}" <<<"${MANAGED_KEYS}" ||
        die "runtime-injected key is not in the managed-key inventory: ${key}"
    done <<<"${RUNTIME_KEYS}"
    echo "Keys exempt from the retraction check (supplied outside .env):"
    while IFS= read -r key; do echo "  - ${key}"; done <<<"${RUNTIME_KEYS}"
    RUNTIME_KEYS_B64="$(printf '%s\n' "${RUNTIME_KEYS}" | base64 | tr -d '\n')"
  fi
fi

# Drop blanks/comments so the remote loop and the key listing agree.
read_filtered_lines "${ENV_FILE}" 'env file'
MANAGED="${FILTERED_LINES}"

# An EMPTY desired set is a legitimate instruction when we hold the inventory:
# it means every managed feature is now off and all owned keys must be retracted
# from the live host. Exiting early there is what would leave the last disabled
# feature running. Empty with no inventory really is a no-op.
if [[ -z "${MANAGED}" && -z "${MANAGED_KEYS}" ]]; then
  echo "No managed env lines to sync (empty ${ENV_FILE}) and no inventory; nothing to do."
  exit 0
fi

if [[ -n "${MANAGED}" ]]; then
  # Every line must be KEY=VALUE. A stray line would otherwise be upserted as a
  # bogus key on the live host.
  #
  # Report the POSITION, never the content, until the key has been validated:
  # `${line%%=*}` is not a safe stand-in for "the key name". On a line with no
  # `=` it expands to the whole line, and on a base64 secret ending in `=`
  # padding it expands to the secret itself. Both would land in a public CI log.
  # Only a key that already matched the identifier pattern is safe to name, which
  # is why the secret-key check below can quote it and these two cannot.
  n=0
  while IFS= read -r line; do
    n=$((n + 1))
    [[ "${line}" == *"="* ]] ||
      die "malformed env line at position ${n} (counting non-blank, non-comment lines) of ${ENV_FILE}; expected KEY=VALUE. Content withheld, it may contain a secret"
    key="${line%%=*}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      die "invalid env key at position ${n} (counting non-blank, non-comment lines) of ${ENV_FILE}. Content withheld, it may contain a secret"
    [[ ! "${key}" =~ ${SECRET_KEY_RE} ]] ||
      die "refusing to sync secret-bearing key: ${key} (an SSM payload is retained in CloudTrail; rotate it out-of-band instead)"
  done <<<"${MANAGED}"

  echo "Managed keys for ${INSTANCE_ID} (${REGION}) -> ${REMOTE_PATH}:"
  while IFS= read -r line; do
    echo "  - ${line%%=*}"
  done <<<"${MANAGED}"
else
  echo "Terraform emits no managed env lines for ${INSTANCE_ID}; retracting every owned key."
fi

if [[ -n "${MANAGED_KEYS}" ]]; then
  if [[ -n "${MANAGED}" ]]; then
    while IFS= read -r line; do
      grep -qxF "${line%%=*}" <<<"${MANAGED_KEYS}" ||
        die "desired key is not in the managed-key inventory: ${line%%=*}"
    done <<<"${MANAGED}"
  fi

  DESIRED_KEYS=""
  if [[ -n "${MANAGED}" ]]; then
    DESIRED_KEYS="$(cut -d= -f1 <<<"${MANAGED}")"
  fi
  RETRACTED=""
  while IFS= read -r key; do
    grep -qxF "${key}" <<<"${DESIRED_KEYS}" || RETRACTED="${RETRACTED} ${key}"
  done <<<"${MANAGED_KEYS}"
  if [[ -n "${RETRACTED}" ]]; then
    echo "Keys no longer emitted by Terraform (removed from the live .env if present):"
    for key in ${RETRACTED}; do echo "  - ${key}"; done
  fi
else
  echo "No --managed-keys-file supplied; stale managed keys will NOT be removed."
fi

# Stays empty when Terraform emits nothing, so the host sees a genuinely empty
# desired set rather than a file holding one blank line.
DESIRED_B64=""
if [[ -n "${MANAGED}" ]]; then
  DESIRED_B64="$(printf '%s\n' "${MANAGED}" | base64 | tr -d '\n')"
fi

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
  echo "export HUB_ENV_MANAGED_KEYS_B64='${MANAGED_KEYS_B64}'"
  echo "export HUB_ENV_RUNTIME_KEYS_B64='${RUNTIME_KEYS_B64}'"
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
