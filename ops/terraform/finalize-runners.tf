# Finalize remote-runner fleet — instantiated only where enabled (test env).
# DRAFT: pending `terraform validate`/`plan`. Default-off so every env creates
# zero new resources. `apply` is a deliberate, confirmed step.

module "finalize_runners" {
  count  = var.enable_finalize_runners ? 1 : 0
  source = "./modules/finalize-runners"

  project_name = var.project_name
  aws_region   = var.aws_region

  # Reuse the root VPC / subnets. AMI: a fleet-specific baked AMI (runner image
  # pre-pulled, for fast provisioning) when set, else the stock SSM-resolved AMI.
  vpc_id     = aws_vpc.main.id
  subnet_ids = concat([aws_subnet.public.id], aws_subnet.public_b[*].id, aws_subnet.public_c[*].id)
  ami_id = (
    trimspace(var.finalize_runner_ami_id) != ""
    ? var.finalize_runner_ami_id
    : local.effective_ami_id
  )

  instance_type       = var.finalize_runner_instance_type
  instance_types      = var.finalize_runner_instance_types
  min_size            = var.finalize_runner_min_size
  max_size            = var.finalize_runner_max_size
  root_volume_size    = var.finalize_runner_root_volume_size
  root_iops           = var.finalize_runner_root_iops
  root_throughput     = var.finalize_runner_root_throughput
  task_memory_mib     = var.finalize_runner_task_memory_mib
  agent_desired_count = var.finalize_agent_desired_count
  spot                = var.finalize_runner_use_spot

  task_protection_expiry_minutes = var.finalize_task_protection_expiry_minutes

  agent_image_uri = (
    trimspace(var.finalize_agent_image_uri) != ""
    ? var.finalize_agent_image_uri
    : local.agent_hub_finalize_runner_image_uri
  )
  hub_url = (
    var.public_fqdn != null && trimspace(var.public_fqdn) != ""
    ? "https://${trimsuffix(trimspace(var.public_fqdn), "/")}"
    : ""
  )
  fleet_token_secret_arn = local.finalize_fleet_token_secret_arn_effective

  manage_shared_finalize_infra = var.manage_shared_finalize_infra
  cache_bucket_name            = var.finalize_cache_bucket_name
  worktree_bucket_name         = var.finalize_worktree_bucket_name

  tags = { Project = var.project_name }
}

# The Hub (remote backend) uploads one worktree bundle per run to the worktree
# bucket and presigns a GET URL each fleet agent fetches credential-free. So the
# Hub's instance role needs PutObject (upload) + GetObject (so the presigned URL
# it mints is valid). Gated on the fleet being enabled — zero effect when off.
resource "aws_iam_role_policy" "hub_worktree_s3" {
  count = var.enable_finalize_runners && var.enable_instance_ssm ? 1 : 0
  name  = "finalize-worktree-s3"
  role  = aws_iam_role.ec2_ssm[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = ["arn:aws:s3:::${var.finalize_worktree_bucket_name}/*"]
    }]
  })
}

# The Hub's queue-depth autoscaler sets the agent ECS service's desiredCount to
# run jobs concurrently (and back to zero when idle). Grant the Hub instance role
# the minimal ECS controls on this env's fleet service only.
resource "aws_iam_role_policy" "hub_fleet_scale" {
  count = var.enable_finalize_runners && var.enable_instance_ssm ? 1 : 0
  name  = "finalize-fleet-scale"
  role  = aws_iam_role.ec2_ssm[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = [
          "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${var.project_name}-finalize-runner/${var.project_name}-finalize-runner-agent",
        ]
      },
      {
        # Hub-driven task scale-in protection (hub-task-protection.ts): the Hub
        # arms/clears protection on the runner-agent tasks in lockstep with the
        # queue lease (claim/heartbeat/finish), so a busy shard can't be killed by
        # a dynamic scale-in. UpdateTaskProtection acts on TASKS, not the service,
        # so it needs its own statement scoped to this cluster's tasks.
        Effect   = "Allow"
        Action   = ["ecs:UpdateTaskProtection"]
        Resource = ["arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${var.project_name}-finalize-runner/*"]
      },
    ]
  })
}

# ── Quota guard: fleet ceiling can never outrun the live On-Demand vCPU quota ──
# One agent == one instance. An ON-DEMAND fleet draws from the "Running On-Demand
# Standard" vCPU quota (L-1216C47A). The active override pool is all m-family
# xlarge (4 vCPU), but this guard deliberately sizes against a more conservative
# 8 vCPU/agent worst case plus a baseline for the Hub and any other on-demand
# usage, so swapping in a larger instance type later can't silently breach quota.
# This reads the LIVE quota and FAILS the plan if finalize_runner_max_size would
# exceed it — so a future bump past the approved quota is blocked at plan time,
# not just discouraged by a comment. (Spot fleets draw from a different quota, so
# the guard only applies when use_spot = false.)
data "aws_servicequotas_service_quota" "finalize_ondemand_vcpu" {
  count        = var.enable_finalize_runners && !var.finalize_runner_use_spot ? 1 : 0
  service_code = "ec2"
  quota_code   = "L-1216C47A" # Running On-Demand Standard (A,C,D,H,I,M,R,T,Z) instances
}

locals {
  finalize_worst_case_vcpu_per_agent = 8  # conservative margin: 2x the all-xlarge pool's 4 vCPU
  finalize_nonfleet_baseline_vcpu    = 16 # Hub + headroom for other on-demand usage
  finalize_fleet_worst_case_vcpu = (
    var.finalize_runner_max_size * local.finalize_worst_case_vcpu_per_agent
    + local.finalize_nonfleet_baseline_vcpu
  )
}

resource "terraform_data" "finalize_quota_guard" {
  count = var.enable_finalize_runners && !var.finalize_runner_use_spot ? 1 : 0

  # No arguments: a marker whose only job is to carry the precondition, which
  # Terraform evaluates on every plan/apply (even with no resource changes).
  lifecycle {
    precondition {
      condition     = local.finalize_fleet_worst_case_vcpu <= data.aws_servicequotas_service_quota.finalize_ondemand_vcpu[0].value
      error_message = "finalize_runner_max_size (${var.finalize_runner_max_size}) needs up to ${local.finalize_fleet_worst_case_vcpu} On-Demand Standard vCPUs worst-case (8 vCPU/agent + ${local.finalize_nonfleet_baseline_vcpu} baseline), but the live EC2 quota L-1216C47A in this account/region is only ${data.aws_servicequotas_service_quota.finalize_ondemand_vcpu[0].value}. Raise the AWS quota first (and wait for approval), or lower finalize_runner_max_size."
    }
  }
}
