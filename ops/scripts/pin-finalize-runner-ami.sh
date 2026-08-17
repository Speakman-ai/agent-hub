#!/usr/bin/env bash
#
# Pin the Finalize runner fleet launch template to a newly baked AMI without an
# instance refresh. In-flight jobs keep their hosts; only new scale-outs boot
# from the new AMI (non-disruptive).
#
# Also writes SSM `/agenthub/<fleet>/finalize-runner-ami-id` so release
# terraform apply can override gitignored tfvars via TF_VAR_finalize_runner_ami_id
# and not revert the pin.
#
# Usage:
#   FLEET=dev AMI_ID=ami-xxx ./ops/scripts/pin-finalize-runner-ami.sh
#   FLEET=prod AMI_ID=ami-xxx ./ops/scripts/pin-finalize-runner-ami.sh
set -euo pipefail

R="${AWS_REGION:-us-east-2}"
FLEET="${FLEET:?FLEET=dev|prod required}"
AMI_ID="${AMI_ID:?AMI_ID required}"

case "$FLEET" in
  dev) LT_PREFIX="agenthub-dev-finalize-runner" ;;
  prod) LT_PREFIX="agenthub-finalize-runner" ;;
  *)
    echo "FLEET must be dev or prod" >&2
    exit 1
    ;;
esac

LT_ID=$(aws ec2 describe-launch-templates --region "$R" \
  --query "LaunchTemplates[?starts_with(LaunchTemplateName, \`${LT_PREFIX}\`)].LaunchTemplateId | [0]" \
  --output text)
if [ -z "$LT_ID" ] || [ "$LT_ID" = None ]; then
  echo "No launch template matching prefix $LT_PREFIX" >&2
  exit 1
fi

LT_NAME=$(aws ec2 describe-launch-templates --region "$R" --launch-template-ids "$LT_ID" \
  --query 'LaunchTemplates[0].LaunchTemplateName' --output text)

VER=$(aws ec2 create-launch-template-version --region "$R" \
  --launch-template-id "$LT_ID" \
  --source-version '$Latest' \
  --launch-template-data "{\"ImageId\":\"$AMI_ID\"}" \
  --version-description "bake $AMI_ID $(date -u +%Y-%m-%dT%H:%MZ)" \
  --query 'LaunchTemplateVersion.VersionNumber' --output text)

# Default version → $Latest consumers (ASG) pick it up for NEW instances only.
aws ec2 modify-launch-template --region "$R" \
  --launch-template-id "$LT_ID" \
  --default-version "$VER" >/dev/null

SSM_NAME="/agenthub/${FLEET}/finalize-runner-ami-id"
aws ssm put-parameter --region "$R" --name "$SSM_NAME" --type String \
  --value "$AMI_ID" --overwrite >/dev/null

echo "pinned launch_template=$LT_NAME ($LT_ID) default_version=$VER image=$AMI_ID"
echo "ssm=$SSM_NAME"
echo "NOTE: no instance refresh — running hosts unchanged; next scale-out uses this AMI."
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "launch_template_id=$LT_ID"
    echo "launch_template_version=$VER"
    echo "ami_id=$AMI_ID"
  } >>"$GITHUB_OUTPUT"
fi
