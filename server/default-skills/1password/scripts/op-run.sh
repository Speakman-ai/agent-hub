#!/usr/bin/env bash
# scripts/op-run.sh — inject 1Password secrets into a subprocess safely.
#
# This is the preferred way to pass secrets to commands: secrets are delivered
# as env vars directly to the child process and never appear in shell history,
# model context, or logs.
#
# Usage:
#   op-run.sh [--env-file <file>] -- <cmd> [args...]
#   op-run.sh inject -i <template> [-o <output>]
#   op-run.sh dry-run -- <cmd> [args...]
#
# Options:
#   --env-file <file>   .env template file with op:// references (loaded before -- cmd)
#   --                  separator between op-run.sh flags and the child command
#   inject -i <tpl> [-o <out>]
#                       Render a config template with op:// refs resolved.
#                       Use -o <file> to write to a file (preferred over stdout).
#   dry-run             Pass --dry-run to op run; prints which vars would be set
#                       without executing the command.
#
# Examples:
#   op-run.sh -- npm run deploy
#   op-run.sh --env-file .env.tpl -- docker-compose up -d
#   op-run.sh inject -i config.tpl -o /tmp/config.resolved
#   op-run.sh dry-run -- node server.js

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_common.sh"

# ---------------------------------------------------------------------------
# inject — render a template file with op:// references resolved
# ---------------------------------------------------------------------------
cmd_inject() {
  local input="" output=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -i|--in)   input="$2";  shift 2 ;;
      -o|--out)  output="$2"; shift 2 ;;
      *) op_die "op-run.sh inject: unknown flag '$1'" ;;
    esac
  done
  [[ -z "$input" ]] && op_die "op-run.sh inject: -i <template> is required"

  if [[ -n "$output" ]]; then
    op inject -i "$input" -o "$output"
    echo "✓ Rendered to $output" >&2
  else
    # Writing to stdout — warn that output may contain resolved secrets
    echo "⚠️  Writing resolved secrets to stdout. Redirect to a file with -o <file> for safety." >&2
    op inject -i "$input"
  fi
}

# ---------------------------------------------------------------------------
# run — inject secrets and exec child command
# ---------------------------------------------------------------------------
cmd_run() {
  local env_file="" dry_run=false
  local op_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env-file) env_file="$2"; shift 2 ;;
      --dry-run)  dry_run=true;  shift   ;;
      --) shift; break ;;
      *) op_die "op-run.sh: unknown flag '$1' (put command after --)" ;;
    esac
  done

  [[ $# -eq 0 ]] && op_die "op-run.sh: no command specified after --"

  if [[ -n "$env_file" ]]; then
    op_args+=(--env-file "$env_file")
  fi
  if [[ "$dry_run" == true ]]; then
    op_args+=(--dry-run)
  fi

  exec op run "${op_args[@]}" -- "$@"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
CMD="${1:-}"
shift || true

case "$CMD" in
  inject)         cmd_inject "$@" ;;
  dry-run)        cmd_run --dry-run "$@" ;;
  --)             cmd_run -- "$@" ;;
  --env-file)     cmd_run --env-file "$1" "${@:2}" ;;
  "")
    cat >&2 <<'USAGE'
usage: op-run.sh [--env-file <file>] -- <cmd> [args...]
       op-run.sh inject -i <template> [-o <output>]
       op-run.sh dry-run -- <cmd> [args...]

Run a command with 1Password secrets injected as environment variables.

Examples:
  op-run.sh -- npm run deploy
  op-run.sh --env-file .env.tpl -- docker-compose up -d
  op-run.sh inject -i config.tpl -o /tmp/config.resolved
  op-run.sh dry-run -- node server.js

See references/op-run-recipes.md for full usage guide.
USAGE
    exit 1
    ;;
  *)
    op_die "op-run.sh: unknown subcommand '$CMD'. See usage above."
    ;;
esac
