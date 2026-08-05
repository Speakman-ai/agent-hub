#!/usr/bin/env bash
#
# hub-env-upsert.remote.sh — HOST side of the Hub env sync.
#
# Runs on the Agent Hub instance (as root, via SSM RunShellScript) with its
# inputs supplied as environment variables. `ops/scripts/sync-hub-env.sh` sends
# this file as the SSM payload; it is a separate file rather than a heredoc so it
# can be executed directly by tests (server/hub-env-upsert.test.ts) against a
# throwaway .env with stubbed systemctl/docker.
#
# Inputs (env):
#   HUB_ENV_FILE         absolute path of the .env to upsert into (required)
#   HUB_ENV_DESIRED_B64  base64 of the desired KEY=VALUE lines (required)
#   HUB_ENV_CONTAINER    docker container to verify against (default agenthub-server)
#   HUB_ENV_SERVICE      systemd unit to restart (default agenthub-server)
#
# Behaviour:
#   - Upserts each desired key: replaced in place when present (position kept),
#     appended when absent. Values are handed to awk as a variable, never spliced
#     into a regex, so & | / in URLs are safe.
#   - Idempotent: if the result is byte-identical the file is left untouched, no
#     backup is made, and the service is NOT restarted. The release pipeline runs
#     this every time, so a no-op must cost nothing.
#   - Prints key names and RESULT=changed|unchanged only. Never values: the
#     output is surfaced in a public repo's Actions log.
#
# Exit: 0 on success, 1 on failure (missing file, restart failure, key absent).

set -euo pipefail

ENV_FILE="${HUB_ENV_FILE:-}"
DESIRED_B64="${HUB_ENV_DESIRED_B64:-}"
CONTAINER="${HUB_ENV_CONTAINER:-agenthub-server}"
SERVICE="${HUB_ENV_SERVICE:-agenthub-server}"

if [ -z "$ENV_FILE" ] || [ -z "$DESIRED_B64" ]; then
  echo "FATAL: HUB_ENV_FILE and HUB_ENV_DESIRED_B64 are required" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: $ENV_FILE does not exist on this host" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

printf '%s' "$DESIRED_B64" | base64 -d >"$WORK/desired"
cp "$ENV_FILE" "$WORK/next"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  awk -v k="$key" -v v="$val" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$WORK/next" >"$WORK/next.tmp"
  mv "$WORK/next.tmp" "$WORK/next"
  echo "managed $key"
done <"$WORK/desired"

if cmp -s "$WORK/next" "$ENV_FILE"; then
  echo "RESULT=unchanged"
  echo "Managed env already matches Terraform; not restarting $SERVICE."
  exit 0
fi

cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
# Write through the existing inode so owner and mode survive.
cat "$WORK/next" >"$ENV_FILE"
echo "RESULT=changed"

systemctl restart "$SERVICE"
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; then
    break
  fi
  sleep 2
done
systemctl is-active "$SERVICE"

MISSING=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  key="${line%%=*}"
  if ! docker exec "$CONTAINER" printenv "$key" >/dev/null 2>&1; then
    MISSING="$MISSING $key"
  fi
done <"$WORK/desired"

if [ -n "$MISSING" ]; then
  echo "FATAL: managed keys absent from the running container:$MISSING" >&2
  exit 1
fi

echo "OK: all managed keys present in $CONTAINER"
