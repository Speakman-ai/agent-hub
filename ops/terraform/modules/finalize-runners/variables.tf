# Inputs for the Finalize remote-runner fleet (ECS-on-EC2, privileged DinD).
# DRAFT — pending `terraform validate` / `plan` on the box (authored without
# local AWS creds). `apply` is a deliberate, confirmed step (test env only).

variable "project_name" {
  type        = string
  description = "Resource-name prefix (matches the root module)."
}

variable "aws_region" {
  type = string
}

# ── Reused root networking / AMI (passed in from the root module) ────────────
variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type        = list(string)
  description = "Public subnets to place runner instances in (reuse the root's)."
}

variable "ami_id" {
  type        = string
  description = "ECS-optimized AL2023 AMI id (reuse the root's resolved AMI)."
}

# ── Fleet sizing / behavior ──────────────────────────────────────────────────
variable "instance_type" {
  type        = string
  default     = "r7i.xlarge" # 4 vCPU / 32 GB — memory-bound; one job per task
  description = "Runner EC2 instance type (default launch-template type / first override)."
}

variable "spot" {
  type        = bool
  default     = true
  description = "Run the fleet on Spot (interruptible — CI re-runs; ~⅔ cheaper). false = on-demand."
}

variable "instance_types" {
  type = list(string)
  # All 4 vCPU / 32 GB, so each fits exactly one ~28 GB job. Diversifying across
  # families/generations widens the Spot pool → far fewer interruptions / launch
  # failures than a single type.
  default     = ["r7i.xlarge", "r6i.xlarge", "r5.xlarge", "r6a.xlarge"]
  description = "Instance types for the mixed-instances Spot pool."
}

variable "min_size" {
  type        = number
  default     = 0 # scale-to-zero when idle
  description = "ASG minimum (set >=1 for a warm pool / Phase-2a always-on)."
}

variable "max_size" {
  type    = number
  default = 4
}

variable "root_volume_size" {
  type    = number
  default = 200
}

variable "agent_desired_count" {
  type        = number
  default     = 1
  description = "Desired runner-agent tasks (the queue-depth scaler adjusts this in 2b)."
}

# ── Agent task ──────────────────────────────────────────────────────────────
variable "agent_image_uri" {
  type        = string
  description = "Image running the runner-agent (finalize-runner image + agent code)."
}

variable "hub_url" {
  type        = string
  description = "Base URL the agent dials for the control plane (the Hub/ALB)."
}

variable "fleet_token_secret_arn" {
  type        = string
  description = "Secrets Manager ARN holding the shared fleet token (FINALIZE_RUNNER_FLEET_TOKEN)."
}

variable "task_memory_mib" {
  type    = number
  default = 28672 # ~28 GB on a 32 GB box → one job per instance (no co-schedule OOM)
}

# ── Shared infra (managed in exactly one env) ────────────────────────────────
variable "manage_shared_finalize_infra" {
  type        = bool
  default     = false
  description = "Create the account-wide S3 buckets + ECR repos here (one env only)."
}

variable "cache_bucket_name" {
  type = string
}

variable "worktree_bucket_name" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
