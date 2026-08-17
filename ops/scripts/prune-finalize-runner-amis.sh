#!/usr/bin/env bash
#
# Deregister old Finalize runner bake AMIs (and their snapshots), keeping the
# newest KEEP count per fleet.
#
# Non-disruptive: never deletes an AMI that is
#   - the current SSM pin,
#   - the fleet launch template $Default ImageId, or
#   - still attached to a pending/running/stopping/stopped instance
# (so in-flight Finalize jobs on DEV/prod keep their hosts and images).
#
# Usage:
#   FLEET=dev ./ops/scripts/prune-finalize-runner-amis.sh
#   FLEET=prod KEEP=5 ./ops/scripts/prune-finalize-runner-amis.sh
#
# Env:
#   FLEET     dev | prod (required)
#   KEEP      number of newest AMIs to retain (default 3)
#   DRY_RUN   set to 1 to print actions only
set -euo pipefail

R="${AWS_REGION:-us-east-2}"
FLEET="${FLEET:?FLEET=dev|prod required}"
KEEP="${KEEP:-3}"
DRY_RUN="${DRY_RUN:-0}"

case "$FLEET" in
  dev) LT_PREFIX="agenthub-dev-finalize-runner" ;;
  prod) LT_PREFIX="agenthub-finalize-runner" ;;
  *)
    echo "FLEET must be dev or prod" >&2
    exit 1
    ;;
esac

if ! [[ "$KEEP" =~ ^[0-9]+$ ]] || [ "$KEEP" -lt 1 ]; then
  echo "KEEP must be a positive integer (got: $KEEP)" >&2
  exit 1
fi

PINNED=$(aws ssm get-parameter --region "$R" \
  --name "/agenthub/${FLEET}/finalize-runner-ami-id" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo "")

LT_ID=$(aws ec2 describe-launch-templates --region "$R" \
  --query "LaunchTemplates[?starts_with(LaunchTemplateName, \`${LT_PREFIX}\`)].LaunchTemplateId | [0]" \
  --output text 2>/dev/null || echo "")
DEFAULT_AMI=""
if [ -n "$LT_ID" ] && [ "$LT_ID" != None ]; then
  DEFAULT_AMI=$(aws ec2 describe-launch-template-versions --region "$R" \
    --launch-template-id "$LT_ID" --versions '$Default' \
    --query 'LaunchTemplateVersions[0].LaunchTemplateData.ImageId' --output text 2>/dev/null || echo "")
fi

# Newest first. Only our bake AMIs for this fleet (tag from bake-finalize-runner-ami.sh).
# shellcheck disable=SC2207
AMIS=($(aws ec2 describe-images --region "$R" --owners self \
  --filters "Name=tag:agenthub:fleet,Values=${FLEET}" \
    "Name=tag:agenthub:purpose,Values=finalize-runner-ami-bake" \
  --query 'sort_by(Images,&CreationDate)[::-1].ImageId' \
  --output text 2>/dev/null | tr '\t' ' '))

if [ "${#AMIS[@]}" -eq 0 ] || [ -z "${AMIS[0]:-}" ]; then
  echo "No self-owned Finalize bake AMIs tagged agenthub:fleet=$FLEET — nothing to prune."
  exit 0
fi

echo "fleet=$FLEET keep=$KEEP pinned=${PINNED:-none} lt_default=${DEFAULT_AMI:-none} candidates=${#AMIS[@]}"

is_in_use() {
  local ami="$1"
  local n
  n=$(aws ec2 describe-instances --region "$R" \
    --filters "Name=image-id,Values=$ami" \
      "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'length(Reservations[].Instances[])' --output text 2>/dev/null || echo 0)
  [ "${n:-0}" -gt 0 ]
}

kept=0
deleted=0
skipped=0
for AMI in "${AMIS[@]}"; do
  case "$AMI" in ami-*) ;; *) continue ;; esac
  if [ "$kept" -lt "$KEEP" ]; then
    echo "keep (slot $((kept + 1))/$KEEP): $AMI"
    kept=$((kept + 1))
    continue
  fi
  if [ -n "$PINNED" ] && [ "$AMI" = "$PINNED" ]; then
    echo "skip (SSM pin): $AMI"
    skipped=$((skipped + 1))
    continue
  fi
  if [ -n "$DEFAULT_AMI" ] && [ "$AMI" = "$DEFAULT_AMI" ]; then
    echo "skip (launch template \$Default): $AMI"
    skipped=$((skipped + 1))
    continue
  fi
  if is_in_use "$AMI"; then
    echo "skip (instance still using image — in-flight jobs protected): $AMI"
    skipped=$((skipped + 1))
    continue
  fi

  # shellcheck disable=SC2207
  SNAPS=($(aws ec2 describe-images --region "$R" --image-ids "$AMI" \
    --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text 2>/dev/null \
    | tr '\t' ' '))

  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY_RUN deregister $AMI snapshots=${SNAPS[*]:-none}"
    deleted=$((deleted + 1))
    continue
  fi

  echo "deregister $AMI"
  aws ec2 deregister-image --region "$R" --image-id "$AMI"
  for SNAP in "${SNAPS[@]:-}"; do
    case "$SNAP" in snap-*) ;; *) continue ;; esac
    echo "  delete-snapshot $SNAP"
    aws ec2 delete-snapshot --region "$R" --snapshot-id "$SNAP" || {
      echo "  WARN: could not delete $SNAP (may be shared or already gone)" >&2
    }
  done
  deleted=$((deleted + 1))
done

echo "prune done: kept=$kept deleted=$deleted skipped=$skipped"
