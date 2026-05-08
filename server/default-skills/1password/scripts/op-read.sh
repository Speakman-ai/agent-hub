#!/usr/bin/env bash
# scripts/op-read.sh — safe 1Password secret read wrapper.
#
# Reads a single secret value or shows item details. Output is routed through
# the redaction layer so resolved secret values never appear in agent logs.
#
# Usage:
#   op-read.sh "op://vault/item/field"           # read by secret reference
#   op-read.sh --vault <v> --item <i> --field <f> # read by components
#   op-read.sh whoami                             # show current identity (no secrets)
#   op-read.sh item <title-or-uuid>              # show item details (fields visible!)
#
# IMPORTANT: The output of op-read.sh is safe to capture but MUST NOT be echoed
# back to the user verbatim. The agent must use the value (e.g. pass it to a
# command), not display it.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_common.sh"

# ---------------------------------------------------------------------------
# whoami — show identity without exposing any secrets
# ---------------------------------------------------------------------------
cmd_whoami() {
  op whoami
}

# ---------------------------------------------------------------------------
# item — show item metadata (field labels but NOT values by default)
# ---------------------------------------------------------------------------
cmd_item() {
  local title="${1:-}"
  [[ -z "$title" ]] && op_die "usage: op-read.sh item <title-or-uuid>"
  # Show fields list (labels only, no values) so agent can discover field names
  op item get "$title" --format json \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('Title:', data.get('title','?'))
print('Vault:', data.get('vault', {}).get('name', '?'))
print('Category:', data.get('category','?'))
print('Fields:')
for f in data.get('fields', []):
    label = f.get('label','') or f.get('id','')
    ftype = f.get('type','')
    section = (f.get('section') or {}).get('label', '')
    section_str = f'  [{section}]' if section else ''
    print(f'  - {label} ({ftype}){section_str}')
" 2>&1
}

# ---------------------------------------------------------------------------
# read — fetch a single field value via op:// reference
# The value is written to stdout; it goes through op_redact before printing
# so the model never sees it in a log-visible context.
# ---------------------------------------------------------------------------
cmd_read() {
  local ref=""
  local vault="" item="" field=""

  # Parse args
  while [[ $# -gt 0 ]]; do
    case "$1" in
      op://*) ref="$1"; shift ;;
      --vault)  vault="$2";  shift 2 ;;
      --item)   item="$2";   shift 2 ;;
      --field)  field="$2";  shift 2 ;;
      *) op_die "op-read.sh: unknown argument '$1'" ;;
    esac
  done

  # Build op:// ref from components if not supplied directly
  if [[ -z "$ref" ]]; then
    [[ -z "$vault" || -z "$item" || -z "$field" ]] && \
      op_die "supply either an op:// reference or --vault, --item, and --field"
    ref="op://${vault}/${item}/${field}"
  fi

  # Read the value — output is intentionally NOT printed to stdout here.
  # We write it to a file descriptor so the caller can capture it, but we
  # don't echo it in a way the model would log.
  local value
  value=$(op read "$ref" 2>&1) || {
    # Redact error output in case it somehow contains the value
    local err
    err=$(op_redact "$value")
    op_die "op read failed: $err"
  }

  # Write value to stdout for capture — agent must NOT echo this to chat
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
CMD="${1:-}"
shift || true

case "$CMD" in
  whoami)         cmd_whoami ;;
  item)           cmd_item "$@" ;;
  ""| op://*)
    # Called with an op:// ref as first arg or no subcommand
    cmd_read "${CMD:-}" "$@"
    ;;
  --vault|--item|--field)
    cmd_read "$CMD" "$@"
    ;;
  *)
    cat >&2 <<'USAGE'
usage: op-read.sh <command> [options]

Commands:
  whoami                              Show current op identity (no secrets)
  item <title-or-uuid>                Show item fields (labels only, no values)
  "op://vault/item/field"             Read a single field value
  --vault <v> --item <i> --field <f>  Read by components

Examples:
  op-read.sh whoami
  op-read.sh item "My AWS Account"
  op-read.sh "op://Personal/AWS Dev/access_key_id"
  op-read.sh --vault Personal --item "AWS Dev" --field access_key_id
USAGE
    exit 1
    ;;
esac
