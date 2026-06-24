# Hub-side wiring for the remote Finalize fleet: the fleet token (TF-generated
# unless an existing ARN is supplied) and the FINALIZE_* env the Hub container
# needs to dispatch to + autoscale the fleet. Injected into the Hub's .env via
# locals-agent-hub.tf (docker_bootstrap_env). Gated on enable_finalize_runners,
# so non-fleet envs are unaffected.

locals {
  # TF owns the token only when no existing secret ARN was supplied (prod /
  # dedicated-account). When an ARN is given (e.g. the test env's manual secret),
  # leave the token + secret alone — the Hub .env token stays managed out-of-band.
  finalize_create_fleet_token = var.enable_finalize_runners && trimspace(var.finalize_fleet_token_secret_arn) == ""
}

resource "random_password" "finalize_fleet_token" {
  count   = local.finalize_create_fleet_token ? 1 : 0
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "finalize_fleet_token" {
  count       = local.finalize_create_fleet_token ? 1 : 0
  name        = "agent-hub/finalize/${var.project_name}-fleet-token"
  description = "Finalize runner fleet registration token (Hub validates /register; agents read it)."
  tags        = { Project = var.project_name }
}

resource "aws_secretsmanager_secret_version" "finalize_fleet_token" {
  count         = local.finalize_create_fleet_token ? 1 : 0
  secret_id     = aws_secretsmanager_secret.finalize_fleet_token[0].id
  secret_string = random_password.finalize_fleet_token[0].result
}

locals {
  # ARN handed to the fleet agents (ECS secret) — the TF-created one, or the
  # supplied existing ARN.
  finalize_fleet_token_secret_arn_effective = (
    local.finalize_create_fleet_token
    ? aws_secretsmanager_secret.finalize_fleet_token[0].arn
    : var.finalize_fleet_token_secret_arn
  )

  # FINALIZE_* lines appended to the Hub container's .env. The runner IMAGE env
  # (FINALIZE_RUNNER_IMAGE_UBUNTU_24_04) is set by the run script's -e flag from
  # finalize_runner_image_uri, and FINALIZE_REGISTRY_MIRROR is appended at boot in
  # user-data (it needs the instance's own private IP), so neither is here.
  finalize_hub_fleet_env = var.enable_finalize_runners ? concat(
    [
      "FINALIZE_RUNNER_BACKEND=remote",
      "FINALIZE_WORKTREE_BUCKET=${var.finalize_worktree_bucket_name}",
      "FINALIZE_WORKTREE_BUCKET_REGION=${var.aws_region}",
      "AWS_REGION=${var.aws_region}",
      "FINALIZE_FLEET_ECS_CLUSTER=${var.project_name}-finalize-runner",
      "FINALIZE_FLEET_ECS_SERVICE=${var.project_name}-finalize-runner-agent",
      "FINALIZE_FLEET_MIN_AGENTS=${tostring(var.finalize_runner_min_size)}",
      "FINALIZE_FLEET_MAX_AGENTS=${tostring(var.finalize_runner_max_size)}",
      "FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS=${tostring(var.finalize_max_reclaim_retry_generations)}",
    ],
    var.finalize_fleet_dynamic_scale_down ? ["FINALIZE_FLEET_DYNAMIC_SCALE_DOWN=1"] : [],
    local.finalize_create_fleet_token
    ? ["FINALIZE_RUNNER_FLEET_TOKEN=${random_password.finalize_fleet_token[0].result}"]
    : [],
  ) : []
}

# The fleet -> Hub registry:2 mirror ingress (port 5000) is an INLINE ingress
# block on aws_security_group.instance (see main.tf). It must NOT be a standalone
# aws_vpc_security_group_ingress_rule: inline ingress on that SG is authoritative
# and revokes standalone rules on every apply (which silently broke this mirror).

# Let the Hub (at boot, in user-data) read the Docker Hub cred for the mirror's
# authenticated upstream. Only when a secret ARN is configured.
resource "aws_iam_role_policy" "hub_dockerhub_secret_read" {
  count = var.enable_finalize_registry_mirror && var.enable_instance_ssm && trimspace(var.finalize_dockerhub_secret_arn) != "" ? 1 : 0
  name  = "finalize-dockerhub-secret-read"
  role  = aws_iam_role.ec2_ssm[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [var.finalize_dockerhub_secret_arn]
    }]
  })
}
