# ryan: personal Agent Hub sandbox (dev AWS account, 120569607241).
#
# Public URL : https://agenthub.dev.surveytracker.io
# Instance   : ryan-sandbox
# Access     : SSM Session Manager only (no SSH, no key pair).
#
# Init / plan / apply:
#   AWS_PROFILE=dev-mcsteen ./scripts/tf-init.sh ryan
#   AWS_PROFILE=dev-mcsteen terraform plan  -var-file=environments/ryan/ryan.tfvars
#   AWS_PROFILE=dev-mcsteen terraform apply -var-file=environments/ryan/ryan.tfvars

aws_region   = "us-east-2"
project_name = "ryan"
name         = "ryan"

public_fqdn = "agenthub.dev.surveytracker.io"
base_domain = "dev.surveytracker.io"

enable_dedicated_alb                = true
lookup_route53_zone_in_this_account = true

# SSM-only access.
create_ssh_key      = false
enable_ssh_ingress  = false
enable_instance_ssm = true
ssh_cidr_blocks     = []

# Pull the published image; skip git clone + docker build.
# The ECR Public repo (public.ecr.aws/h9t4v7h0/agent-hub) is created out-of-band
# — see ops/terraform/ecr-public.tf for the one-time `aws ecr-public create-repository`
# runbook. No per-env Terraform state references it.
bootstrap_agent_hub = true
agent_hub_image_uri = "public.ecr.aws/h9t4v7h0/agent-hub:main"

web_cidr_blocks         = ["0.0.0.0/0"]
alb_ingress_cidr_blocks = ["0.0.0.0/0"]

# GitHub OIDC role for CI image push is shared infra (one role per AWS account,
# pre-existing in dev as `agent-hub-ci-ecr-push`). Don't let the sandbox stack
# manage it — `terraform destroy` here should never break CI for other envs.
manage_github_oidc_role = false

# After CI pushes :main to ECR Public, GitHub Actions restarts agenthub-server on
# this instance (SSM). Requires `terraform apply` (with DynamoDB/S3 state access)
# to keep inline IAM on agent-hub-ci-ecr-push aligned; re-run whenever the sandbox
# instance is replaced. Instance id must match DEV_SANDBOX_INSTANCE_ID in push-image.yml.
enable_ci_ssm_deploy_after_ecr_push = true
ci_ssm_deploy_instance_id           = "i-066e44ff85ec24d8e"

# First-launch admin credentials. The server writes a random password to
# /home/agenthub/.agent-hub/data/initial-credentials.txt (mode 0600) when
# AGENT_HUB_DEFAULT_PASSWORD=auto. Retrieve it after first boot via SSM:
#   aws ssm start-session --target <instance-id> --profile dev-mcsteen
#   sudo cat /home/agenthub/.agent-hub/data/initial-credentials.txt
agent_hub_default_username = "admin"
agent_hub_default_password = "auto"

# Compute / storage sizing — keep in lockstep with cloud reality.
# A plan that wants to revert these would attempt to (a) downsize the
# instance and (b) shrink/recreate the root volume, destroying
# /home/agenthub/.agent-hub (sessions, workspaces, preview DBs).
# History:
# - 2026-05-13: bumped from defaults (t3.medium / 30 GB) to m7i-flex.xlarge /
#   200 GB via aws ec2 modify-volume after a disk-full incident; codified
#   here to reconcile the drift.
# - 2026-05-26: bumped to m7i-flex.2xlarge after sustained CPU pressure
#   (hourly maxes hitting 95-100% for hours daily) and grew the root volume
#   to 500 GB online (aws ec2 modify-volume + growpart + xfs_growfs) after
#   the disk hit 96% from accumulated docker images / preview-postgres
#   volumes. EIP eipalloc-0b6bbb9e2511c2ff7 (3.13.171.6) was allocated and
#   attached out-of-band at the same time so the public IP survives stop/
#   start; it is NOT in this state (yet — separate import follow-up).
instance_type    = "m7i-flex.2xlarge"
root_volume_size = 500
