#!/usr/bin/env bash
#
# finalize-agent-image.sh — resolve and verify the Finalize runner-agent image.
#
# The fleet's tfvars fallback is the mutable `:main` tag, which nothing
# publishes any more. Planning with that fallback silently rolls the fleet back
# to a months-old agent. So Release always passes an explicit image and checks
# the result:
#
#   deployed <state.json>
#       Print the image the runner-agent task definitions use today, read from
#       `terraform show -json` (current state). Release uses this when the image
#       push failed, so a failed push keeps the fleet where it is.
#       Exit 1 when no agent task definition exists or they disagree.
#
#   assert <plan.json> <expected-image-uri>
#       Check every runner-agent task definition in the saved plan
#       (`terraform show -json <planfile>`) uses <expected-image-uri>.
#       Exit 1 on a mismatch or when the plan has no agent task definition.
#
# Covers both the Spot (`agent`) and on-demand (`agent_ondemand`) task
# definitions. Exit 2 = usage / malformed input. Requires: jq.

set -euo pipefail

usage() {
  echo "usage: $0 deployed <state.json> | assert <plan.json> <expected-image-uri>" >&2
  exit 2
}

MODE="${1:-}"
JSON="${2:-}"
[[ -n "${MODE}" && -n "${JSON}" ]] || usage
if [[ ! -r "${JSON}" ]]; then
  echo "error: cannot read JSON: ${JSON}" >&2
  exit 2
fi

case "${MODE}" in
  deployed) ROOT='.values' ;;
  assert) ROOT='.planned_values' ;;
  *) usage ;;
esac

if ! jq -e "${ROOT}" "${JSON}" >/dev/null 2>&1; then
  echo "error: ${JSON} has no ${ROOT#.}; pass \`terraform show -json\` output." >&2
  exit 2
fi

# "<address>\t<image>" for the runner-agent container of every agent task
# definition under ROOT.
IMAGES="$(jq -r "
  [${ROOT} | .. | objects
    | select(.type? == \"aws_ecs_task_definition\" and .mode? == \"managed\")
    | select(.address | test(\"aws_ecs_task_definition\\\\.agent(_ondemand)?(\\\\[[^]]*\\\\])?\$\"))]
  | .[]
  | .address as \$addr
  | (.values.container_definitions // \"[]\" | fromjson)
  | map(select(.name == \"runner-agent\"))
  | if length == 0 then \"\(\$addr)\t<no runner-agent container>\"
    else .[] | \"\(\$addr)\t\(.image // \"<unknown>\")\" end
" "${JSON}")"

if [[ -z "${IMAGES}" ]]; then
  echo "FAIL: no runner-agent task definition found in ${ROOT#.}, so the fleet image cannot be resolved or verified." >&2
  exit 1
fi

if [[ "${MODE}" == "deployed" ]]; then
  DISTINCT="$(cut -f2 <<<"${IMAGES}" | sort -u)"
  if [[ "$(wc -l <<<"${DISTINCT}")" -ne 1 || "${DISTINCT}" == "<"* ]]; then
    echo "FAIL: runner-agent task definitions do not share one known image:" >&2
    echo "${IMAGES}" >&2
    exit 1
  fi
  echo "${DISTINCT}"
  exit 0
fi

EXPECTED="${3:-}"
[[ -n "${EXPECTED}" ]] || usage
status=0
while IFS=$'\t' read -r addr image; do
  if [[ "${image}" == "${EXPECTED}" ]]; then
    echo "ok: ${addr} -> ${image}"
  else
    echo "FAIL: ${addr} plans image ${image}, expected ${EXPECTED}" >&2
    status=1
  fi
done <<<"${IMAGES}"
exit "${status}"
