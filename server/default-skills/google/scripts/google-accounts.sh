#!/usr/bin/env bash
# google-accounts.sh — list the session owner's linked Google accounts.
#
#   google-accounts.sh [list] [--emails]
#
# Prints {"defaultAccountId", "accounts": [{accountId, email, isDefault,
# grantedScopes, connectedAt}]} with the default account first. Pass an email
# or accountId from this list as `--account` to google-cal.sh, google-mail.sh,
# google-sheets.sh, or google-drive.sh. `--emails` prints one email per line,
# default first, marked with `*`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

main() {
  local emails=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      list) shift ;;
      --emails) emails=1; shift ;;
      -h | --help | help) usage; exit 0 ;;
      *) google_usage_die "google-accounts: unknown arg: $1" ;;
    esac
  done

  local body
  body="$(google_api GET "/api/google/accounts")"
  if [[ "$emails" == 1 ]]; then
    command -v jq >/dev/null 2>&1 ||
      google_usage_die "google-accounts: 'jq' is required for --emails."
    jq -r '.accounts[] | (if .isDefault then "* " else "  " end) + .email' <<<"$body"
    return 0
  fi
  printf '%s\n' "$body"
}

main "$@"
