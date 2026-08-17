#!/usr/bin/env bash
#
# Bake a custom AMI for the Finalize runner fleet: AL2023 ECS-optimized AMI with
# the runner image pre-pulled, so fleet instances skip the multi-GB boot-time
# `docker pull` and provision in ~1 min instead of ~3-4.
#
# Usage (local):
#   AWS_PROFILE=agenthub FLEET=dev ./ops/scripts/bake-finalize-runner-ami.sh
#   AWS_PROFILE=agenthub FLEET=prod RUNNER_IMAGE=public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:v2.31.81 \
#     ./ops/scripts/bake-finalize-runner-ami.sh
#
# Env:
#   FLEET              dev | prod (required for auto subnet/SG/profile discovery)
#   RUNNER_IMAGE       image:tag to pre-pull (default :main)
#   AWS_REGION         default us-east-2
#   SUBNET_ID / SG_ID / INSTANCE_PROFILE — optional overrides
#   BUILD_INSTANCE_TYPE / BUILD_ROOT_GB
#   AMI_NAME_PREFIX    default agenthub-finalize-runner-baked
#   GITHUB_OUTPUT      when set (Actions), writes ami_id=
#
# Non-disruptive pin of the fleet launch template is a separate step:
#   ./ops/scripts/pin-finalize-runner-ami.sh
set -euo pipefail

R="${AWS_REGION:-us-east-2}"
FLEET="${FLEET:-}"
RUNNER="${RUNNER_IMAGE:-public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main}"
TYPE="${BUILD_INSTANCE_TYPE:-m7i.large}"
ROOT_GB="${BUILD_ROOT_GB:-40}"
NAME_PREFIX="${AMI_NAME_PREFIX:-agenthub-finalize-runner-baked}"
SUBNET="${SUBNET_ID:-}"
SG="${SG_ID:-}"
PROFILE="${INSTANCE_PROFILE:-}"

case "$FLEET" in
  dev)
    PREFIX="agenthub-dev-finalize-runner"
    PROFILE="${PROFILE:-agenthub-dev-finalize-runner-instance}"
    ;;
  prod)
    PREFIX="agenthub-finalize-runner"
    PROFILE="${PROFILE:-agenthub-finalize-runner-instance}"
    ;;
  '')
    PREFIX=""
    PROFILE="${PROFILE:-agenthub-finalize-runner-instance}"
    ;;
  *)
    echo "FLEET must be 'dev' or 'prod' (got: $FLEET)" >&2
    exit 1
    ;;
esac

# Accept the OCI/Docker reference forms this fleet supports: optional registry
# (and port), lowercase repository path, optional tag, and optional sha256
# digest. Keep this deliberately conservative because the value ultimately
# reaches a remote shell through SSM.
OCI_IMAGE_RE='^([a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?/)?[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$'
if [[ ! "$RUNNER" =~ $OCI_IMAGE_RE ]]; then
  echo "RUNNER_IMAGE must be a valid OCI image reference (got: $RUNNER)" >&2
  exit 1
fi

BASE=$(aws ssm get-parameter --region "$R" \
  --name /aws/service/ecs/optimized-ami/amazon-linux-2023/recommended \
  --query 'Parameter.Value' --output text | python3 -c "import sys,json;print(json.load(sys.stdin)['image_id'])")

if [ -z "$SUBNET" ] || [ -z "$SG" ]; then
  if [ -z "$PREFIX" ]; then
    echo "SUBNET_ID and SG_ID are required when FLEET is unset" >&2
    exit 1
  fi
  SG="${SG:-$(aws ec2 describe-security-groups --region "$R" \
    --filters "Name=group-name,Values=${PREFIX}-sg" \
    --query 'SecurityGroups[0].GroupId' --output text)}"
  VPC=$(aws ec2 describe-security-groups --region "$R" \
    --group-ids "$SG" --query 'SecurityGroups[0].VpcId' --output text)
  SUBNET="${SUBNET:-$(aws ec2 describe-subnets --region "$R" \
    --filters "Name=vpc-id,Values=$VPC" 'Name=map-public-ip-on-launch,Values=true' \
    --query 'Subnets[0].SubnetId' --output text)}"
fi

if [ -z "$SUBNET" ] || [ -z "$SG" ] || [ "$SUBNET" = None ] || [ "$SG" = None ]; then
  echo "Could not resolve SUBNET_ID/SG_ID (subnet=$SUBNET sg=$SG)" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d%H%M%S)
AMI_NAME="${NAME_PREFIX}-${FLEET:-manual}-${STAMP}"
echo "fleet=${FLEET:-manual} base=$BASE subnet=$SUBNET sg=$SG profile=$PROFILE runner=$RUNNER name=$AMI_NAME"

IID=$(aws ec2 run-instances --region "$R" --image-id "$BASE" --instance-type "$TYPE" \
  --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --iam-instance-profile "Name=$PROFILE" --associate-public-ip-address \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$ROOT_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${AMI_NAME}},{Key=agenthub:fleet,Value=${FLEET:-manual}},{Key=agenthub:purpose,Value=finalize-runner-ami-bake}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "build_instance=$IID"
trap 'aws ec2 terminate-instances --region "$R" --instance-ids "$IID" >/dev/null 2>&1 || true' EXIT
aws ec2 wait instance-running --region "$R" --instance-ids "$IID"

online=0
for i in $(seq 1 36); do
  if [ "$(aws ssm describe-instance-information --region "$R" \
    --filters "Key=InstanceIds,Values=$IID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)" = Online ]; then
    online=1
    break
  fi
  sleep 10
done
if [ "$online" != 1 ]; then
  echo "SSM agent never came Online on $IID" >&2
  exit 1
fi

# The reference never appears raw in remote shell source. Base64 confines the
# transported value to a shell-safe alphabet, while Python serializes the SSM
# parameters as JSON instead of relying on AWS CLI shorthand quoting.
RUNNER_B64=$(printf '%s' "$RUNNER" | base64 | tr -d '\n')
SSM_PARAMETERS=$(python3 - "$RUNNER_B64" <<'PY'
import json
import sys

encoded = sys.argv[1]
commands = [
    "set -euo pipefail",
    f"RUNNER_IMAGE=$(printf '%s' '{encoded}' | base64 -d)",
    'for i in 1 2 3 4 5; do docker pull "$RUNNER_IMAGE" && break; sleep 15; done',
    'docker image inspect "$RUNNER_IMAGE" --format \'pulled={{.Id}}\'',
    "sudo systemctl stop ecs || true",
    "sudo rm -f /var/lib/ecs/data/agent.db /var/lib/ecs/data/ecs_agent_data.json || true",
]
print(json.dumps({"commands": commands}, separators=(",", ":")))
PY
)
CID=$(aws ssm send-command --region "$R" --instance-ids "$IID" --document-name AWS-RunShellScript \
  --parameters "$SSM_PARAMETERS" \
  --query 'Command.CommandId' --output text)

command_succeeded=0
for i in $(seq 1 80); do
  st=$(aws ssm get-command-invocation --region "$R" --command-id "$CID" --instance-id "$IID" \
    --query Status --output text 2>/dev/null || echo Pending)
  if [ "$st" = Success ]; then
    command_succeeded=1
    break
  fi
  case "$st" in Failed|Cancelled|TimedOut)
    echo "SSM pull/command $st" >&2
    aws ssm get-command-invocation --region "$R" --command-id "$CID" --instance-id "$IID" \
      --query '[Status,StandardOutputContent,StandardErrorContent]' --output text >&2 || true
    exit 1
    ;;
  esac
  sleep 15
done
if [ "$command_succeeded" != 1 ]; then
  echo "SSM pull/command did not complete successfully (last status: $st)" >&2
  aws ssm get-command-invocation --region "$R" --command-id "$CID" --instance-id "$IID" \
    --query '[Status,StandardOutputContent,StandardErrorContent]' --output text >&2 || true
  exit 1
fi

aws ec2 stop-instances --region "$R" --instance-ids "$IID" >/dev/null
aws ec2 wait instance-stopped --region "$R" --instance-ids "$IID"

DESC="AL2023 ECS-optimized + pre-pulled $RUNNER (fleet=${FLEET:-manual})"
AMI=$(aws ec2 create-image --region "$R" --instance-id "$IID" \
  --name "$AMI_NAME" \
  --description "$DESC" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=agenthub:fleet,Value=${FLEET:-manual}},{Key=agenthub:purpose,Value=finalize-runner-ami-bake},{Key=agenthub:runner-image,Value=$RUNNER}]" \
  --query 'ImageId' --output text)
aws ec2 wait image-available --region "$R" --image-ids "$AMI"

echo "ami_id=$AMI"
echo "DONE — pin with: FLEET=${FLEET:-dev} AMI_ID=$AMI ./ops/scripts/pin-finalize-runner-ami.sh"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "ami_id=$AMI" >>"$GITHUB_OUTPUT"
fi
