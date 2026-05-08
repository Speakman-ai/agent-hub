#!/usr/bin/env bash
# scripts/op-list.sh — list 1Password items, vaults, and documents.
#
# All list commands are read-only and safe to run without confirmation.
# Output never includes secret field values — only metadata (titles, UUIDs,
# categories, vault names, etc.).
#
# Usage:
#   op-list.sh                                   List all items (all vaults)
#   op-list.sh [--vault <name>] [--category <cat>] [--tags <tag1,tag2>]
#   op-list.sh vaults                            List all vaults
#   op-list.sh documents [--vault <name>]        List documents
#   op-list.sh templates                         List available item categories
#
# Categories (common): Login, Password, SecureNote, CreditCard, Identity,
#   APICredential, Database, Server, SSHKey, SoftwareLicense

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_common.sh"

# ---------------------------------------------------------------------------
# items — list items (default)
# ---------------------------------------------------------------------------
cmd_items() {
  local vault="" category="" tags="" limit=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --vault)    vault="$2";    shift 2 ;;
      --category) category="$2"; shift 2 ;;
      --tags)     tags="$2";     shift 2 ;;
      --limit)    limit="$2";    shift 2 ;;
      *) op_die "op-list.sh: unknown flag '$1'" ;;
    esac
  done

  local args=(item list)
  [[ -n "$vault" ]]    && args+=(--vault "$vault")
  [[ -n "$category" ]] && args+=(--categories "$category")
  [[ -n "$tags" ]]     && args+=(--tags "$tags")
  [[ -n "$limit" ]]    && args+=(--limit "$limit")

  op "${args[@]}" --format json \
    | python3 -c "
import sys, json
items = json.load(sys.stdin)
if not items:
    print('(no items found)')
    sys.exit(0)
print(f'{'Title':<40} {'Category':<20} {'Vault':<20} UUID')
print('-' * 100)
for item in items:
    title    = (item.get('title') or '')[:38]
    category = (item.get('category') or '')[:18]
    vault    = (item.get('vault', {}).get('name') or '')[:18]
    uid      = item.get('id','')
    print(f'{title:<40} {category:<20} {vault:<20} {uid}')
print(f'\n{len(items)} item(s)')
"
}

# ---------------------------------------------------------------------------
# vaults — list all accessible vaults
# ---------------------------------------------------------------------------
cmd_vaults() {
  op vault list --format json \
    | python3 -c "
import sys, json
vaults = json.load(sys.stdin)
if not vaults:
    print('(no vaults accessible)')
    sys.exit(0)
print(f'{'Name':<30} {'Type':<15} UUID')
print('-' * 75)
for v in vaults:
    name  = (v.get('name') or '')[:28]
    vtype = (v.get('type') or '')[:13]
    uid   = v.get('id','')
    print(f'{name:<30} {vtype:<15} {uid}')
print(f'\n{len(vaults)} vault(s)')
"
}

# ---------------------------------------------------------------------------
# documents — list documents in a vault
# ---------------------------------------------------------------------------
cmd_documents() {
  local vault=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --vault) vault="$2"; shift 2 ;;
      *) op_die "op-list.sh documents: unknown flag '$1'" ;;
    esac
  done

  local args=(document list)
  [[ -n "$vault" ]] && args+=(--vault "$vault")

  op "${args[@]}" --format json \
    | python3 -c "
import sys, json
docs = json.load(sys.stdin)
if not docs:
    print('(no documents found)')
    sys.exit(0)
print(f'{'Title':<40} {'Vault':<20} UUID')
print('-' * 80)
for d in docs:
    title = (d.get('title') or '')[:38]
    vault = (d.get('vault', {}).get('name') or '')[:18]
    uid   = d.get('id','')
    print(f'{title:<40} {vault:<20} {uid}')
print(f'\n{len(docs)} document(s)')
"
}

# ---------------------------------------------------------------------------
# templates — list available item categories
# ---------------------------------------------------------------------------
cmd_templates() {
  op item template list
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
CMD="${1:-items}"
shift || true

case "$CMD" in
  items|"")     cmd_items "$@" ;;
  vaults)       cmd_vaults ;;
  documents)    cmd_documents "$@" ;;
  templates)    cmd_templates ;;
  --vault|--category|--tags|--limit)
    # User called op-list.sh --vault ... without a subcommand
    cmd_items "$CMD" "$@"
    ;;
  *)
    cat >&2 <<'USAGE'
usage: op-list.sh [subcommand] [options]

Subcommands:
  items (default)    List all items (no secret values shown)
  vaults             List all accessible vaults
  documents          List documents
  templates          List available item categories

Options for 'items':
  --vault <name>         Filter by vault name
  --category <cat>       Filter by category (Login, Password, APICredential, …)
  --tags <tag1,tag2>     Filter by tags
  --limit <n>            Maximum number of items to return

Examples:
  op-list.sh
  op-list.sh --vault Shared --category APICredential
  op-list.sh vaults
  op-list.sh documents --vault Personal
USAGE
    exit 1
    ;;
esac
