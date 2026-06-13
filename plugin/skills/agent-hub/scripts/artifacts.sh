#!/usr/bin/env bash
# scripts/artifacts.sh — manage a session's artifacts (agent-generated
# documents: PDFs, scripts, reports, …). Files you upload here appear in the
# session's Artifacts panel, where the user can view and download them — and
# you can read them back too.
#
# Usage:
#   artifacts.sh put <file> [display-name]   Upload <file> as an artifact.
#   artifacts.sh list                        List this session's artifacts (JSON).
#   artifacts.sh get <artifactId> [outfile]  Download an artifact's bytes
#                                            (to <outfile>, else stdout).
#   artifacts.sh delete <artifactId>         Delete an artifact.
#
# Everything is scoped to $AGENT_HUB_SESSION_ID (injected by the server at
# spawn). Auth is resolved through ah-api.sh (no hard-coded key reads).
#
# Environment:
#   AGENT_HUB_URL         (default http://localhost:3051)
#   AGENT_HUB_SESSION_ID  required — the current session
#   AGENT_HUB_AGENT_ID    optional — stamped as the artifact's creator
#
# Examples:
#   artifacts.sh put ./report.pdf
#   artifacts.sh put ./out/build.log "nightly build log"
#   artifacts.sh list
#   artifacts.sh get 6f1c… ./downloaded.pdf

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "error: $*" >&2
  exit 2
}

require_session() {
  [[ -n "${AGENT_HUB_SESSION_ID:-}" ]] || die "AGENT_HUB_SESSION_ID must be set (injected by the server at spawn)"
}

mime_of() {
  local f="$1"
  if command -v file >/dev/null 2>&1; then
    file --mime-type -b "$f" 2>/dev/null || echo 'application/octet-stream'
  else
    echo 'application/octet-stream'
  fi
}

cmd_put() {
  require_session
  local file="${1:-}"
  [[ -n "$file" ]] || die "put: <file> is required"
  [[ -f "$file" ]] || die "put: no such file: $file"
  local name="${2:-$(basename "$file")}"
  local ctype
  ctype="$(mime_of "$file")"

  local key
  key="$(ah_resolve_key)"
  local auth_args=()
  [[ -n "$key" ]] && auth_args+=(-H "x-api-key: $key")
  local agent_args=()
  [[ -n "${AGENT_HUB_AGENT_ID:-}" ]] && agent_args+=(-H "x-agent-id: $AGENT_HUB_AGENT_ID")

  local body_file http_code
  body_file="$(mktemp)"
  http_code="$(
    curl -sS -X POST \
      "${auth_args[@]}" \
      "${agent_args[@]}" \
      -H "Content-Type: $ctype" \
      -H "x-filename: $name" \
      --data-binary @"$file" \
      -o "$body_file" \
      -w '%{http_code}' \
      "${AGENT_HUB_URL}/api/sessions/${AGENT_HUB_SESSION_ID}/artifacts" || echo "000"
  )"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "artifacts: upload failed (HTTP ${http_code})" >&2
    [[ -s "$body_file" ]] && cat "$body_file" >&2 && echo >&2
    rm -f "$body_file"
    exit 22
  fi
  cat "$body_file"
  echo
  rm -f "$body_file"
}

cmd_list() {
  require_session
  hub_api GET "/api/sessions/${AGENT_HUB_SESSION_ID}/artifacts"
}

cmd_get() {
  require_session
  local id="${1:-}"
  [[ -n "$id" ]] || die "get: <artifactId> is required"
  local out="${2:-}"
  local key
  key="$(ah_resolve_key)"
  local auth_args=()
  [[ -n "$key" ]] && auth_args+=(-H "x-api-key: $key")
  local url="${AGENT_HUB_URL}/api/sessions/${AGENT_HUB_SESSION_ID}/artifacts/${id}/content?download=1"
  if [[ -n "$out" ]]; then
    curl -fsSL "${auth_args[@]}" -o "$out" "$url"
    echo "saved $id -> $out" >&2
  else
    curl -fsSL "${auth_args[@]}" "$url"
  fi
}

cmd_delete() {
  require_session
  local id="${1:-}"
  [[ -n "$id" ]] || die "delete: <artifactId> is required"
  hub_api DELETE "/api/sessions/${AGENT_HUB_SESSION_ID}/artifacts/${id}"
}

case "${1:-}" in
  -h | --help | help)
    usage
    [[ "${1:-}" == "" ]] && exit 2 || exit 0
    ;;
  put)
    shift
    cmd_put "$@"
    ;;
  list)
    shift
    cmd_list "$@"
    ;;
  get)
    shift
    cmd_get "$@"
    ;;
  delete)
    shift
    cmd_delete "$@"
    ;;
  '')
    usage >&2
    exit 2
    ;;
  *)
    die "unknown subcommand: ${1:-} (try --help)"
    ;;
esac
