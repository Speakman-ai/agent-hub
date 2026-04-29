# ryan: personal Agent Hub sandbox (dev AWS account, 120569607241).
#
# Public URL : https://agenthub.ryan.dev.surveytracker.io
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

public_fqdn = "agenthub.ryan.dev.surveytracker.io"
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

# First-launch admin credentials. The server writes a random password to
# /home/agenthub/.agent-hub/data/initial-credentials.txt (mode 0600) when
# AGENT_HUB_DEFAULT_PASSWORD=auto. Retrieve it after first boot via SSM:
#   aws ssm start-session --target <instance-id> --profile dev-mcsteen
#   sudo cat /home/agenthub/.agent-hub/data/initial-credentials.txt
agent_hub_default_username = "admin"
agent_hub_default_password = "auto"
