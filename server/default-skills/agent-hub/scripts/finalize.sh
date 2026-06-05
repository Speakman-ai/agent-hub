#!/usr/bin/env bash
# scripts/finalize.sh — read Finalize Code Changes run state + CI step logs.
#
# WHY THIS EXISTS: a spawned agent has NO access to the web "session strip",
# so when a Finalize step fails you cannot "look at the screen". The §7 fix
# dispatch only embeds a truncated tail of the ONE step the orchestrator
# picked. Use this wrapper to pull the real, full output of any/every failed
# step from the Finalize REST API.
#
# Subcommands:
#   latest                       Latest run for THIS session + per-step state
#                                table (index, state, exit code, job, name).
#   failed [runId]               Dump full log lines for EVERY failed/errored
#                                step of the latest run (or a given runId if it
#                                is the latest). The common case.
#   output <stepIndex> [runId]   Full log lines for one step. runId defaults
#                                to the latest run for this session.
#   raw                          Raw JSON of the latest-run endpoint.
#
# Env (resolved by _common.sh / ah-api.sh):
#   AGENT_HUB_SESSION_ID   required — the session whose run you are reading.
#   PROJECT_ID             required for `output` / `failed` (project-scoped
#                          step-output endpoint).
#
# Endpoints wrapped:
#   GET /api/sessions/:sessionId/finalize-runs/latest
#   GET /api/projects/:projectId/finalize/:runId/steps/:stepIndex/output

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

_need_python() {
  command -v python3 >/dev/null 2>&1 || usage_die \
    "error: finalize.sh needs python3 to parse JSON responses."
}

# Fetch the latest-run JSON for this session (raw, to stdout).
_latest_json() {
  require_var AGENT_HUB_SESSION_ID
  hub_api GET "/api/sessions/$AGENT_HUB_SESSION_ID/finalize-runs/latest"
}

# Echo the latest run id for this session (empty if no run yet).
_latest_run_id() {
  _need_python
  FINALIZE_JSON="$(_latest_json)" python3 <<'PY'
import json, os, sys
d = json.loads(os.environ.get("FINALIZE_JSON") or "{}")
run = d.get("run") or {}
sys.stdout.write(run.get("id") or "")
PY
}

# Print log lines for one step of a run. Args: <runId> <stepIndex>.
_print_step_output() {
  local runid="$1" step="$2"
  require_var PROJECT_ID
  FINALIZE_JSON="$(hub_api GET "/api/projects/$PROJECT_ID/finalize/$runid/steps/$step/output")" \
    python3 <<'PY'
import json, os, sys
d = json.loads(os.environ.get("FINALIZE_JSON") or "{}")
lines = d.get("lines") or []
if not lines:
    sys.stderr.write("(no captured output for this step)\n")
for ln in lines:
    prefix = "E " if ln.get("stream") == "stderr" else "  "
    sys.stdout.write(prefix + (ln.get("text") or "") + "\n")
PY
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  latest)
    _need_python
    FINALIZE_JSON="$(_latest_json)" python3 <<'PY'
import json, os, sys
d = json.loads(os.environ.get("FINALIZE_JSON") or "{}")
run = d.get("run")
steps = d.get("steps") or []
if not run:
    print("No Finalize run for this session yet.")
    sys.exit(0)
head = (run.get("head_sha") or "")[:9]
print(f'run {run.get("id")}  status={run.get("status")}  phase={run.get("phase")}  head={head}')
print(f'{"idx":>3}  {"state":<8} {"exit":>4}  {"job":<14} name')
for s in steps:
    ec = s.get("exitCode")
    ec = "-" if ec is None else str(ec)
    job = s.get("jobId") or "-"
    print(f'{s.get("index"):>3}  {s.get("state"):<8} {ec:>4}  {job:<14} {s.get("name")}')
failed = [s for s in steps if s.get("state") in ("failed", "error")]
if failed:
    idxs = ",".join(str(s.get("index")) for s in failed)
    print()
    print(f"{len(failed)} failed step(s): index {idxs}")
    print("Run: finalize.sh failed   (full logs for every failed step)")
    print("  or finalize.sh output <stepIndex>")
PY
    ;;

  failed)
    _need_python
    runid="${1:-}"
    latest="$(_latest_json)"
    if [[ -z "$runid" ]]; then
      runid="$(FINALIZE_JSON="$latest" python3 -c 'import json,os; print((json.loads(os.environ.get("FINALIZE_JSON") or "{}").get("run") or {}).get("id") or "")')"
    fi
    [[ -n "$runid" ]] || usage_die "No Finalize run for this session yet."
    # Indexes of failed/errored steps on the latest run.
    mapfile -t failed_idxs < <(FINALIZE_JSON="$latest" python3 <<'PY'
import json, os
d = json.loads(os.environ.get("FINALIZE_JSON") or "{}")
for s in (d.get("steps") or []):
    if s.get("state") in ("failed", "error"):
        print(s.get("index"))
PY
)
    if [[ ${#failed_idxs[@]} -eq 0 ]]; then
      echo "No failed steps on the latest run ($runid)."
      exit 0
    fi
    for idx in "${failed_idxs[@]}"; do
      echo "──────────────────────────────────────────────────────────"
      echo "FAILED step #$idx  (run $runid)"
      echo "──────────────────────────────────────────────────────────"
      _print_step_output "$runid" "$idx"
      echo
    done
    ;;

  output)
    step="${1:-}"
    [[ -n "$step" ]] || usage_die "usage: finalize.sh output <stepIndex> [runId]"
    case "$step" in
      ''|*[!0-9]*) usage_die "stepIndex must be a positive integer" ;;
    esac
    runid="${2:-}"
    if [[ -z "$runid" ]]; then
      runid="$(_latest_run_id)"
      [[ -n "$runid" ]] || usage_die "No Finalize run for this session yet."
    fi
    _print_step_output "$runid" "$step"
    ;;

  raw)
    _latest_json
    ;;

  help|-h|--help|'')
    cat <<EOF
usage: finalize.sh <subcommand> [args]

  latest                      latest run for this session + per-step state table
  failed [runId]              full logs for EVERY failed step of the latest run
  output <stepIndex> [runId]  full logs for one step (runId defaults to latest)
  raw                         raw JSON of the latest-run endpoint

A spawned agent has no web session strip — this is how you read why a
Finalize step failed. Requires AGENT_HUB_SESSION_ID; output/failed also
require PROJECT_ID.
EOF
    ;;

  *)
    usage_die "unknown subcommand: $cmd (try finalize.sh help)"
    ;;
esac
