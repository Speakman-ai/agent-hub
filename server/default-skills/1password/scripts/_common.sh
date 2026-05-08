#!/usr/bin/env bash
# scripts/_common.sh — shared auth + utility helpers for 1Password skill scripts.
# Source, don't exec:
#
#     DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$DIR/_common.sh"
#
# Exposes:
#   require_op_cli        → asserts op is on PATH, exits 2 if missing
#   require_op_auth       → asserts auth is available, exits 2 if not
#   op_die MESSAGE        → print to stderr + exit 1
#   op_redact TEXT        → mask op:// refs and token-looking values in TEXT
#   OP_WRITE_CONFIRMED    → gate for mutation scripts (must be "yes")

set -euo pipefail

# ---------------------------------------------------------------------------
# require_op_cli — verify op is installed and executable
# ---------------------------------------------------------------------------
require_op_cli() {
  if ! command -v op &>/dev/null; then
    cat >&2 <<'HELP'
error: op CLI not found on PATH.

Install the 1Password CLI first:
  macOS:  brew install --cask 1password-cli
  Linux:  https://developer.1password.com/docs/cli/get-started#install
  Windows: https://developer.1password.com/docs/cli/get-started#install

After installing, verify with:  op --version

Then re-run this script.
HELP
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# require_op_auth — verify auth is available
#
# Resolution order (matches SKILL.md and references/auth-modes.md):
#   1. OP_SERVICE_ACCOUNT_TOKEN env var (injected from Agent Hub credential store)
#   2. OP_CONNECT_HOST + OP_CONNECT_TOKEN (self-hosted Connect server)
#   3. Existing op session on the host (op whoami succeeds)
# ---------------------------------------------------------------------------
require_op_auth() {
  require_op_cli

  # 1. Service Account token (preferred — works headless)
  if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    return 0
  fi

  # 2. Connect server
  if [[ -n "${OP_CONNECT_HOST:-}" && -n "${OP_CONNECT_TOKEN:-}" ]]; then
    return 0
  fi

  # 3. Existing interactive session
  if op whoami &>/dev/null; then
    return 0
  fi

  cat >&2 <<'HELP'
error: no 1Password authentication found.

To fix (pick the best option for your context):

  Option A — Service Account (recommended for agents, cron, headless):
    1. Create a Service Account at https://developer.1password.com/docs/service-accounts/get-started
    2. In Agent Hub: Settings → Skills → Credentials → 1Password
       Set OP_SERVICE_ACCOUNT_TOKEN to your ops_... token.
    3. The token is injected automatically on the next session spawn.

  Option B — Interactive biometric session (local dev only, not for cron):
    eval $(op signin)
    # Then re-run your command.

  Option C — Connect server (self-hosted):
    export OP_CONNECT_HOST=https://your-connect-host
    export OP_CONNECT_TOKEN=your-connect-token

For details: https://developer.1password.com/docs/service-accounts/
HELP
  exit 2
}

# ---------------------------------------------------------------------------
# op_die MESSAGE — print to stderr + exit 1
# ---------------------------------------------------------------------------
op_die() {
  echo "error: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# op_redact TEXT — mask op:// references and long token-like values
#
# Replaces:
#   - op://vault/item/field URIs with [redacted:op://...]
#   - Anything that looks like a long bearer token / secret (32+ contiguous
#     non-whitespace chars containing mixed case / digits) with [redacted]
#
# This is a best-effort heuristic. The primary safety measure is never calling
# op read / op item get in a way that pipes values directly back to the model.
# Use scripts/op-read.sh which routes through this redaction layer.
#
# Usage:
#   output=$(op item get "My Item" 2>&1)
#   op_redact "$output"
# ---------------------------------------------------------------------------
op_redact() {
  local text="$1"
  # Mask op:// URIs
  text=$(echo "$text" | sed -E 's|op://[^ \t"]+|[redacted:op://...]|g')
  # Mask long token-like strings (≥32 non-space chars with mixed charset).
  # Char class matches standard base64 + URL-safe base64 (_-) + padding (=)
  # to catch ops_... Service Account tokens and similar formats.
  # Aligned with op-redact.ts LONG_TOKEN_PATTERN.
  text=$(echo "$text" | sed -E 's/[A-Za-z0-9+/=_-]{32,}/[redacted]/g')
  echo "$text"
}

# ---------------------------------------------------------------------------
# require_python3 — verify python3 is on PATH (needed for JSON formatting)
# ---------------------------------------------------------------------------
require_python3() {
  if ! command -v python3 &>/dev/null; then
    cat >&2 <<'HELP'
error: python3 not found on PATH.

The 1Password skill scripts use python3 for JSON formatting.

Install Python 3:
  macOS:  brew install python3
  Linux:  sudo apt-get install python3  (Debian/Ubuntu)
          sudo yum install python3       (RHEL/CentOS)

After installing, verify with:  python3 --version
HELP
    exit 2
  fi
}
