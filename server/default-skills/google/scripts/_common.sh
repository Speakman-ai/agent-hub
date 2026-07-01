#!/usr/bin/env bash
# scripts/_common.sh — shared helpers for the `google` skill wrappers
# (google-cal.sh, google-mail.sh, google-sheets.sh).
#
# Source, don't exec:
#
#     DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$DIR/_common.sh"
#
# Every wrapper talks to the Hub's server-side Google proxy under
# `/api/google/*`. The proxy holds the OAuth tokens (encrypted at rest) and
# resolves the acting user to the SESSION OWNER, so wrappers never see a Google
# access token — they only send the Hub `x-api-key` plus the session id.
#
# Auth resolution reuses the agent-hub skill's `ah-api.sh` (single source of
# truth: env key → per-session spawn-creds file → config.json apiKey). We layer
# a friendly-error mapper on top so a missing Google connection produces a clear
# "not linked → Settings → Account → Google" message instead of a raw 401.
#
# Exposes:
#   google_api METHOD PATH [curl args…]   → calls the proxy, echoes JSON on 2xx,
#                                            prints a clear error + exit 3 on 4xx/5xx
#   gq KEY [JSON]                          → tiny jq-or-fallback field reader
#   require_arg NAME VALUE                 → abort (exit 2) if VALUE is empty
#   google_usage_die MESSAGE               → print usage + exit 2

set -euo pipefail

: "${AGENT_HUB_URL:=http://localhost:3051}"

# ── Locate ah-api.sh (shipped by the bundled agent-hub skill) ────────────
# Prefer PATH (the server prepends the agent-hub skill's scripts/ dir), then
# $AGENT_HUB_SKILLS_DIR/scripts. Sourcing is safe: ah-api.sh guards its CLI
# frontend with `BASH_SOURCE[0] == $0`, so it only defines functions here.
_google_ah_api_path() {
  if command -v ah-api.sh >/dev/null 2>&1; then
    command -v ah-api.sh
    return 0
  fi
  local cand
  for cand in \
    "${AGENT_HUB_SKILLS_DIR:-}/scripts/ah-api.sh" \
    "$HOME/.agent-hub/skills/agent-hub/scripts/ah-api.sh"; do
    [[ -n "$cand" && -r "$cand" ]] && {
      printf '%s' "$cand"
      return 0
    }
  done
  return 1
}

_GOOGLE_AH_API="$(_google_ah_api_path || true)"
if [[ -n "$_GOOGLE_AH_API" ]]; then
  # shellcheck source=/dev/null
  source "$_GOOGLE_AH_API"
fi

# ah_resolve_key comes from ah-api.sh. Fall back to the env var alone if the
# wrapper could not be located (degraded, but still functional in a spawn that
# injects AGENT_HUB_API_KEY).
if ! declare -f ah_resolve_key >/dev/null 2>&1; then
  ah_resolve_key() { printf '%s' "${AGENT_HUB_API_KEY:-}"; }
fi

# gq KEY [JSON] — read a top-level string field from a JSON blob. Uses jq when
# present, else a forgiving sed fallback (good enough for the flat `code`/`error`
# fields the proxy returns). Reads stdin when JSON is omitted.
gq() {
  local key="$1"
  local json="${2:-$(cat)}"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r --arg k "$key" '.[$k] // empty' 2>/dev/null || true
    return 0
  fi
  printf '%s' "$json" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

# _google_explain_error HTTP_CODE BODY — print an actionable message to stderr
# for the well-known proxy error codes (so agents get "link your account",
# not an opaque 401).
_google_explain_error() {
  local http_code="$1"
  local body="$2"
  local code
  code="$(gq code "$body")"

  case "$code" in
    google_not_connected | authentication_required)
      echo "google: the session owner has not linked a Google account." >&2
      echo "google: link it under Settings → Account → Google, then retry." >&2
      ;;
    google_oauth_not_configured)
      echo "google: Google OAuth is not configured on this Hub." >&2
      echo "google: an Owner/Admin must add the Google client id/secret in server settings." >&2
      ;;
    google_reconnect_required)
      echo "google: the session owner's Google connection expired or was revoked." >&2
      echo "google: re-link it under Settings → Account → Google, then retry." >&2
      ;;
    google_calendar_scope_required | google_gmail_scope_required | \
      google_gmail_send_scope_required | google_sheets_scope_required | \
      google_sheets_write_scope_required | google_drive_scope_required)
      local surface="this Google surface"
      case "$code" in
        google_calendar_*) surface="Google Calendar" ;;
        google_gmail_*) surface="Gmail" ;;
        google_sheets_*) surface="Google Sheets" ;;
        google_drive_*) surface="Google Drive" ;;
      esac
      echo "google: ${surface} access has not been granted for the session owner." >&2
      echo "google: enable it under Settings → Account → Google (incremental consent)." >&2
      ;;
    *)
      echo "google: request failed (HTTP ${http_code})." >&2
      if [[ -n "$body" ]]; then
        local msg
        msg="$(gq error "$body")"
        [[ -n "$msg" ]] && echo "google: ${msg}" >&2 || echo "$body" >&2
      fi
      ;;
  esac
}

# google_api METHOD PATH [curl args…]
# Sends an authenticated request to the Hub Google proxy. On 2xx the raw JSON
# body goes to stdout (exit 0). On any other status the friendly error goes to
# stderr and the function returns 3. Connection failures return 7.
google_api() {
  if [[ $# -lt 2 ]]; then
    echo "google_api: usage: google_api <METHOD> <PATH> [curl args…]" >&2
    return 2
  fi
  local method="$1"
  shift
  local path="$1"
  shift

  local key
  key="$(ah_resolve_key)"

  local headers=(-H 'Content-Type: application/json' -H 'Accept: application/json')
  [[ -n "$key" ]] && headers+=(-H "x-api-key: $key")
  # Attach the acting session id so the proxy resolves the SESSION OWNER's
  # Google connection even on the global break-glass apiKey (which carries no
  # per-user identity). Harmless when a per-user/spawn key already identifies us.
  [[ -n "${AGENT_HUB_SESSION_ID:-}" ]] && headers+=(-H "X-Agent-Hub-Session-Id: $AGENT_HUB_SESSION_ID")

  local body_file http_code curl_rc=0
  body_file="$(mktemp)"
  # Capture curl's EXIT CODE separately from the %{http_code} it writes to
  # stdout. Do NOT use `|| echo 000`: on a connection failure curl already
  # prints `000` for %{http_code} AND exits non-zero, so appending another
  # `000` yields `000000` — which fails the `== 000` test and misreports a
  # network error as a proxy error. `|| curl_rc=$?` keeps set -e happy while
  # preserving curl's real exit code.
  http_code="$(
    curl -sS -X "$method" \
      "${headers[@]}" \
      -o "$body_file" \
      -w '%{http_code}' \
      "${AGENT_HUB_URL}${path}" \
      "$@" 2>/dev/null
  )" || curl_rc=$?
  local body
  body="$(cat "$body_file" 2>/dev/null || true)"
  rm -f "$body_file"

  # A non-zero curl exit is a transport failure (connection refused, DNS,
  # timeout, TLS…); curl reports `000` for %{http_code} in that case. We never
  # pass --fail, so a real HTTP 4xx/5xx keeps curl exit 0 and flows through the
  # status path below. Branch on the exit code (not a body string match) so
  # exit 7 "unreachable Hub" stays distinguishable from a proxy 4xx/5xx.
  if [[ "$curl_rc" -ne 0 || "$http_code" == "000" || -z "$http_code" ]]; then
    echo "google: could not reach the Hub at ${AGENT_HUB_URL} (connection failed; curl exit ${curl_rc})." >&2
    return 7
  fi
  if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
    printf '%s\n' "$body"
    return 0
  fi
  _google_explain_error "$http_code" "$body"
  return 3
}

require_arg() {
  local name="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "google: missing required argument: $name" >&2
    exit 2
  fi
}

google_usage_die() {
  echo "$*" >&2
  exit 2
}

# urlenc STRING — percent-encode a query value (uses jq when available).
urlenc() {
  local s="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$s" | jq -sRr @uri
    return 0
  fi
  local out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}
