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

# Subdomain preview mode → live HMR previews (wildcard cert + Route 53 alias +
# ALB listener cert for *.preview.agenthub.surveytracker.io). Pair with
# AGENT_HUB_PREVIEW_SUBDOMAIN_BASE on the Hub. See ops/RUNBOOK-subdomain-preview-hmr.md
enable_preview_subdomain = true

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
instance_type    = "m7i.2xlarge" # 8 vCPU / 32 GB — adopted to match the live (manually scaled-up) Hub; avoids a downsize+reboot on apply
root_volume_size = 150

# ── Hub data volume + daily snapshots (hub-data.tf) ──────────────────────────
# Dedicated encrypted 256 GiB volume (mounted /dev/sdf) holding the Hub DB +
# data dir, with a DLM 14-day daily-snapshot policy. Re-adopted into source
# control 2026-06-15 after being found applied out-of-band (state-only). The
# KMS ARN must match the live volume's CMK exactly, or TF plans a replacement.
enable_hub_data_volume     = true
hub_data_volume_size       = 256
hub_data_availability_zone = "us-east-2a" # must match the live volume vol-083f7a0f95116d80e
hub_data_kms_key_arn       = "arn:aws:kms:us-east-2:350025135582:key/8bd60c33-06da-4257-8a77-28a99fd67ee4"

# ALB access logs — adopted from live (was applied out-of-band; config would
# otherwise disable them). Bucket already exists in this account.
alb_access_logs_bucket = "agenthub-alb-logs-350025135582"

# Health check — keep the tolerant live values (10s timeout, 5 failures). prod is
# a SINGLE-instance target group, so tightening (the 5/2 default) only risks a
# transient slowdown flapping the only target into a site-wide 503; there is no
# peer to fail over to. Deliberately more forgiving than the multi-target default.
alb_health_check_timeout             = 10
alb_health_check_unhealthy_threshold = 5

# ── Finalize remote-runner fleet (full production config) ────────────────────
enable_finalize_runners       = true
manage_shared_finalize_infra  = true # this account owns its buckets/ECR
finalize_runner_instance_type = "r7i.xlarge"
# On-demand: us-east-2 Spot for r/m-family 32GB types went region-wide
# UnfulfillableCapacity (all 3 AZs), stranding runs. On-demand always has capacity.
# Flip back to true once Spot recovers if the ~3x fleet cost matters (lost jobs
# already retry on a fresh agent, so Spot is safe to re-enable).
finalize_runner_use_spot = false
finalize_runner_min_size = 0 # scale-to-zero when idle
# 64-agent ceiling. This single var drives the ASG max_size, on_demand_base_capacity,
# and maximum_scaling_step_size (modules/finalize-runners) AND the Hub env
# FINALIZE_FLEET_MAX_AGENTS (finalize-hub.tf) in lockstep — one task per instance
# (28 GiB reservation on 32 GiB hosts), so agents == instances.
# Sized from measured demand: 14-day peak queue depth hit 50 with p99 queue wait
# ~27 min at the old ceiling of 8.
# Quota: worst case the mixed pool falls back to m-family 2xlarge (8 vCPU/agent),
# so 64 agents ≈ 16 baseline + 64*8 = 528 On-Demand Standard vCPUs. The L-1216C47A
# quota (acct 350025135582 us-east-2) was raised 512 -> 768 and APPROVED 2026-06-15,
# so 64 agents sit at ~69% of quota. This value is not enforced by comment alone:
# terraform_data.finalize_quota_guard (finalize-runners.tf) reads the LIVE quota and
# FAILS the plan if finalize_runner_max_size would exceed it, so a future bump past
# the approved quota is blocked until the quota is raised first.
finalize_runner_max_size = 64 # up to 64 shards/agents concurrently; guarded against the live On-Demand vCPU quota
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
