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

# First-launch admin credentials. The server writes a random password to
# /home/agenthub/.agent-hub/data/initial-credentials.txt (mode 0600) when
# AGENT_HUB_DEFAULT_PASSWORD=auto. Retrieve it after first boot via SSM:
#   aws ssm start-session --target <instance-id> --profile dev-mcsteen
#   sudo cat /home/agenthub/.agent-hub/data/initial-credentials.txt
agent_hub_default_username = "admin"
agent_hub_default_password = "auto"

# ── PR Environments (per-PR preview deployments) ────────────────────────────
# `enable_pr_environments` defaults to TRUE — the entire PR-env stack
# (wildcard ACM cert, Route 53 inline policy, host nginx + certbot,
# SG ports 3100-3999, Tier-3 prEnv config) is provisioned out of the box.
# Operators only need to flip the "PR Environments" checkbox in Settings
# (and enter Tier-1+2 secrets) post-boot to start dispatching previews.
#
# Tier-1+2 secrets (GitHub App private key, Route53 IAM access keys,
# repoFullName, certRenewalLive) are intentionally NOT in this file —
# they're entered post-boot via Settings → PR Environments and stored
# AES-256-GCM-encrypted in the pr_env_config SQLite row.
#
# Required when the PR-env stack is on: the Let's Encrypt registration email
# for the wildcard cert. Leave the per-piece `enable_pr_env_*` overrides
# unset (= null = follow the parent) unless you are intentionally disabling
# one piece for testing.
cert_renewal_email = "ryanspeakman@mcsteen.com"
# pr_env_preview_subdomain defaults to "preview" — leaving unset gives
# the wildcard *.preview.agenthub.dev.surveytracker.io.
