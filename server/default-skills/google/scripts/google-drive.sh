#!/usr/bin/env bash
# google-drive.sh — Google Drive via the Hub proxy (scoped to the session owner).
#
#   google-drive.sh list [--q TEXT] [--page-size N] [--page-token TOKEN] [--order-by TEXT]
#   google-drive.sh get  <fileId>
#   google-drive.sh save --file ./report.pdf [--name "Report.pdf"] [--mime-type application/pdf] \
#                        [--folder-id ID] [--description TEXT]
#   google-drive.sh save --file ./notes.txt --as-doc [--name "Notes"] [--mime-type text/plain]
#
# `save` uploads the local file through the Hub. It prints the created Drive
# metadata JSON, including `webViewLink` when Google returns it. `--as-doc`
# converts text-like input into a Google Docs file via Drive's Google Workspace
# MIME conversion path.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

GOOGLE_DOC_MIME_TYPE="application/vnd.google-apps.document"
MAX_UPLOAD_BYTES=$((5 * 1024 * 1024))

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

require_jq_for_write() {
  command -v jq >/dev/null 2>&1 ||
    google_usage_die "google-drive: 'jq' is required to build the request body for this command."
}

cmd_list() {
  local q="" page_size="" page_token="" order_by=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --q) q="${2:-}"; shift 2 ;;
      --page-size) page_size="${2:-}"; shift 2 ;;
      --page-token) page_token="${2:-}"; shift 2 ;;
      --order-by) order_by="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-drive list: unknown arg: $1" ;;
    esac
  done
  local qs=""
  [[ -n "$q" ]] && qs+="q=$(urlenc "$q")"
  [[ -n "$page_size" ]] && qs+="${qs:+&}pageSize=$(urlenc "$page_size")"
  [[ -n "$page_token" ]] && qs+="${qs:+&}pageToken=$(urlenc "$page_token")"
  [[ -n "$order_by" ]] && qs+="${qs:+&}orderBy=$(urlenc "$order_by")"
  google_api GET "/api/google/drive/files${qs:+?$qs}"
}

cmd_get() {
  local id="${1:-}"
  require_arg "<fileId>" "$id"
  google_api GET "/api/google/drive/files/$(urlenc "$id")"
}

cmd_save() {
  require_jq_for_write
  local file="" name="" mime_type="" folder_id="" description="" as_doc="false"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --file) file="${2:-}"; shift 2 ;;
      --name) name="${2:-}"; shift 2 ;;
      --mime-type) mime_type="${2:-}"; shift 2 ;;
      --folder-id) folder_id="${2:-}"; shift 2 ;;
      --description) description="${2:-}"; shift 2 ;;
      --as-doc) as_doc="true"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-drive save: unknown arg: $1" ;;
    esac
  done
  require_arg --file "$file"
  [[ -f "$file" ]] || google_usage_die "google-drive: --file must point to a readable file."
  [[ -r "$file" ]] || google_usage_die "google-drive: --file must point to a readable file."
  [[ -n "$name" ]] || name="$(basename "$file")"
  if [[ -z "$mime_type" ]]; then
    mime_type="$(file --brief --mime-type "$file" 2>/dev/null || true)"
    [[ -n "$mime_type" ]] || mime_type="application/octet-stream"
  fi

  local size
  size="$(wc -c <"$file" | tr -d '[:space:]')"
  if [[ "$size" =~ ^[0-9]+$ && "$size" -gt "$MAX_UPLOAD_BYTES" ]]; then
    google_usage_die "google-drive: uploads are limited to ${MAX_UPLOAD_BYTES} bytes."
  fi

  local encoded_file body_file tmp_file rc=0
  encoded_file="$(mktemp)"
  body_file="$(mktemp)"
  tmp_file="$(mktemp)"

  base64 <"$file" | tr -d '\n' >"$encoded_file"
  jq -n \
    --arg name "$name" \
    --arg mimeType "$mime_type" \
    --rawfile base64Content "$encoded_file" \
    '{name:$name, mimeType:$mimeType, base64Content:$base64Content}' >"$body_file"
  if [[ -n "$folder_id" ]]; then
    jq --arg v "$folder_id" '. + {folderId:$v}' "$body_file" >"$tmp_file"
    mv "$tmp_file" "$body_file"
  fi
  if [[ -n "$description" ]]; then
    jq --arg v "$description" '. + {description:$v}' "$body_file" >"$tmp_file"
    mv "$tmp_file" "$body_file"
  fi
  if [[ "$as_doc" == "true" ]]; then
    jq --arg v "$GOOGLE_DOC_MIME_TYPE" '. + {targetMimeType:$v}' "$body_file" >"$tmp_file"
    mv "$tmp_file" "$body_file"
  fi

  google_api POST "/api/google/drive/files" --data-binary "@$body_file" || rc=$?
  rm -f "$encoded_file" "$body_file" "$tmp_file"
  return "$rc"
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    list) cmd_list "$@" ;;
    get) cmd_get "$@" ;;
    save) cmd_save "$@" ;;
    -h | --help | help | '') usage; [[ -z "$sub" ]] && exit 2 || exit 0 ;;
    *) google_usage_die "google-drive: unknown subcommand: $sub" ;;
  esac
}

main "$@"
