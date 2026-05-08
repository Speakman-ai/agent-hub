#!/usr/bin/env bash
# scripts/_common.sh — shared helpers for aws-cli skill scripts.
# Source, don't exec:
#
#     DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$DIR/_common.sh"
#
# Exposes:
#   resolve_profile     → prints resolved AWS profile name
#   resolve_region      → prints resolved AWS region
#   aws_cmd [ARGS…]     → aws wrapper with profile/region injected
#   mask_secrets TEXT   → redacts AKIA*/ASIA* key IDs and secret values
#   aws_die MESSAGE     → print to stderr + exit 1
#   require_aws_cli     → asserts aws CLI v2 is available or exits 2
#   RESOLVED_PROFILE    → set after first call to resolve_profile
#   RESOLVED_REGION     → set after first call to resolve_region

set -euo pipefail

# ---------------------------------------------------------------------------
# Profile resolution
# Priority: --profile flag (caller sets AWS_CLI_PROFILE) → AWS_PROFILE →
#           AWS_DEFAULT_PROFILE → "default"
# ---------------------------------------------------------------------------
resolve_profile() {
  if [[ -n "${AWS_CLI_PROFILE:-}" ]]; then
    echo "${AWS_CLI_PROFILE}"
  elif [[ -n "${AWS_PROFILE:-}" ]]; then
    echo "${AWS_PROFILE}"
  elif [[ -n "${AWS_DEFAULT_PROFILE:-}" ]]; then
    echo "${AWS_DEFAULT_PROFILE}"
  else
    echo "default"
  fi
}

# ---------------------------------------------------------------------------
# Region resolution
# Priority: --region flag (caller sets AWS_CLI_REGION) → AWS_REGION →
#           AWS_DEFAULT_REGION → profile region → us-east-1 fallback
# ---------------------------------------------------------------------------
resolve_region() {
  if [[ -n "${AWS_CLI_REGION:-}" ]]; then
    echo "${AWS_CLI_REGION}"
    return
  fi
  if [[ -n "${AWS_REGION:-}" ]]; then
    echo "${AWS_REGION}"
    return
  fi
  if [[ -n "${AWS_DEFAULT_REGION:-}" ]]; then
    echo "${AWS_DEFAULT_REGION}"
    return
  fi

  # Try reading from profile config
  local profile
  profile="$(resolve_profile)"
  local cfg_region
  cfg_region="$(aws configure get region --profile "${profile}" 2>/dev/null || true)"
  if [[ -n "${cfg_region}" ]]; then
    echo "${cfg_region}"
    return
  fi

  # Final fallback
  echo "us-east-1"
}

# Export resolved values (populated on first source)
RESOLVED_PROFILE="$(resolve_profile)"
RESOLVED_REGION="$(resolve_region)"

# ---------------------------------------------------------------------------
# aws wrapper — injects --profile and --region
# ---------------------------------------------------------------------------
aws_cmd() {
  aws --profile "${RESOLVED_PROFILE}" --region "${RESOLVED_REGION}" "$@"
}

# ---------------------------------------------------------------------------
# Secret masking
# Redacts:
#   - AWS Access Key IDs:        AKIA[A-Z0-9]{16}  or  ASIA[A-Z0-9]{16}
#   - AWS Secret Access Keys:    any value on a line containing "SecretAccessKey"
#   - Session Tokens:            any value on a line containing "SessionToken"
# ---------------------------------------------------------------------------
mask_secrets() {
  local input="$1"
  # Mask key IDs (AKIA* / ASIA*) — 20-char IDs: 4-char prefix + 16 uppercase+digits
  input="$(echo "${input}" | sed -E 's/(AKIA|ASIA)[A-Z0-9]{16}/[REDACTED_KEY_ID]/g')"
  # Mask secret key values (40-char base64 strings after "SecretAccessKey")
  # Use | as sed delimiter to avoid conflict with / chars inside the key value
  input="$(echo "${input}" | sed -E 's|(SecretAccessKey[": =]+)[A-Za-z0-9/+=]{40}|\1[REDACTED_SECRET]|g')"
  # Mask session tokens (long base64 blobs after SessionToken)
  input="$(echo "${input}" | sed -E 's|(SessionToken[": =]+)[A-Za-z0-9/+=]{20,}|\1[REDACTED_TOKEN]|g')"
  echo "${input}"
}

# ---------------------------------------------------------------------------
# Error helper
# ---------------------------------------------------------------------------
aws_die() {
  echo "error: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Prerequisite check
# ---------------------------------------------------------------------------
require_aws_cli() {
  if ! command -v aws &>/dev/null; then
    cat >&2 <<'HELP'
error: AWS CLI v2 not found on PATH.

Install:
  macOS:  brew install awscli
  Linux:  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

Verify:  aws --version   (should show aws-cli/2.x)
HELP
    exit 2
  fi

  local ver
  ver="$(aws --version 2>&1 | head -1)"
  if ! echo "${ver}" | grep -q 'aws-cli/2'; then
    echo "warning: expected AWS CLI v2, got: ${ver}" >&2
  fi
}

# ---------------------------------------------------------------------------
# Parse common flags: --profile <name>, --region <name>
# Call early in script main:  parse_common_flags "$@"
# After parsing, remaining args are in REMAINING_ARGS array.
# ---------------------------------------------------------------------------
REMAINING_ARGS=()
parse_common_flags() {
  REMAINING_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile)
        shift
        export AWS_CLI_PROFILE="${1:-}"
        RESOLVED_PROFILE="$(resolve_profile)"
        ;;
      --region)
        shift
        export AWS_CLI_REGION="${1:-}"
        RESOLVED_REGION="$(resolve_region)"
        ;;
      *)
        REMAINING_ARGS+=("$1")
        ;;
    esac
    shift
  done
}
