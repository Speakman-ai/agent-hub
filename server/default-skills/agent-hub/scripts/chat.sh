#!/usr/bin/env bash
# scripts/chat.sh — Agent Hub chat (`/api/chat/*`) wrapper.
#
# Runs as the session owner. Posts from an agent session are shown as written
# by that agent, and stay unread for the owner so they notice them.
#
# Subcommands:
#   channels [--all]                        channels you belong to (--all adds joinable public ones)
#   messages <channel> [--limit N]          recent messages, oldest first
#   post <channel> <body|-> [--ref ...]     post to a channel (joins a public one first)
#   dm <user> <body|-> [--ref ...]          direct-message an org member
#   members                                 org members (userId, username)
#
# <channel> is a channel id, or a name with or without a leading '#'.
# <user> is a username or user id. A body of '-' reads stdin.
# --ref kind:id[=label] appends a ref chip (kinds: user agent session card ticket pr);
# repeat it for several. Bodies may also carry @[label](kind:id) tokens directly.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

_usage() {
  cat <<'EOF'
usage: chat.sh <subcommand> [args]
  channels [--all]
  messages <channel> [--limit N]
  post <channel> <body|-> [--ref kind:id[=label]]...
  dm <user> <body|-> [--ref kind:id[=label]]...
  members

<channel>: channel id, or name (leading '#' optional)
<user>:    username or user id
--ref:     appends a chip, e.g. --ref session:abc123="Fix login"
EOF
}

# json_get <json> <python expr over `d`> — print one value from a JSON doc.
json_get() {
  AH_JSON="$1" AH_EXPR="$2" python3 -c '
import json, os
d = json.loads(os.environ["AH_JSON"])
v = eval(os.environ["AH_EXPR"], {"d": d})
print("" if v is None else v)
'
}

# resolve_channel <ref> — prints "<channelId> <joined:0|1>" or exits 1.
resolve_channel() {
  local ref="$1"
  local mine browse
  mine="$(hub_api GET "/api/chat/channels")"
  browse="$(hub_api GET "/api/chat/channels/browse")"
  AH_REF="$ref" AH_MINE="$mine" AH_BROWSE="$browse" python3 -c '
import json, os, sys
ref = os.environ["AH_REF"].strip()
name = ref[1:] if ref.startswith("#") else ref
mine = json.loads(os.environ["AH_MINE"]).get("channels", [])
browse = json.loads(os.environ["AH_BROWSE"]).get("channels", [])
for joined, rows in ((1, mine), (0, browse)):
    for c in rows:
        if c.get("id") == ref:
            print(c["id"], joined); sys.exit(0)
for joined, rows in ((1, mine), (0, browse)):
    hits = [c for c in rows if (c.get("name") or "").lower() == name.lower() and c.get("kind") != "dm"]
    if len(hits) > 1:
        sys.stderr.write("error: several channels are named %r; pass the channel id\n" % name)
        sys.exit(1)
    if hits:
        print(hits[0]["id"], joined); sys.exit(0)
sys.stderr.write("error: no channel %r (try: chat.sh channels --all)\n" % ref)
sys.exit(1)
'
}

# resolve_user <ref> — prints the org member's user id or exits 1.
resolve_user() {
  local ref="$1"
  local members
  members="$(hub_api GET "/api/chat/members")"
  AH_REF="$ref" AH_MEMBERS="$members" python3 -c '
import json, os, sys
ref = os.environ["AH_REF"].strip().lstrip("@")
rows = json.loads(os.environ["AH_MEMBERS"]).get("members", [])
for m in rows:
    if m.get("userId") == ref or (m.get("username") or "").lower() == ref.lower():
        print(m["userId"]); sys.exit(0)
sys.stderr.write("error: no org member %r (try: chat.sh members)\n" % ref)
sys.exit(1)
'
}

# build_body <body> <ref>... — JSON {"body": ...} with ref tokens appended.
build_body() {
  local body="$1"; shift
  if [[ "$body" == "-" ]]; then body="$(cat)"; fi
  AH_BODY="$body" python3 - "$@" <<'PY'
import json, os, re, sys
KINDS = {"user", "agent", "session", "card", "ticket", "pr"}
body = os.environ["AH_BODY"]
tokens = []
for raw in sys.argv[1:]:
    spec, _, label = raw.partition("=")
    kind, _, target = spec.partition(":")
    if kind not in KINDS or not target:
        sys.stderr.write("error: --ref must look like kind:id[=label] with kind in %s (got %r)\n"
                         % (", ".join(sorted(KINDS)), raw))
        sys.exit(2)
    label = re.sub(r"[\[\]\n\r]", " ", label or target).strip() or target
    tokens.append("@[%s](%s:%s)" % (label, kind, target))
if tokens:
    body = (body.rstrip() + " " + " ".join(tokens)).strip()
if not body.strip():
    sys.stderr.write("error: message body is empty\n")
    sys.exit(2)
print(json.dumps({"body": body}))
PY
}

# parse_post_args <positional...> [--ref ...] — sets POS_ARGS and REF_ARGS.
parse_post_args() {
  POS_ARGS=()
  REF_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref) [[ -n "${2:-}" ]] || usage_die "error: --ref needs kind:id[=label]"; REF_ARGS+=("$2"); shift 2 ;;
      --ref=*) REF_ARGS+=("${1#--ref=}"); shift ;;
      *) POS_ARGS+=("$1"); shift ;;
    esac
  done
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  channels)
    if [[ "${1:-}" == "--all" ]]; then
      mine="$(hub_api GET "/api/chat/channels")"
      browse="$(hub_api GET "/api/chat/channels/browse")"
      AH_MINE="$mine" AH_BROWSE="$browse" python3 -c '
import json, os
mine = json.loads(os.environ["AH_MINE"]).get("channels", [])
browse = json.loads(os.environ["AH_BROWSE"]).get("channels", [])
print(json.dumps({"channels": mine, "joinable": browse}))
'
    else
      hub_api GET "/api/chat/channels"
    fi
    ;;
  messages)
    ref="${1:-}"
    [[ -n "$ref" ]] || usage_die "usage: chat.sh messages <channel> [--limit N]"
    shift
    limit=20
    if [[ "${1:-}" == "--limit" ]]; then limit="${2:-20}"; fi
    [[ "$limit" =~ ^[0-9]+$ ]] || usage_die "error: --limit must be a number"
    read -r channel_id _joined < <(resolve_channel "$ref") || exit 1
    hub_api GET "/api/chat/channels/$channel_id/messages?limit=$limit"
    ;;
  post)
    parse_post_args "$@"
    [[ ${#POS_ARGS[@]} -eq 2 ]] || usage_die "usage: chat.sh post <channel> <body|-> [--ref kind:id[=label]]..."
    payload="$(build_body "${POS_ARGS[1]}" ${REF_ARGS[@]+"${REF_ARGS[@]}"})"
    read -r channel_id joined < <(resolve_channel "${POS_ARGS[0]}") || exit 1
    [[ -n "${channel_id:-}" ]] || exit 1
    if [[ "$joined" == "0" ]]; then
      hub_api POST "/api/chat/channels/$channel_id/join" >/dev/null
    fi
    hub_api POST "/api/chat/channels/$channel_id/messages" -d "$payload"
    ;;
  dm)
    parse_post_args "$@"
    [[ ${#POS_ARGS[@]} -eq 2 ]] || usage_die "usage: chat.sh dm <user> <body|-> [--ref kind:id[=label]]..."
    payload="$(build_body "${POS_ARGS[1]}" ${REF_ARGS[@]+"${REF_ARGS[@]}"})"
    user_id="$(resolve_user "${POS_ARGS[0]}")"
    dm_json="$(hub_api POST "/api/chat/dms" -d "{\"userId\":\"$user_id\"}")"
    channel_id="$(json_get "$dm_json" 'd["channel"]["id"]')"
    hub_api POST "/api/chat/channels/$channel_id/messages" -d "$payload"
    ;;
  members)
    hub_api GET "/api/chat/members"
    ;;
  help|-h|--help|'')
    _usage
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try chat.sh help)"
    ;;
esac
