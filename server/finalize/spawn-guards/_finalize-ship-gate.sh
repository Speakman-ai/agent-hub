#!/bin/sh
# Shared Finalize direct-ship gate for spawn PATH wrappers (git push, gh pr create).
_finalize_direct_ship_gate() {
  _cmd_name="$1"
  if [ -z "${AGENT_HUB_SESSION_ID:-}" ] || [ -z "${AGENT_HUB_URL:-}" ] || [ -z "${AGENT_HUB_API_KEY:-}" ]; then
    return 0
  fi
  _resp=$(
    curl -sS -m 12 -H "x-api-key: $AGENT_HUB_API_KEY" \
      "$AGENT_HUB_URL/api/sessions/${AGENT_HUB_SESSION_ID}/finalize-ship-gate" 2>/dev/null
  ) || return 0
  _allowed=$(printf '%s' "$_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print('1' if d.get('allowed') else '0')" 2>/dev/null) || return 0
  if [ "$_allowed" = "1" ]; then
    return 0
  fi
  _msg=$(printf '%s' "$_resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('message','Finalize ship gate blocked direct ship.'))" 2>/dev/null) \
    || _msg="Finalize ship gate blocked direct ship."
  cat >&2 <<GATE
error: ${_cmd_name} blocked — ${_msg}

This project uses **Finalize Code Changes** (\`.agent-hub/ci.yaml\`). Commit locally;
the human operator ships via **Finalize Code Changes** → **Push to GitHub** on the session.

Gate API: GET $AGENT_HUB_URL/api/sessions/$AGENT_HUB_SESSION_ID/finalize-ship-gate
GATE
  return 2
}
