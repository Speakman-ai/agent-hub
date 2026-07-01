#!/usr/bin/env bash
# google-sheets.sh — Google Sheets via the Hub proxy (scoped to the session owner).
#
#   google-sheets.sh get    <spreadsheetId>
#   google-sheets.sh values <spreadsheetId> --range A1:C10 \
#                          [--major-dimension ROWS|COLUMNS] [--value-render FORMATTED_VALUE|UNFORMATTED_VALUE|FORMULA]
#   google-sheets.sh append <spreadsheetId> --range Sheet1!A1 --values '[["a",1],["b",2]]' \
#                          [--input-option RAW|USER_ENTERED] [--insert-option OVERWRITE|INSERT_ROWS] [--major-dimension ROWS|COLUMNS]
#   google-sheets.sh update <spreadsheetId> --range Sheet1!A1:B2 --values '[["a",1],["b",2]]' \
#                          [--input-option RAW|USER_ENTERED] [--major-dimension ROWS|COLUMNS]
#
# --values is a JSON row-major matrix. Read ops need no extra tooling;
# append/update validate the matrix with `jq`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

require_jq_for_write() {
  command -v jq >/dev/null 2>&1 ||
    google_usage_die "google-sheets: 'jq' is required to build the request body for this command."
}

cmd_get() {
  local id="${1:-}"
  require_arg "<spreadsheetId>" "$id"
  google_api GET "/api/google/sheets/$(urlenc "$id")"
}

cmd_values() {
  local id="${1:-}"
  require_arg "<spreadsheetId>" "$id"
  shift
  local range="" major="" render=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --range) range="${2:-}"; shift 2 ;;
      --major-dimension) major="${2:-}"; shift 2 ;;
      --value-render) render="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-sheets values: unknown arg: $1" ;;
    esac
  done
  require_arg --range "$range"
  local qs="range=$(urlenc "$range")"
  [[ -n "$major" ]] && qs+="&majorDimension=$(urlenc "$major")"
  [[ -n "$render" ]] && qs+="&valueRenderOption=$(urlenc "$render")"
  google_api GET "/api/google/sheets/$(urlenc "$id")/values?${qs}"
}

build_write_body() {
  # build_write_body RANGE VALUES_JSON INPUT MAJOR [INSERT] → body JSON
  local range="$1" values="$2" input="$3" major="$4" insert="${5:-}"
  # The proxy/Google expect a row-major matrix: an array of rows, every row an
  # array, every cell a primitive (string/number/boolean/null). Validate the
  # WHOLE shape here so payloads like [["ok"],"bad"] or [["ok",{"x":1}]] are
  # rejected at the edge with a clear message instead of erroring at Google.
  printf '%s' "$values" | jq -e '
      type == "array"
      and length >= 1
      and all(.[]; type == "array")
      and all(.[][]?; type == "string" or type == "number" or type == "boolean" or type == "null")
    ' >/dev/null 2>&1 ||
    google_usage_die "google-sheets: --values must be a non-empty JSON row-major matrix of primitive cells (string/number/boolean/null), e.g. '[[\"a\",1],[\"b\",2]]'."
  local body
  body="$(jq -n --arg r "$range" --argjson v "$values" '{range:$r, values:$v}')"
  [[ -n "$input" ]] && body="$(jq --arg v "$input" '. + {valueInputOption:$v}' <<<"$body")"
  [[ -n "$major" ]] && body="$(jq --arg v "$major" '. + {majorDimension:$v}' <<<"$body")"
  [[ -n "$insert" ]] && body="$(jq --arg v "$insert" '. + {insertDataOption:$v}' <<<"$body")"
  printf '%s' "$body"
}

cmd_append() {
  require_jq_for_write
  local id="${1:-}"
  require_arg "<spreadsheetId>" "$id"
  shift
  local range="" values="" input="" major="" insert=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --range) range="${2:-}"; shift 2 ;;
      --values) values="${2:-}"; shift 2 ;;
      --input-option) input="${2:-}"; shift 2 ;;
      --insert-option) insert="${2:-}"; shift 2 ;;
      --major-dimension) major="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-sheets append: unknown arg: $1" ;;
    esac
  done
  require_arg --range "$range"
  require_arg --values "$values"
  local body
  body="$(build_write_body "$range" "$values" "$input" "$major" "$insert")"
  google_api POST "/api/google/sheets/$(urlenc "$id")/values/append" -d "$body"
}

cmd_update() {
  require_jq_for_write
  local id="${1:-}"
  require_arg "<spreadsheetId>" "$id"
  shift
  local range="" values="" input="" major=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --range) range="${2:-}"; shift 2 ;;
      --values) values="${2:-}"; shift 2 ;;
      --input-option) input="${2:-}"; shift 2 ;;
      --major-dimension) major="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-sheets update: unknown arg: $1" ;;
    esac
  done
  require_arg --range "$range"
  require_arg --values "$values"
  local body
  body="$(build_write_body "$range" "$values" "$input" "$major")"
  google_api PUT "/api/google/sheets/$(urlenc "$id")/values" -d "$body"
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    get) cmd_get "$@" ;;
    values) cmd_values "$@" ;;
    append) cmd_append "$@" ;;
    update) cmd_update "$@" ;;
    -h | --help | help | '') usage; [[ -z "$sub" ]] && exit 2 || exit 0 ;;
    *) google_usage_die "google-sheets: unknown subcommand: $sub" ;;
  esac
}

main "$@"
