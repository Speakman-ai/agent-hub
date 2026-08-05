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
#   HUB_ENV_FILE             absolute path of the .env to upsert into (required)
#   HUB_ENV_DESIRED_B64      base64 of the desired KEY=VALUE lines (required)
#   HUB_ENV_MANAGED_KEYS_B64 base64 of the managed-key inventory, one key per line
#                            (optional; removal of stale keys is skipped without it)
#   HUB_ENV_RUNTIME_KEYS_B64 base64 of the keys that stay set in the container
#                            after removal because something other than .env
#                            supplies them (docker run -e, image ENV). Optional;
#                            they are exempted from the retraction check.
#   HUB_ENV_CONTAINER        docker container to verify against (default agenthub-server)
#   HUB_ENV_SERVICE          systemd unit to restart (default agenthub-server)
#
# Behaviour:
#   - Upserts each desired key: replaced in place when present (position kept),
#     appended when absent. Values reach awk through ENVIRON and are never
#     spliced into a regex nor passed with `awk -v`, so they survive byte for
#     byte: & | / in URLs are safe, and so are backslashes, which `awk -v` would
#     expand as escape sequences.
#   - Removes any inventory key the desired set no longer carries. Terraform
#     omits a feature's keys entirely once the feature is disabled, so without
#     this the live host keeps running on the old setting (e.g. a stale
#     FINALIZE_RUNNER_BACKEND=remote) while the sync reports nothing changed.
#     Only keys in the inventory are eligible, and the inventory excludes secret
#     and UI-owned keys, so hand-added and app-owned lines survive untouched.
#   - Idempotent: if the result is byte-identical AND the container already
#     agrees with it, the file is left untouched, no backup is made, and the
#     service is NOT restarted. The release pipeline runs this every time, so a
#     no-op must cost nothing.
#   - Self-healing: a byte-identical file is NOT proof the Hub is running that
#     file. A previous sync may have rewritten it and then failed to recreate the
#     container, leaving a retracted key live in the process; exiting on the file
#     comparison alone would turn that failure into a green release on the next
#     run. When the file matches but the container does not, the service is
#     restarted to converge and then verified (RESULT=converged).
#   - Verifies after every restart that the container was RECREATED (docker fixes
#     a container's environment at creation, so a restart that reuses the existing
#     container silently keeps the old env), that every desired key is present
#     with the desired VALUE, and that every owned key absent from the desired set
#     is gone from the container. Without the last check a retraction-only release
#     passes trivially: no desired value changed, so a presence/value sweep of
#     the desired keys sees nothing wrong while the disabled feature's variables
#     are still live in the process.
#   - Prints key names and RESULT=changed|unchanged|converged only. Never values:
#     the output is surfaced in a public repo's Actions log.
#
# Exit: 0 on success, 1 on failure (missing file, restart failure, container not
# recreated, key absent, key carrying its old value, or key still set after
# retraction).

set -euo pipefail

ENV_FILE="${HUB_ENV_FILE:-}"
DESIRED_B64="${HUB_ENV_DESIRED_B64:-}"
MANAGED_KEYS_B64="${HUB_ENV_MANAGED_KEYS_B64:-}"
RUNTIME_KEYS_B64="${HUB_ENV_RUNTIME_KEYS_B64:-}"
CONTAINER="${HUB_ENV_CONTAINER:-agenthub-server}"
SERVICE="${HUB_ENV_SERVICE:-agenthub-server}"

if [ -z "$ENV_FILE" ]; then
  echo "FATAL: HUB_ENV_FILE is required" >&2
  exit 1
fi

# An empty desired set is legitimate ONLY alongside an inventory: that is the
# "every managed feature was turned off" case, where the whole job is to retract
# the keys the host still carries. Empty with no inventory is a caller bug.
if [ -z "$DESIRED_B64" ] && [ -z "$MANAGED_KEYS_B64" ]; then
  echo "FATAL: HUB_ENV_DESIRED_B64 or HUB_ENV_MANAGED_KEYS_B64 is required" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: $ENV_FILE does not exist on this host" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

: >"$WORK/desired"
if [ -n "$DESIRED_B64" ]; then
  printf '%s' "$DESIRED_B64" | base64 -d >"$WORK/desired"
fi
: >"$WORK/runtime.keys"
if [ -n "$RUNTIME_KEYS_B64" ]; then
  printf '%s' "$RUNTIME_KEYS_B64" | base64 -d >"$WORK/runtime.keys"
fi
cp "$ENV_FILE" "$WORK/next"
: >"$WORK/desired.keys"
: >"$WORK/absent.keys"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac

  # Require the separator BEFORE deriving either half. Neither expansion below
  # can signal "no match": on a bare `FOO`, "${line%%=*}" and "${line#*=}" both
  # return the whole string, so the line would be silently written as `FOO=FOO`
  # rather than rejected. This script is directly invocable and is the last
  # validation boundary before the file the Hub boots from, so it validates
  # rather than assuming the caller did.
  #
  # Errors withhold the content: on a line with no `=` that content IS the whole
  # line, and on a base64 value ending in `=` padding the "key" is the secret.
  # This output lands in a public CI log.
  case "$line" in
    *=*) ;;
    *)
      echo "FATAL: malformed desired env line (no '=' separator); content withheld, it may contain a secret" >&2
      exit 1
      ;;
  esac

  key="${line%%=*}"
  val="${line#*=}"
  if ! printf '%s' "$key" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
    echo "FATAL: malformed desired env line (key is not a valid identifier); content withheld, it may contain a secret" >&2
    exit 1
  fi
  # Both operands travel through the ENVIRON array, never through `awk -v`.
  # POSIX awk expands escape sequences in a -v assignment, so a value holding
  # `C:\path\to\new` would be rewritten with a tab and a literal newline: not
  # merely a wrong value, but a line split in two that injects a bogus key into
  # .env. ENVIRON is the byte-exact path. (The key is a validated identifier and
  # could not contain a backslash, but routing it the same way keeps the
  # guarantee from depending on that validation staying in place.)
  HUB_ENV_UPSERT_KEY="$key" HUB_ENV_UPSERT_VAL="$val" awk '
    BEGIN { k = ENVIRON["HUB_ENV_UPSERT_KEY"]; v = ENVIRON["HUB_ENV_UPSERT_VAL"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$WORK/next" >"$WORK/next.tmp"
  mv "$WORK/next.tmp" "$WORK/next"
  printf '%s\n' "$key" >>"$WORK/desired.keys"
  echo "managed $key"
done <"$WORK/desired"

# Retract managed keys Terraform stopped emitting. Skipped entirely when no
# inventory was supplied, so an older caller degrades to upsert-only rather than
# deleting lines it never claimed to own.
if [ -n "$MANAGED_KEYS_B64" ]; then
  printf '%s' "$MANAGED_KEYS_B64" | base64 -d >"$WORK/inventory"
  while IFS= read -r ikey || [ -n "$ikey" ]; do
    case "$ikey" in '' | '#'*) continue ;; esac
    # Validate the entry AS WRITTEN; do not normalise it. This list drives
    # DELETION, so quietly truncating `FOO=bar` to `FOO` would take a key the
    # caller never named and remove it from the live .env. A malformed entry
    # means the payload is wrong, and guessing which key was meant is the one
    # response that can cause damage. Content is withheld for the same reason as
    # the desired lines: this output reaches a public CI log.
    if ! printf '%s' "$ikey" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
      echo "FATAL: malformed managed-key inventory entry (expected a bare KEY name, one per line); content withheld, it may contain a secret" >&2
      exit 1
    fi
    if grep -qxF "$ikey" "$WORK/desired.keys"; then
      continue
    fi
    HUB_ENV_UPSERT_KEY="$ikey" awk '
      BEGIN { k = ENVIRON["HUB_ENV_UPSERT_KEY"] }
      index($0, k "=") == 1 { next }
      { print }
    ' "$WORK/next" >"$WORK/next.tmp"
    if ! cmp -s "$WORK/next.tmp" "$WORK/next"; then
      echo "removed $ikey"
    fi
    mv "$WORK/next.tmp" "$WORK/next"
    # Must be gone from the CONTAINER too, whether or not this run was the one
    # that took it out of the file. Keying this off "what we edited just now"
    # would miss a .env that a previous (failed) sync already cleaned up.
    if grep -qxF "$ikey" "$WORK/runtime.keys"; then
      echo "exempt $ikey (supplied outside $ENV_FILE)"
    else
      printf '%s\n' "$ikey" >>"$WORK/absent.keys"
    fi
  done <"$WORK/inventory"
fi

# Populates MISSING / STALE / STILL_SET; returns 0 only when all three are empty.
# Read the container, never the file: the file agreeing with Terraform proves
# nothing about the process that is actually serving traffic.
container_matches() {
  MISSING=""
  STALE=""
  STILL_SET=""

  # Present AND correct. Comparing values is what proves .env reached the running
  # process, since a key can be present but stale.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    _key="${line%%=*}"
    _want="${line#*=}"
    # printenv exits non-zero only when the key is unset; an empty value is a
    # legitimate success, so presence and value are two separate verdicts.
    if ! _got="$(docker exec "$CONTAINER" printenv "$_key" 2>/dev/null)"; then
      MISSING="$MISSING $_key"
    elif [ "$_got" != "$_want" ]; then
      STALE="$STALE $_key"
    fi
  done <"$WORK/desired"

  # Retracted keys must actually be gone. This is the only check that covers a
  # release whose entire change is a removal (disable a feature, nothing else
  # moves): every desired key still matches, so the loop above stays silent while
  # the feature's variables are still set in the process.
  while IFS= read -r _key || [ -n "$_key" ]; do
    case "$_key" in '') continue ;; esac
    if docker exec "$CONTAINER" printenv "$_key" >/dev/null 2>&1; then
      STILL_SET="$STILL_SET $_key"
    fi
  done <"$WORK/absent.keys"

  [ -z "$MISSING" ] && [ -z "$STALE" ] && [ -z "$STILL_SET" ]
}

report_drift() {
  _level="$1"
  [ -z "$MISSING" ] || echo "$_level: managed keys absent from the container:$MISSING" >&2
  [ -z "$STALE" ] || echo "$_level: managed keys carry a different value in the container:$STALE" >&2
  [ -z "$STILL_SET" ] || echo "$_level: retracted keys are still set in the container:$STILL_SET" >&2
}

# Restart, wait for the container, then prove the new environment took. Callers
# set WROTE_AT first so the recreation check has a reference point.
restart_and_verify() {
  systemctl restart "$SERVICE"
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; then
      break
    fi
    sleep 2
  done
  systemctl is-active "$SERVICE"

  # A container's environment is fixed when it is CREATED. If the unit restarted
  # the existing container instead of recreating it, NOTHING in .env applied, so
  # establish that first: it is the invariant every per-key check rests on, and a
  # retraction-only run against a reused container can look clean key by key.
  CREATED="$(docker inspect -f '{{.Created}}' "$CONTAINER" 2>/dev/null || true)"
  CREATED_AT=""
  if [ -n "$CREATED" ]; then
    CREATED_AT="$(date -u -d "$CREATED" +%s 2>/dev/null || true)"
  fi
  if [ -n "$CREATED_AT" ] && [ "$CREATED_AT" -lt "$((WROTE_AT - 2))" ]; then
    echo "FATAL: $CONTAINER was created at $CREATED, before this run wrote $ENV_FILE." >&2
    echo "Restarting $SERVICE reused the existing container instead of recreating it; docker fixes env at creation, so no --env-file change applied. Make the unit recreate the container (docker rm -f + docker run, or compose up --force-recreate)." >&2
    exit 1
  fi
  if [ -z "$CREATED_AT" ]; then
    echo "WARN: could not read the creation time of $CONTAINER; relying on the per-key checks below." >&2
  fi

  if container_matches; then
    echo "OK: $CONTAINER was recreated, desired keys carry the expected values, and retracted keys are gone"
    return 0
  fi
  report_drift FATAL
  # The container was recreated (asserted above), so .env is not the source.
  # Values are never printed; the key names are the whole diagnostic.
  echo "FATAL: $CONTAINER was recreated, so these keys are pinned outside $ENV_FILE (an -e flag on the run command or an image ENV line beats --env-file). Fix them at that source, or add them to the runtime-injected key list if they belong there." >&2
  exit 1
}

# Nothing to write. That is NOT the same as nothing to do: a previous sync may
# have rewritten the file and then failed to recreate the container, leaving a
# retracted key still live in the process. Exiting on the file comparison alone
# turns that failure into a green release on the next run, so the container gets
# checked before we call it a no-op.
if cmp -s "$WORK/next" "$ENV_FILE"; then
  if container_matches; then
    echo "RESULT=unchanged"
    echo "Managed env matches Terraform and so does $CONTAINER; not restarting $SERVICE."
    exit 0
  fi

  echo "RESULT=converged"
  echo "$ENV_FILE already matches Terraform but $CONTAINER does not:"
  report_drift WARN
  echo "A previous sync likely wrote the file without recreating the container; restarting $SERVICE to converge."
  WROTE_AT="$(date -u +%s)"
  restart_and_verify
  exit 0
fi

cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
# Write through the existing inode so owner and mode survive.
cat "$WORK/next" >"$ENV_FILE"
echo "RESULT=changed"

# Recorded before the restart so the recreation check has a reference point.
# Allow a couple of seconds of slack for clock granularity between `date` here
# and the daemon's own Created stamp.
WROTE_AT="$(date -u +%s)"
restart_and_verify
