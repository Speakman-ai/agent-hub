# Finalize remote-runner fleet — instantiated only where enabled (test env).
# DRAFT: pending `terraform validate`/`plan`. Default-off so ryan and every other
# env create zero new resources. `apply` is a deliberate, confirmed step.

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
  min_size            = var.finalize_runner_min_size
  max_size            = var.finalize_runner_max_size
  root_volume_size    = var.finalize_runner_root_volume_size
  agent_desired_count = var.finalize_agent_desired_count
  spot                = var.finalize_runner_use_spot

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
# it mints is valid). Gated on the fleet being enabled — zero effect on ryan.
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
    Statement = [{
      Effect = "Allow"
      Action = ["ecs:UpdateService", "ecs:DescribeServices"]
      Resource = [
        "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${var.project_name}-finalize-runner/${var.project_name}-finalize-runner-agent",
      ]
    }]
  })
}
