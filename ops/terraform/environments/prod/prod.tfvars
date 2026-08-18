# PRODUCTION Agent Hub (us-east-2).
#
# Committed on purpose — reviewable non-secret fleet/sizing config. This file
# is scanned by server/public-repo-hygiene.test.ts, so account-specific
# IDENTIFIERS (the deploy domain, AWS account IDs, Route 53 zone ID, KMS key
# ID, account-scoped bucket names, the delegation role ARN) do NOT belong
# here either — they come from the overlay, alongside tokens:
#   - local:  environments/prod/secrets.tfvars (gitignored)
#   - CI:     individual GitHub Variables/secrets → TF_VAR_* (release-all.yml)
# Do not resurrect the PROD_TFVARS blob.

aws_region   = "us-east-2"
project_name = "agenthub"
name         = "agenthub"

# ── DNS: own zone, delegated from the root apex zone ─────────────────────────
# public_fqdn / base_domain / root_delegation_zone_id / root_delegation_role_arn
# are account-specific identifiers → overlay (TF_VAR_public_fqdn, …). See
# secrets.tfvars.example.
create_route53_zone                 = true
lookup_route53_zone_in_this_account = false

enable_dedicated_alb    = true
web_cidr_blocks         = ["0.0.0.0/0"]
alb_ingress_cidr_blocks = ["0.0.0.0/0"]

enable_preview_subdomain = true

# ── Access: SSM only ─────────────────────────────────────────────────────────
create_ssh_key      = false
enable_ssh_ingress  = false
enable_instance_ssm = true
ssh_cidr_blocks     = []

# ── App image: published :main from public ECR ──────────────────────────────
bootstrap_agent_hub = true
agent_hub_image_uri = "public.ecr.aws/h9t4v7h0/agent-hub:main"

manage_github_oidc_role             = true
create_github_oidc_provider         = true
enable_ci_ssm_deploy_after_ecr_push = true
# Deploy instance id is a non-secret identifier → overlay
# (CI_SSM_DEPLOY_INSTANCE_ID GitHub Variable / secrets.tfvars).
ci_ssm_deploy_instance_ids = []

agent_hub_default_username = "admin"
agent_hub_default_password = "auto"

instance_type    = "m7i.2xlarge"
root_volume_size = 150

# ── Hub data volume + daily snapshots (hub-data.tf) ──────────────────────────
enable_hub_data_volume     = true
hub_data_volume_size       = 1024
hub_data_availability_zone = "us-east-2a"
# hub_data_kms_key_arn embeds the account ID + CMK ID → overlay
# (TF_VAR_hub_data_kms_key_arn). A hub-data.tf precondition fails the plan if
# it is empty while enable_hub_data_volume = true.

# alb_access_logs_bucket embeds the account ID → overlay
# (TF_VAR_alb_access_logs_bucket). Empty disables ALB access logging.

# ── Session artifacts + RUM replay S3 storage (artifacts.tf) ─────────────────
enable_artifacts_bucket = true
# artifacts_bucket_name embeds the account ID → overlay
# (TF_VAR_artifacts_bucket_name). An artifacts.tf precondition fails the plan
# if it is empty while enable_artifacts_bucket = true.

alb_health_check_timeout             = 10
alb_health_check_unhealthy_threshold = 5

# ── Finalize remote-runner fleet ─────────────────────────────────────────────
enable_finalize_runners       = true
manage_shared_finalize_infra  = true
finalize_runner_instance_type = "m7a.xlarge"
# Deepened Spot pool: 14 full-performance 16 GB / 4 vCPU m-family xlarge types,
# all offered across all 3 us-east-2 AZs → 42 capacity-optimized Spot pools.
# Intentionally EXCLUDES burstable m7i-flex (baseline-CPU throttling would
# reintroduce the timing-sensitive E2E flakes the GitHub-parity caps prevent).
finalize_runner_instance_types = [
  "m7a.xlarge", "m7i.xlarge", "m6a.xlarge", "m6i.xlarge", "m6in.xlarge",
  "m6id.xlarge", "m6idn.xlarge", "m5.xlarge", "m5a.xlarge", "m5n.xlarge",
  "m5d.xlarge", "m5dn.xlarge", "m5ad.xlarge", "m5zn.xlarge",
]
finalize_runner_task_memory_mib         = 12288
finalize_runner_root_iops               = 3000
finalize_runner_root_throughput         = 125
finalize_runner_use_spot                = true
finalize_max_reclaim_retry_generations  = 5
finalize_task_protection_expiry_minutes = 40
finalize_fleet_dynamic_scale_down       = true
finalize_runner_min_size                = 0
finalize_runner_max_size                = 128
# AMI id + cache/worktree bucket names are non-secret identifiers → overlay
# (GitHub Variables; see secrets.tfvars.example).
finalize_agent_desired_count            = 0
finalize_fleet_token_secret_arn         = ""

enable_finalize_registry_mirror = true
finalize_dockerhub_secret_arn   = ""
