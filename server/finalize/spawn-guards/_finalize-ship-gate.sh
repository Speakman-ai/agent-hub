#!/bin/sh
# Shared Finalize direct-ship gate for spawn PATH wrappers (git push, gh pr create).
_finalize_direct_ship_gate() {
  _cmd_name="$1"
  # Both actions ship through Finalize, including updates to existing PRs.
  _action="${2:-gh_pr_create}"
  if [ -z "${AGENT_HUB_SESSION_ID:-}" ]; then
    return 0
  fi
  if [ -z "${AGENT_HUB_URL:-}" ] || [ -z "${AGENT_HUB_API_KEY:-}" ]; then
    echo "error: ${_cmd_name} blocked: cannot verify shipping policy. Commit locally and use Finalize Code Changes." >&2
    return 2
  fi
  _resp=$(
    curl -sS -m 12 -H "x-api-key: $AGENT_HUB_API_KEY" \
      "$AGENT_HUB_URL/api/sessions/${AGENT_HUB_SESSION_ID}/finalize-ship-gate?action=${_action}" 2>/dev/null
  ) || {
    echo "error: ${_cmd_name} blocked: shipping policy lookup failed. Commit locally and use Finalize Code Changes." >&2
    return 2
  }
  _msg=$(printf '%s' "$_resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('message','Finalize ship gate blocked direct ship.'))" 2>/dev/null) \
    || _msg="Finalize ship gate blocked direct ship."
  cat >&2 <<GATE
error: ${_cmd_name} blocked: ${_msg}

Commit locally; the operator or session automation ships via **Finalize Code Changes**
and **Push** on the session, even without a CI config.

Gate API: GET $AGENT_HUB_URL/api/sessions/$AGENT_HUB_SESSION_ID/finalize-ship-gate
GATE
  return 2
}
