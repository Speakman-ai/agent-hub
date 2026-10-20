#!/bin/sh
# Stand-in for the claude / cursor-agent / codex / gemini CLIs on the organization
# acceptance server. It never calls a model: it answers `--version`, reads the prompt and
# replays one canned stream-json turn.
#
# A prompt containing `E2E-PROBE org=<organization> in=<project> out=<project> agent=<agent>`
# makes it act like an organization agent trying its injected capability: an in-scope read,
# an out-of-scope read, an out-of-scope dispatch and a Server admin call. The HTTP status
# codes become the reply, so the transcript records what the server allowed.
for a in "$@"; do
  if [ "$a" = "--version" ] || [ "$a" = "-v" ]; then
    echo "0.0.0-e2e (fake agent CLI)"
    exit 0
  fi
done

input="$*
$(cat 2>/dev/null)"
reply="E2E fake agent: task received."

probe=$(printf '%s\n' "$input" | grep -o 'E2E-PROBE org=[^ ]* in=[^ ]* out=[^ ]* agent=[^ ]*' | tail -n 1)
if [ -n "$probe" ] && [ -n "$AGENT_HUB_URL" ]; then
  org=$(printf '%s' "$probe" | sed 's/.* org=\([^ ]*\).*/\1/')
  in_project=$(printf '%s' "$probe" | sed 's/.* in=\([^ ]*\).*/\1/')
  out_project=$(printf '%s' "$probe" | sed 's/.* out=\([^ ]*\).*/\1/')
  agent=$(printf '%s' "$probe" | sed 's/.* agent=\([^ ]*\).*/\1/')
  base="$AGENT_HUB_URL/api/organizations/$org"
  code() { curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $AGENT_HUB_API_KEY" "$@"; }
  read_in=$(code "$base/context/projects/$in_project/cards")
  read_out=$(code "$base/context/projects/$out_project/cards")
  dispatch_out=$(code -X POST -H 'content-type: application/json' \
    -d "{\"projectId\":\"$out_project\",\"agentId\":\"$agent\",\"prompt\":\"out of scope\",\"idempotencyKey\":\"e2e-probe-$out_project\"}" \
    "$base/dispatches")
  # Outside the organization API surface entirely.
  admin=$(code "$AGENT_HUB_URL/api/auth/users")
  reply="E2E probe: in-scope read $read_in; out-of-scope read $read_out; out-of-scope dispatch $dispatch_out; server admin $admin."
fi

printf '%s\n' '{"type":"system","subtype":"init","session_id":"e2e-fake-cli"}'
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$reply"
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","session_id":"e2e-fake-cli"}\n' "$reply"
exit 0
