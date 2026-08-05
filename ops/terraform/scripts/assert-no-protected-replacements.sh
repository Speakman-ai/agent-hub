#!/usr/bin/env bash
#
# assert-no-protected-replacements.sh — fail a pipeline before it destroys the Hub.
#
# The release pipeline applies this stack on every release, so an apply is no
# longer an operator-supervised event. That makes one class of plan unacceptable:
# anything that destroys or replaces the live Hub instance or its data volume.
# A replacement wipes the box (cloud-init re-runs on a fresh root disk) and a
# detach/replace of the data volume risks the SQLite database on it.
#
# Terraform's own guards are necessary but not sufficient:
#   - `prevent_destroy` on the volume attachment errors at plan time, but only
#     for that one resource, and only for a destroy — not for the instance.
#   - `lifecycle.ignore_changes = [ami]` stops the most common replacement
#     trigger, but any future attribute change (subnet, instance_type,
#     user_data with replace_on_change re-added, …) would still plan a replace.
#
# So we assert on the plan itself: given `terraform show -json <planfile>`, exit
# non-zero if any protected address is scheduled for delete. Both orderings of a
# replacement ("delete","create" and the create_before_destroy
# "create","delete") contain "delete", so a single check covers destroy and
# replace alike.
#
# Usage:
#   terraform plan -out=tf.plan ...
#   terraform show -json tf.plan > tf.plan.json
#   ./scripts/assert-no-protected-replacements.sh tf.plan.json [extra.address ...]
#
# Exit codes: 0 = safe, 1 = protected resource would be destroyed/replaced,
#             2 = usage / malformed input.
#
# Requires: jq.

set -euo pipefail

PLAN_JSON="${1:-}"
if [[ -z "${PLAN_JSON}" ]]; then
  echo "usage: $0 <plan.json> [additional protected address ...]" >&2
  exit 2
fi
shift || true

if [[ ! -f "${PLAN_JSON}" ]]; then
  echo "error: plan JSON not found at ${PLAN_JSON}" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required but not installed" >&2
  exit 2
fi

# Stateful, irreplaceable resources. Addresses are matched with any count/for_each
# index stripped, so `aws_ebs_volume.hub_data[0]` matches `aws_ebs_volume.hub_data`.
PROTECTED=(
  aws_instance.app
  aws_ebs_volume.hub_data
  aws_volume_attachment.hub_data
  "$@"
)

# `resource_changes` is absent from a plan with no changes at all; default to [].
if ! jq -e 'has("resource_changes") or has("format_version")' "${PLAN_JSON}" >/dev/null 2>&1; then
  echo "error: ${PLAN_JSON} does not look like 'terraform show -json' output" >&2
  exit 2
fi

PROTECTED_JSON="$(printf '%s\n' "${PROTECTED[@]}" | jq -Rcs 'split("\n") | map(select(length > 0))')"

# Every planned delete, with its index-stripped base address.
DELETES="$(jq -c --argjson protected "${PROTECTED_JSON}" '
  [ (.resource_changes // [])[]
    | select((.change.actions // []) | index("delete"))
    | { address: .address,
        base: (.address | sub("\\[[^]]*\\]$"; "")),
        actions: (.change.actions // []) }
  ]
  | { violations: [ .[] | select(.base as $b | $protected | index($b)) ],
      other:      [ .[] | select(.base as $b | ($protected | index($b)) | not) ] }
' "${PLAN_JSON}")"

VIOLATION_COUNT="$(jq -r '.violations | length' <<<"${DELETES}")"
OTHER_COUNT="$(jq -r '.other | length' <<<"${DELETES}")"

if [[ "${OTHER_COUNT}" != "0" ]]; then
  echo "note: plan destroys/replaces ${OTHER_COUNT} unprotected resource(s):"
  jq -r '.other[] | "  - \(.address) [\(.actions | join(","))]"' <<<"${DELETES}"
fi

if [[ "${VIOLATION_COUNT}" != "0" ]]; then
  echo "" >&2
  echo "FATAL: this plan would destroy or replace protected Hub resource(s):" >&2
  jq -r '.violations[] | "  - \(.address) [\(.actions | join(","))]"' <<<"${DELETES}" >&2
  cat >&2 <<'EOF'

Refusing to apply. A replacement of the Hub instance wipes the host, and a
destroy/replace of the data volume or its attachment risks the live SQLite
database.

If this replacement is genuinely intended, it is an out-of-band operator
action, never a pipeline step:

  1. Confirm what forces the replacement:
       terraform plan -var-file=environments/<env>/<env>.tfvars
  2. Snapshot the data volume first.
  3. Apply the targeted replacement by hand:
       terraform apply -replace=aws_instance.app -var-file=...

If the change is an env-only update, do not replace anything — let the release
pipeline's SSM env sync (ops/scripts/sync-hub-env.sh) adopt it on the running
host.
EOF
  exit 1
fi

echo "OK: no protected Hub resource is destroyed or replaced by this plan."
