#!/usr/bin/env bash
#
# Bake a custom AMI for the Finalize runner fleet: AL2023 ECS-optimized AMI with
# the runner image pre-pulled, so fleet instances skip the multi-GB boot-time
# `docker pull` and provision in ~1 min instead of ~3-4. Output: an AMI id to set
# as `finalize_runner_ami_id` in the env tfvars, then `terraform apply`.
#
# Re-run whenever the base AMI or the runner image drift enough that the
# launch-template's boot delta-pull gets slow again (e.g. every few releases).
# The boot pull stays in user-data as a fast delta-pull + fallback, so a slightly
# stale baked AMI is still correct — just re-bake to keep it fast.
#
# Usage:  AWS_PROFILE=agenthub ./ops/scripts/bake-finalize-runner-ami.sh
# Env overrides: AWS_REGION, SUBNET_ID, SG_ID, INSTANCE_PROFILE, RUNNER_IMAGE,
#                BUILD_INSTANCE_TYPE, BUILD_ROOT_GB.
set -euo pipefail

R="${AWS_REGION:-us-east-2}"
RUNNER="${RUNNER_IMAGE:-public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main}"
SUBNET="${SUBNET_ID:-}"          # a public subnet in the fleet VPC (auto-discovered if empty)
SG="${SG_ID:-}"                  # a SG with egress (auto-discovered if empty)
PROFILE="${INSTANCE_PROFILE:-agenthub-finalize-runner-instance}"  # needs SSM core
TYPE="${BUILD_INSTANCE_TYPE:-m7i.large}"
ROOT_GB="${BUILD_ROOT_GB:-40}"

# Resolve the current AL2023 ECS-optimized AMI to bake from.
BASE=$(aws ssm get-parameter --region "$R" \
  --name /aws/service/ecs/optimized-ami/amazon-linux-2023/recommended \
  --query 'Parameter.Value' --output text | python3 -c "import sys,json;print(json.load(sys.stdin)['image_id'])")
[ -n "$SUBNET" ] || SUBNET=$(aws ec2 describe-subnets --region "$R" \
  --filters 'Name=tag:Name,Values=*public*' 'Name=map-public-ip-on-launch,Values=true' \
  --query 'Subnets[0].SubnetId' --output text)
[ -n "$SG" ] || SG=$(aws ec2 describe-security-groups --region "$R" \
  --filters 'Name=group-name,Values=*-sg-*' --query 'SecurityGroups[0].GroupId' --output text)
echo "base=$BASE subnet=$SUBNET sg=$SG profile=$PROFILE runner=$RUNNER"

IID=$(aws ec2 run-instances --region "$R" --image-id "$BASE" --instance-type "$TYPE" \
  --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --iam-instance-profile "Name=$PROFILE" --associate-public-ip-address \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$ROOT_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=agenthub-runner-ami-bake}]' \
  --query 'Instances[0].InstanceId' --output text)
echo "build_instance=$IID"
trap 'aws ec2 terminate-instances --region "$R" --instance-ids "$IID" >/dev/null 2>&1 || true' EXIT
aws ec2 wait instance-running --region "$R" --instance-ids "$IID"
for i in $(seq 1 30); do
  [ "$(aws ssm describe-instance-information --region "$R" --filters "Key=InstanceIds,Values=$IID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)" = Online ] && break
  sleep 10
done

CID=$(aws ssm send-command --region "$R" --instance-ids "$IID" --document-name AWS-RunShellScript \
  --parameters "commands=[\"for i in 1 2 3; do docker pull $RUNNER && break; sleep 10; done\",\"docker image inspect $RUNNER --format pulled={{.Id}}\",\"sudo systemctl stop ecs || true\",\"sudo rm -f /var/lib/ecs/data/agent.db /var/lib/ecs/data/ecs_agent_data.json || true\"]" \
  --query 'Command.CommandId' --output text)
for i in $(seq 1 60); do
  st=$(aws ssm get-command-invocation --region "$R" --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  [ "$st" = Success ] && break
  case "$st" in Failed|Cancelled|TimedOut) echo "pull $st"; exit 1;; esac
  sleep 15
done

aws ec2 stop-instances --region "$R" --instance-ids "$IID" >/dev/null
aws ec2 wait instance-stopped --region "$R" --instance-ids "$IID"
AMI=$(aws ec2 create-image --region "$R" --instance-id "$IID" \
  --name "agenthub-finalize-runner-baked-$(date +%s)" \
  --description "AL2023 ECS-optimized + pre-pulled $RUNNER" --query 'ImageId' --output text)
aws ec2 wait image-available --region "$R" --image-ids "$AMI"
echo "DONE — set finalize_runner_ami_id = \"$AMI\" in the env tfvars + terraform apply"
