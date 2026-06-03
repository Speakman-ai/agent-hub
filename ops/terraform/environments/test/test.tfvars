# test: CI-sized Agent Hub instance (dev AWS account, 120569607241).
#
# Purpose : a bigger box dedicated to running Finalize CI (4 parallel e2e
#           shards + builds) without the OOM the 12 GB laptop / 32 GB ryan box
#           hits. Separate state (environments/test/backend.hcl, key
#           test/terraform.tfstate) — fully isolated from `ryan`
#           (agenthub.dev.surveytracker.io / i-066e44ff85ec24d8e). Touching this
#           stack can never modify ryan.
#
# Public URL : https://agenthub.test.surveytracker.io
# Access     : SSM Session Manager only (no SSH, no key pair).
#
# Init / plan / apply:
#   AWS_PROFILE=dev ./scripts/tf-init.sh test
#   AWS_PROFILE=dev terraform plan  -var-file=environments/test/test.tfvars
#   AWS_PROFILE=dev terraform apply -var-file=environments/test/test.tfvars

aws_region   = "us-east-2"
project_name = "test"
name         = "test"

# Hosted under the existing dev.surveytracker.io zone (the only zone in this
# account); no test.surveytracker.io zone exists, so the record is a sibling of
# ryan. Fully isolated from ryan (separate host/ALB/cert/state).
public_fqdn = "agenthub-test.dev.surveytracker.io"
base_domain = "dev.surveytracker.io"

enable_dedicated_alb                = true
lookup_route53_zone_in_this_account = true

# SSM-only access (mirror ryan).
create_ssh_key      = false
enable_ssh_ingress  = false
enable_instance_ssm = true
ssh_cidr_blocks     = []

# Pull the published image; skip git clone + docker build.
bootstrap_agent_hub = true
agent_hub_image_uri = "public.ecr.aws/h9t4v7h0/agent-hub:main"

web_cidr_blocks         = ["0.0.0.0/0"]
alb_ingress_cidr_blocks = ["0.0.0.0/0"]

# Do NOT manage the shared GitHub OIDC ECR-push role (one per account, owned by
# ryan's stack). Keeps `terraform destroy` here from breaking CI for other envs.
manage_github_oidc_role = false

# Do NOT wire CI auto-deploy here. push-image.yml's post-ECR SSM restart targets
# the ryan sandbox instance (DEV_SANDBOX_INSTANCE_ID). This box pulls :main on
# its own restart / manual SSM. Keeping this false avoids adding inline IAM tied
# to a second instance and keeps the test box independent of the CI pipeline.
enable_ci_ssm_deploy_after_ecr_push = false

# First-launch admin credentials (random password written to
# /home/agenthub/.agent-hub/data/initial-credentials.txt; retrieve via SSM).
agent_hub_default_username = "admin"
agent_hub_default_password = "auto"

# Compute / storage — BIGGER than ryan (m7i-flex.2xlarge = 8 vCPU / 32 GB) to
# run the Finalize matrix in parallel without OOM. r7i.2xlarge = 8 vCPU / 64 GB
# (memory-optimized; double the RAM at the same vCPU — e2e is memory-bound: each
# shard is a full DinD stack ~5-6 GB). ⚠️ Cost ≈ $0.53/hr on-demand (~$385/mo if
# left running 24/7). PENDING your sizing confirmation — bump to r7i.4xlarge
# (16 vCPU / 128 GB, ~$0.85/hr) if 4 fully-parallel shards + builds are CPU-bound.
instance_type    = "r7i.2xlarge"
root_volume_size = 500

# ── Finalize remote-runner fleet (modules/finalize-runners) ──────────────────
# DRAFT — kept OFF until prereqs exist so `terraform plan` is a clean no-op for
# the fleet. To enable (after the runner stack is reviewed):
#   1. Create the shared fleet token in Secrets Manager and set
#      finalize_fleet_token_secret_arn below.
#   2. Build/publish an agent image (finalize-runner image + agent code) and set
#      finalize_agent_image_uri (or leave blank to use the finalize-runner image
#      once the agent is baked into it).
#   3. Flip enable_finalize_runners = true (and manage_shared_finalize_infra =
#      true to create the buckets/ECR — this is the one env that owns them).
#   4. AWS_PROFILE=dev terraform plan  -var-file=environments/test/test.tfvars
#      AWS_PROFILE=dev terraform apply -var-file=environments/test/test.tfvars
enable_finalize_runners        = true # Phase-2a: stand up the fleet
manage_shared_finalize_infra   = true # this env owns the shared buckets/ECR
finalize_runner_instance_type  = "r7i.xlarge"
# Stage-2b concurrency: the Hub's queue-depth autoscaler drives the agent count
# (desiredCount, ignored by TF) between min and max, so a run's shards execute
# in parallel and the fleet scales back to zero when idle.
finalize_runner_min_size       = 0 # scale-to-zero when no jobs are queued
finalize_runner_max_size       = 8 # up to 8 shards concurrently
finalize_agent_desired_count   = 0 # initial only; the scaler owns it at runtime
finalize_cache_bucket_name     = "agent-hub-finalize-cache-120569607241"
finalize_worktree_bucket_name  = "agent-hub-finalize-worktree-120569607241"
finalize_fleet_token_secret_arn = "arn:aws:secretsmanager:us-east-2:120569607241:secret:agent-hub/finalize/fleet-token-IHgZsm"
# Agent baked into the finalize-runner image (entrypoint `agent` mode), pushed to
# the private dev ECR. The runner-agent.mjs is bundled into this same image.
finalize_agent_image_uri        = "120569607241.dkr.ecr.us-east-2.amazonaws.com/agent-hub-finalize-runner:test"
