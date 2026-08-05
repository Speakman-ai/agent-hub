variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "agent-hub"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "ami_id" {
  description = "Override AMI used at instance **create** time. Leave null to use the ECS-optimized Amazon Linux 2023 AMI resolved from SSM (`use_ecs_optimized_ami = true`, default). After the first apply, `aws_instance.app` ignores `ami` drift (see main.tf lifecycle) so changing this variable alone does not re-image the host — use `terraform apply -replace=aws_instance.app` when you intend to rebuild. Set a raw AMI ID (e.g. Ubuntu) only for the legacy PM2-on-host path."
  type        = string
  default     = null
  nullable    = true
}

variable "use_ecs_optimized_ami" {
  description = "When true and `ami_id` is null, resolve the latest ECS-optimized Amazon Linux 2023 AMI from SSM parameter `/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended`. This is the right default for the ECR-pull bootstrap path; Docker is already installed and systemd-enabled. Set false if you pin an `ami_id`."
  type        = bool
  default     = true
}

variable "ssh_cidr_blocks" {
  description = "CIDR blocks for port 22; used only if enable_ssh_ingress is true (e.g. [\"<your-ip>/32\"]. Use [] and enable_ssh_ingress = false to rely on SSM only.)"
  type        = list(string)
  default     = []
}

variable "enable_ssh_ingress" {
  description = "If false, no security group rule for port 22 (use AWS Systems Manager Session Manager instead; set enable_instance_ssm = true)"
  type        = bool
  default     = true
}

variable "create_ssh_key" {
  description = "If true, create a new EC2 key pair and write a .pem in this module directory. Set false to use SSM only and no SSH key on the instance."
  type        = bool
  default     = true
}

variable "enable_instance_ssm" {
  description = "Attach an IAM instance profile with AmazonSSMManagedInstanceCore so the instance can register for SSM Session Manager."
  type        = bool
  default     = true
}

variable "web_cidr_blocks" {
  description = "CIDR blocks allowed to reach HTTP/HTTPS (ports 80, 443)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "egress_cidr_blocks" {
  description = "CIDR blocks allowed for outbound traffic from the instance"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr_block" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr_block" {
  description = "CIDR block for the public subnet"
  type        = string
  default     = "10.0.150.0/24"
}

variable "availability_zone_suffix" {
  description = "Availability zone suffix (appended to aws_region, e.g. \"a\" for us-east-2a)"
  type        = string
  default     = "a"
}

variable "internet_route_cidr_block" {
  description = "Destination CIDR for the public route table default route"
  type        = string
  default     = "0.0.0.0/0"
}

variable "root_volume_size" {
  description = "Size (GB) of the root EBS volume"
  type        = number
  default     = 30
}

variable "root_volume_type" {
  description = "Type of the root EBS volume (e.g. gp3, gp2, io1)"
  type        = string
  default     = "gp3"
}

variable "node_major_version" {
  description = "Major Node.js version installed by user_data (via NodeSource)"
  type        = string
  default     = "22"
}

variable "app_user" {
  description = "Linux user created on the instance to own the app directory"
  type        = string
  default     = "agenthub"
}

# --- Agent Hub (Docker) — written to <docker_app_path>/.env at first boot
# (x-api-key: see variables-bootstrap.tf; random_id in bootstrap-api-key.tf)

variable "docker_bootstrap" {
  description = "If true, install Docker and create .env for docker compose. If false, use minimal user_data (Node, PM2, Nginx, cursor only). Ignored when bootstrap_agent_hub is true (that path uses agent_hub_bootstrap_docker and agent-hub-user-data.tftpl instead)."
  type        = bool
  default     = true
}

variable "docker_app_path" {
  description = "Host path for the app checkout (e.g. rsync target). .env is created here before the repo is copied."
  type        = string
  default     = "/home/agenthub/agent-hub"
}

variable "allowed_origins" {
  description = "Comma-separated browser origins for CORS (no trailing slash). Set empty or \"AUTO\" to use http://<IMDS public IPv4> at boot."
  type        = string
  default     = "AUTO"
}

variable "agent_hub_public_url" {
  description = "Public base URL (OAuth/GitHub, etc.). Empty = same as IMDS http://<public-ip> when combined with default behavior."
  type        = string
  default     = ""
}

variable "agent_hub_web_port" {
  description = "Host port published for the client container (AGENT_HUB_WEB_PORT in .env, maps docker-compose 80:80 by default)."
  type        = number
  default     = 80
}

# `user_data_replace_on_change` was removed deliberately. It was a single bool
# whose `true` value destroyed and recreated the live Hub instance on any
# rendered-user_data change — a footgun with no safe use in a pipeline that now
# applies on every release. Rendered user-data changes reach an existing host
# through `ops/scripts/sync-hub-env.sh` (SSM upsert of the managed .env keys)
# instead; a genuine rebuild is an explicit, out-of-band
# `terraform apply -replace=aws_instance.app`.

variable "ssh_user" {
  description = "Default SSH username for the AMI. Ubuntu AMIs use \"ubuntu\"; ECS-optimized Amazon Linux 2023 uses \"ec2-user\". Unused when create_ssh_key = false and enable_ssh_ingress = false."
  type        = string
  default     = "ec2-user"
}

# --- ECR Public (agent-hub image registry) -----------------------------------
#
# The ECR Public repo itself is NOT managed by Terraform — it's one-time shared
# infra (see ecr-public.tf for the create-repository runbook). Per-env stacks
# only need the URI (alias + name) to construct the pull URL.

variable "ecr_public_repo_name" {
  description = "ECR Public repository name (URI suffix after the alias). Used by CI push + user-data pull."
  type        = string
  default     = "agent-hub"
}

variable "ecr_public_finalize_runner_repo_name" {
  description = "ECR Public repository for the Finalize CI DinD runner image (ubuntu-24.04). Tagged in lockstep with agent-hub (same :main / :sha tags)."
  type        = string
  default     = "agent-hub-finalize-runner"
}

variable "ecr_public_registry_alias" {
  description = "ECR Public registry alias — the URL path between public.ecr.aws/ and the repo name. AWS auto-assigned \"h9t4v7h0\" on first repo creation in this account; a vanity alias like \"agenthub\" can be requested via the console (same-day AWS approval) and both URIs keep working."
  type        = string
  default     = "h9t4v7h0"
}

# --- GitHub Actions OIDC (CI image push) -------------------------------------

variable "manage_github_oidc_role" {
  description = "If true, create the IAM role assumed by GitHub Actions to push images to ECR Public. The OIDC provider itself is assumed to exist (AWS dev account has one already) unless create_github_oidc_provider is set. Set false if you manage the role in another module."
  type        = bool
  default     = true
}

variable "create_github_oidc_provider" {
  description = "If true, CREATE the GitHub Actions OIDC provider in this account instead of referencing a pre-existing one. Set true in a fresh account that has no provider yet (e.g. agenthub prod); leave false where one already exists (dev). Only takes effect with manage_github_oidc_role=true."
  type        = bool
  default     = false
}

variable "github_oidc_role_name" {
  description = "Name of the IAM role GitHub Actions assumes (for `aws-actions/configure-aws-credentials`). Must match the `role-to-assume` in .github/workflows/push-image.yml."
  type        = string
  default     = "agent-hub-ci-ecr-push"
}

variable "github_repo_owner" {
  description = "GitHub org/user owning the repo (used in OIDC sub claim)."
  type        = string
  default     = "Speakman-ai"
}

variable "github_repo_name" {
  description = "GitHub repo name (used in OIDC sub claim)."
  type        = string
  default     = "agent-hub"
}

variable "enable_ci_ssm_deploy_after_ecr_push" {
  description = "If true, attach an inline IAM policy to `github_oidc_role_name` so GitHub Actions can run SSM SendCommand against `ci_ssm_deploy_instance_id` (restart `agenthub-server.service` after each ECR :main push). Enable only in one workspace per account to avoid duplicate policy management."
  type        = bool
  default     = false
}

variable "ci_ssm_deploy_instance_id" {
  description = "EC2 instance id (e.g. i-0abc...) in `aws_region` that receives `systemctl restart agenthub-server` from CI. Empty skips the policy. Used only when `enable_ci_ssm_deploy_after_ecr_push` is true; must match the instance in .github/workflows/push-image.yml."
  type        = string
  default     = ""
}

# --- Dedicated ALB (ops/terraform/alb.tf) — TLS at ALB, HTTP to Agent Hub on the instance ---

variable "enable_dedicated_alb" {
  description = "If true, create a public application load balancer, target group, optional ACM cert + Route 53 record, and restrict app port ingress to the ALB. Requires a second public subnet in another AZ."
  type        = bool
  default     = false
}

variable "enable_preview_subdomain" {
  description = "If true (and enable_dedicated_alb=true with a Route 53 zone), provision a wildcard ACM cert + Route 53 alias + ALB listener cert attachment for `*.preview.<alb_fqdn>`, enabling 'subdomain preview' mode where each session preview lives at <sessionId>.preview.<alb_fqdn>. Lets apps render at base `/` with zero per-app config (no AGENT_HUB_PREVIEW_BASE_PATH wiring needed). Set the matching `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE` env on the agent-hub server to `preview.<alb_fqdn>` to activate the server-side dispatcher (Phase 4b)."
  type        = bool
  default     = false
}

variable "name" {
  description = "When public_fqdn is unset, used to build the hostname: <dns_subdomain>.<name>.<base_domain>. If public_fqdn is set, this is ignored for DNS (but can stay empty for naming elsewhere)."
  type        = string
  default     = ""
}

variable "public_fqdn" {
  description = "Full public hostname (e.g. agenthub.myenv.example.com). When set, overrides the composed <dns_subdomain>.<name>.<base_domain>. The name must be under the Route 53 zone for base_domain when you want Terraform to create ACM + A records in *this* account. If the zone or DNS lives in another account, set acm_certificate_arn and point the name at the ALB in that account; you still set public_fqdn + base_domain for outputs and (with base_domain) for any in-Terraform R53."
  type        = string
  default     = null
  nullable    = true
}

variable "base_domain" {
  description = "Parent DNS name for the public hostname. Must match the Route 53 *hosted zone* you use in this account—often the zone apex (e.g. example.com) or a delegated sub-zone (e.g. dev.example.com) if the root zone is elsewhere."
  type        = string
  default     = "example.com"
}

variable "dns_subdomain" {
  description = "First label of the Agent Hub hostname, before the personal/name label (default yields agenthub.<name>.<base_domain>)."
  type        = string
  default     = "agenthub"
}

variable "route53_zone_id" {
  description = "Route 53 zone ID (same AWS account) for base_domain, used to validate ACM and optionally create an A alias to the ALB. If null, you must set acm_certificate_arn and point DNS to the load balancer yourself, or set lookup_route53_zone_in_this_account = true to resolve base_domain in this account."
  type        = string
  default     = null
}

variable "lookup_route53_zone_in_this_account" {
  description = "If true, resolve the *public* hosted zone for `base_domain` via a data source in this AWS account. Use when you do not have the zone_id string handy; the zone must exist in this account (fails the plan if missing or delegated-only elsewhere). Ignored if route53_zone_id is set non-empty."
  type        = bool
  default     = false
}

variable "create_route53_zone" {
  description = "If true, CREATE a public hosted zone for base_domain in THIS account (instead of looking one up), use it for the ACM cert + ALB A-record, and (when root_delegation_role_arn is set) write the NS delegation into the root apex zone. The dedicated-account / prod model (e.g. own zone for agenthub.example.com), vs. the piggy-back model (lookup_route53_zone_in_this_account)."
  type        = bool
  default     = false
}

variable "root_delegation_zone_id" {
  description = "Zone ID of the ROOT apex domain (e.g. example.com) in the root account, into which this env's NS delegation record is written. Only used with create_route53_zone + root_delegation_role_arn."
  type        = string
  default     = ""
}

variable "root_delegation_role_arn" {
  description = "ARN of a role in the ROOT account this account can assume to write the NS delegation (e.g. arn:aws:iam::111122223333:role/agenthub_env_role_assume). Empty = don't write the delegation (look it up / add manually)."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN in this region (e.g. imported or shared). If set, no new ACM cert is created; route53_zone_id is still used if you want Terraform to create the A alias. The cert must include the public hostname (public_fqdn or composed FQDN)."
  type        = string
  default     = null
}

variable "agent_hub_target_port" {
  description = "Port the Node/PM2 server listens on the EC2 instance (ALB targets this over HTTP in the VPC)."
  type        = number
  default     = 3051
}

variable "alb_idle_timeout" {
  description = "ALB idle timeout in seconds (raise for long-lived WebSocket streams; max 4000)."
  type        = number
  default     = 300
}

variable "alb_health_check_timeout" {
  description = "Target-group health-check response timeout (s). Default 5 suits multi-target groups; single-instance envs (e.g. prod) should use a more tolerant value (10) so a transient slowdown can't flap the only target into a site-wide 503."
  type        = number
  default     = 5
}

variable "alb_health_check_unhealthy_threshold" {
  description = "Consecutive failed health checks before a target is marked unhealthy. Default 2 = fast failover for multi-target groups; single-instance envs should use a higher value (5) to tolerate transient blips (no peer to fail over to)."
  type        = number
  default     = 2
}

variable "second_public_subnet_cidr_block" {
  description = "CIDR for the second public subnet (other AZ) used only when enable_dedicated_alb = true. Must be within vpc_cidr_block and not overlap public_subnet_cidr_block."
  type        = string
  default     = "10.0.151.0/24"
}

variable "alb_availability_zone_suffix_b" {
  description = "AZ letter for the second subnet (e.g. \"b\" for us-east-2b) — must differ from availability_zone_suffix (first subnet)."
  type        = string
  default     = "b"
}

variable "third_public_subnet_cidr_block" {
  description = "CIDR for the third public subnet (fleet-only, a 3rd AZ to widen the Spot pool). Created only when enable_finalize_runners = true. Must be within vpc_cidr_block and not overlap the other subnets."
  type        = string
  default     = "10.0.152.0/24"
}

variable "finalize_runner_third_az_suffix" {
  description = "AZ letter for the fleet's third subnet (e.g. \"c\" for us-east-2c) — must differ from the first two. Adds a 3rd Spot capacity pool for the runner ASG."
  type        = string
  default     = "c"
}

variable "alb_ingress_cidr_blocks" {
  description = "CIDRs allowed to reach the ALB on 80/443. Use a narrow CIDR to restrict the management UI (e.g. your IP/32) or 0.0.0.0/0 for public access."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "target_group_name_override" {
  description = "If set, use this as the target group `name` (max 32 chars) instead of the project+hostname hash. Set to your existing TG name (see `terraform state show aws_lb_target_group.agenthub[0]`) when only changing public_fqdn or base_domain so the TG is not replaced."
  type        = string
  default     = null
  nullable    = true
}

# --- Autonomous-dispatch cross-hub Secrets Manager IAM ----------------------

variable "enable_cross_hub_secrets_iam" {
  description = <<-DESC
    When true, attaches an inline IAM policy to the EC2 SSM instance role
    granting `secretsmanager:GetSecretValue` on
    `arn:aws:secretsmanager:*:*:secret:agent-hub/dev-hub/api-key-*` plus
    `kms:Decrypt` for the default Secrets Manager CMK.  This allows the
    Agent Hub server process to fetch the dev-hub API key at runtime and
    inject it into autonomous-dispatch sessions whose kanban card carries
    the `cross-hub:dev` label.

    Defaults to true when `enable_instance_ssm = true`; set explicitly to
    false to opt out.  Requires `enable_instance_ssm = true`.
  DESC
  type        = bool
  default     = null
  nullable    = true
}

# PR-env variables (pr_env_preview_subdomain, cert_renewal_email,
# enable_pr_env_host_nginx) were removed in PR-Env Removal #6 alongside the
# rest of the PR-env Terraform stack. See alb.tf for the teardown note.

# ── Finalize remote-runner fleet (modules/finalize-runners) ──────────────────
# All default-off so only the env that sets enable_finalize_runners builds it.
variable "enable_finalize_runners" {
  type        = bool
  default     = false
  description = "Stand up the ECS-on-EC2 Finalize runner fleet in this env."
}

variable "manage_shared_finalize_infra" {
  type        = bool
  default     = false
  description = "Create account-wide finalize S3 buckets + ECR repos here (ONE env only)."
}

variable "alb_access_logs_bucket" {
  type        = string
  default     = ""
  description = "S3 bucket name for ALB access logs. Empty disables access logging (no access_logs block). Set to the live bucket to keep logs on (prod adopts agenthub-alb-logs-<acct>)."
}

variable "enable_hub_data_volume" {
  type        = bool
  default     = false
  description = "Create the dedicated encrypted Hub data EBS volume (mounted /dev/sdf) + its DLM daily-snapshot policy. Prod-only; see hub-data.tf. Leave false in every other env."
}

variable "hub_data_volume_size" {
  type        = number
  default     = 256
  description = "Size (GiB) of the Hub data volume when enable_hub_data_volume = true."
}

variable "hub_data_kms_key_arn" {
  type        = string
  default     = ""
  description = "KMS CMK ARN encrypting the Hub data volume. Required (account-specific) when enable_hub_data_volume = true; must match the live volume's key exactly or Terraform will plan a replacement. Enforced by a precondition in hub-data.tf."
}

variable "hub_data_availability_zone" {
  type        = string
  default     = ""
  description = "AZ of the Hub data volume (e.g. us-east-2a). Required when enable_hub_data_volume = true and must match the live volume's AZ exactly. Pinned explicitly rather than derived from aws_instance.app so a future instance replacement in another AZ cannot force-replace the database volume. Enforced by a precondition in hub-data.tf."
}

variable "finalize_runner_instance_type" {
  type    = string
  default = "r7i.xlarge"
}

variable "finalize_runner_task_memory_mib" {
  type        = number
  default     = 28672
  description = "ECS soft memory reservation per runner-agent task. Sized to force one job per host (≈host RAM). Couple to the instance type: 32 GB host → ~28672; 16 GB host (m*.xlarge) → ~12288."
}

variable "finalize_runner_root_iops" {
  type        = number
  default     = 6000
  description = "gp3 provisioned IOPS for each runner's root volume. gp3's free baseline is 3000; set 3000 to drop the per-volume IOPS premium."
}

variable "finalize_runner_root_throughput" {
  type        = number
  default     = 250
  description = "gp3 provisioned throughput (MB/s) per runner root volume. gp3's free baseline is 125; set 125 to drop the per-volume throughput premium."
}

variable "finalize_runner_instance_types" {
  type = list(string)
  # The ASG mixed-instances OVERRIDE pool — this, NOT the launch template's
  # instance_type, is what the ASG actually launches. Default mirrors the
  # module's 32 GB r/m pool so envs that don't override (e.g. test) keep
  # one-job-per-host on a 28 GB reservation. For a 16 GB host + ~12 GB
  # reservation, set an all-16 GB m-family xlarge pool (see prod.tfvars).
  default = [
    "r7i.xlarge", "r6i.xlarge", "r6a.xlarge", "r7a.xlarge", "r5.xlarge",
    "m7i.2xlarge", "m6i.2xlarge", "m6a.2xlarge", "m7a.2xlarge", "m5.2xlarge",
  ]
  description = "Mixed-instances override pool for the Finalize fleet ASG. All entries must match the host size that task_memory_mib assumes (one job per host)."
}

variable "finalize_runner_use_spot" {
  type        = bool
  default     = true
  description = "Run the Finalize fleet on Spot (interruptible, ~2/3 cheaper; lost jobs retry on a fresh agent). Set false for on-demand — guaranteed launch, no UnfulfillableCapacity during a region-wide Spot crunch, ~3x the fleet compute cost. Flip back to true once Spot capacity recovers if cost matters."
}

variable "finalize_runner_ami_id" {
  type        = string
  default     = ""
  description = "Custom AMI for the Finalize runner fleet — bake the runner image into the AL2023 ECS-optimized AMI so instances skip the multi-GB boot-time `docker pull` and provision much faster. Empty = use the SSM-resolved stock AMI (same as the Hub). Fleet-only; does not affect the Hub instance. Re-bake periodically to track the base AMI + the latest runner image (the launch-template boot pull stays as a fast delta-pull / fallback)."
}

variable "finalize_runner_min_size" {
  type        = number
  default     = 0
  description = "ASG min (FINALIZE_FLEET_MIN_AGENTS). 0 = scale fully to zero when idle; set >0 only if you want a warm-pool floor of idle agents."
}

variable "finalize_runner_max_size" {
  type    = number
  default = 4
}

variable "finalize_max_reclaim_retry_generations" {
  type    = number
  default = 3
  # Max chained auto-retries the Hub will open when a Finalize run loses its
  # driving agent to an EC2 Spot reclaim (failure_reason=spot_reclaimed). Sets
  # the Hub env FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS (server/finalize/
  # infra-retry.ts default 3). On a Spot fleet, raise this so a long job (e.g.
  # heavy E2E shards) survives a *correlated* reclaim wave instead of exhausting
  # the budget and terminating green code as infra_error. Reclaim retries reuse
  # the same session/worktree and a reclaim-aborted attempt's active time is
  # non-billable (budget.ts), so a higher cap costs little but recovers more.
  description = "FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS for the Hub — spot-reclaim auto-retry depth. Raise on a Spot fleet to survive correlated reclaim waves."

  validation {
    condition     = var.finalize_max_reclaim_retry_generations >= 1
    error_message = "finalize_max_reclaim_retry_generations must be >= 1 (always allow at least the historical single retry)."
  }
}

variable "finalize_task_protection_expiry_minutes" {
  type    = number
  default = 15
  # Runner-agent ECS task-protection lease (FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES,
  # ecs-task-protection.ts default 15). On a fleet with dynamic scale-down on, a
  # mid-run scale-in terminates whichever in-flight shard has the weakest
  # protection — and the LONGEST shards are the ones in flight when a shrink fires.
  # Set this ABOVE the longest expected shard so even a refresh-starved long job
  # stays shielded for its full duration. Lives in the agent image, so a change
  # only takes effect once the finalize-runner image rolls.
  description = "Runner-agent task-protection lease length (minutes). Raise above the longest shard when dynamic scale-down is on."

  validation {
    # ECS UpdateTaskProtection accepts expiresInMinutes only in [1, 2880]; a value
    # above 2880 passes silently here and then fails the runner's protection call
    # at runtime. Bound both ends at plan/apply time.
    condition = (
      var.finalize_task_protection_expiry_minutes >= 1
      && var.finalize_task_protection_expiry_minutes <= 2880
    )
    error_message = "finalize_task_protection_expiry_minutes must be between 1 and 2880 (the ECS task-protection expiresInMinutes limit)."
  }
}

variable "finalize_fleet_dynamic_scale_down" {
  type    = bool
  default = false
  # Sets the Hub env FINALIZE_FLEET_DYNAMIC_SCALE_DOWN (runner-fleet-scaler.ts).
  # false (default) = SAFE scale-down: the fleet only shrinks when the queue is
  # FULLY drained (depth 0). On a busy fleet with a continuous trickle of runs,
  # depth never hits 0, so a high-water set during a reclaim/burst wave stays
  # pinned (observed 2026-06-23: desiredCount frozen at 56 with only ~4 real
  # jobs). true = DYNAMIC: also trims IDLE agents mid-run down to
  # inflight + warm_headroom, leaning on ECS task scale-in protection to keep
  # busy shards alive (target is always >= inflight, so a shrink never kills a
  # running job). Recommended true for a steadily-loaded fleet.
  description = "FINALIZE_FLEET_DYNAMIC_SCALE_DOWN for the Hub — trim idle agents mid-run instead of only at full drain. Recommended true on a busy fleet."
}

variable "finalize_runner_root_volume_size" {
  type    = number
  default = 200
}

variable "finalize_agent_desired_count" {
  type    = number
  default = 1
}

variable "finalize_agent_image_uri" {
  type        = string
  default     = ""
  description = "Image running the runner-agent; defaults to the finalize-runner image."
}

variable "finalize_fleet_token_secret_arn" {
  type        = string
  default     = ""
  description = "Secrets Manager ARN of an EXISTING shared fleet token. Leave empty to have Terraform generate the token + create the secret (the dedicated-account / prod model)."
}

variable "enable_finalize_registry_mirror" {
  type        = bool
  default     = true
  description = "Run a registry:2 pull-through cache on the Hub (port 5000) for base images, shared fleet-wide; sets FINALIZE_REGISTRY_MIRROR in the job env. Inner dockerds mirror docker.io through it. On by default: cuts runner cold start (base images served from the in-VPC cache) and avoids Docker Hub anonymous 429s across shards. Set false to pull straight from Docker Hub."
}

variable "finalize_dockerhub_secret_arn" {
  type        = string
  default     = ""
  description = "Optional Secrets Manager ARN ({username,accessToken}) for authenticating the registry mirror's Docker Hub upstream (avoids anonymous 429s). Empty = anonymous proxy."
}

variable "finalize_cache_bucket_name" {
  type    = string
  default = ""
}

variable "finalize_worktree_bucket_name" {
  type    = string
  default = ""
}

# ── Session artifacts + RUM replay S3 storage ────────────────────────────────
variable "enable_artifacts_bucket" {
  type        = bool
  default     = false
  description = "Create the S3 bucket for session artifacts + RUM session-replay segments, grant the Hub EC2 instance role object + lifecycle access, and inject AGENT_HUB_ARTIFACTS_BUCKET into the Hub env. When off (default), getArtifactStore() falls back to the local data dir (<dataDir>/artifacts) and replays persist on the hub-data volume."
}

variable "artifacts_bucket_name" {
  type        = string
  default     = ""
  description = "S3 bucket name for session artifacts + RUM replay segments. Required when enable_artifacts_bucket = true; injected as AGENT_HUB_ARTIFACTS_BUCKET (region = aws_region)."
}

# ── Session replay policy ────────────────────────────────────────────────────
variable "replay_retention_days" {
  type        = number
  default     = 14
  description = "Global session-replay retention window in days. Zero keeps replay rows/blobs indefinitely; project settings may tighten this window. Injected as AGENT_HUB_REPLAY_RETENTION_DAYS."

  validation {
    condition     = var.replay_retention_days >= 0 && var.replay_retention_days <= 400 && floor(var.replay_retention_days) == var.replay_retention_days
    error_message = "replay_retention_days must be a whole number between 0 and 400 days."
  }
}

variable "replay_mask_all_enforced" {
  type        = bool
  default     = true
  description = "Default mask-all policy for continuous replay when a project has no explicit override. Set false for staging/test environments that need readable replay content. Injected as AGENT_HUB_REPLAY_MASK_ALL_ENFORCED."
}
