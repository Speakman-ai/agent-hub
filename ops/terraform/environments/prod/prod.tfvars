# Production Agent Hub — dedicated account 350025135582 (AWS profile `agenthub`),
# us-east-2. Fully Terraform-managed: own DNS zone (agenthub.surveytracker.io,
# delegated from the root surveytracker.io zone), the remote Finalize fleet
# (spot, autoscaled, scale-to-zero), and the shared base-image registry mirror.
#
# Prereqs (one-time, already done): TF state bucket + lock table in this account;
# root-account role agenthub_env_role_assume (797611956947). The published
# :main images must carry the fleet code — i.e. APPLY ONLY AFTER the
# feature/finalize-remote-runners branch merges to main.
#
#   AWS_PROFILE=agenthub terraform init -reconfigure -backend-config=environments/prod/backend.hcl
#   AWS_PROFILE=agenthub terraform apply -var-file=environments/prod/prod.tfvars

aws_region   = "us-east-2"
project_name = "agenthub"
name         = "agenthub"

# ── DNS: own zone for agenthub.surveytracker.io, delegated from root ─────────
public_fqdn                         = "agenthub.surveytracker.io"
base_domain                         = "agenthub.surveytracker.io"
create_route53_zone                 = true
lookup_route53_zone_in_this_account = false
root_delegation_zone_id             = "Z10407258WTZ0HQ4VDZP" # surveytracker.io (root acct 797611956947)
root_delegation_role_arn            = "arn:aws:iam::797611956947:role/agenthub_env_role_assume"

enable_dedicated_alb    = true
web_cidr_blocks         = ["0.0.0.0/0"]
alb_ingress_cidr_blocks = ["0.0.0.0/0"]

# ── Access: SSM only ─────────────────────────────────────────────────────────
create_ssh_key      = false
enable_ssh_ingress  = false
enable_instance_ssm = true
ssh_cidr_blocks     = []

# ── App image: published :main from public ECR (cross-account pull) ──────────
bootstrap_agent_hub = true
agent_hub_image_uri = "public.ecr.aws/h9t4v7h0/agent-hub:main"

# CI release deploy → THIS box. The release workflow (ecr-publish-rollout-docker-dev.yml)
# pushes :main to the dev-account public ECR (h9t4v7h0), then assumes the role below
# in THIS account to `systemctl restart agenthub-server` over SSM. We create the
# GitHub OIDC provider here (new account, none exists yet) and the assumed role.
manage_github_oidc_role             = true
create_github_oidc_provider         = true
enable_ci_ssm_deploy_after_ecr_push = true
ci_ssm_deploy_instance_id           = "i-0415277dd6022627a" # agenthub prod Hub

agent_hub_default_username = "admin"
agent_hub_default_password = "auto"

# Hub no longer runs CI (the fleet does) → right-sized vs the test box.
instance_type    = "m7i-flex.xlarge" # 4 vCPU / 16 GB — app + registry mirror + worktree bundling
root_volume_size = 150

# ── Finalize remote-runner fleet (full production config) ────────────────────
enable_finalize_runners         = true
manage_shared_finalize_infra    = true # this account owns its buckets/ECR
finalize_runner_instance_type   = "r7i.xlarge"
finalize_runner_min_size        = 0 # scale-to-zero when idle
finalize_runner_max_size        = 8 # up to 8 shards concurrently
# Baked AMI: AL2023 ECS-optimized + the runner image pre-pulled, so fleet
# instances skip the multi-GB boot `docker pull` and provision much faster.
# Re-bake (ops/scripts or the runbook) when the base AMI / runner image change;
# the launch-template boot pull stays as a fast delta-pull + fallback.
finalize_runner_ami_id          = "ami-067a1878748cbbf2f"
finalize_agent_desired_count    = 0 # scaler owns it at runtime
finalize_cache_bucket_name      = "agent-hub-finalize-cache-350025135582"
finalize_worktree_bucket_name   = "agent-hub-finalize-worktree-350025135582"
finalize_fleet_token_secret_arn = "" # empty → TF generates the token + creates the secret

# Shared base-image pull-through cache on the Hub (registry:2). Set
# finalize_dockerhub_secret_arn to a {username,accessToken} secret in THIS account
# for an authenticated upstream; empty = anonymous (fine — each image cached once).
enable_finalize_registry_mirror = true
finalize_dockerhub_secret_arn   = ""
