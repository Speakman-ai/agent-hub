# Optional: let the GitHub Actions OIDC role (same role as ECR push) restart the
# dev sandbox via SSM after each successful image push (.github/workflows/push-image.yml).
#
# Apply from exactly one workspace per AWS account (e.g. enable it in only one
# environments/<env>/<env>.tfvars) so the inline policy is not doubly-managed.
#
# Targeting the deploy box: set `ci_ssm_deploy_instance_tags` (recommended),
# `ci_ssm_deploy_instance_id`, or both. The tag map is resolved to concrete
# instance ids at plan time and unioned with the explicit id, so the grant stays
# scoped to real instance ARNs (never `instance/*` plus a request-time tag
# condition, which mutable tags could widen). Tag targeting is what survives the
# box being rebuilt: the workflow reads its target from the
# DOCKER_DEPLOY_INSTANCE_ID repo Variable while this policy reads it from the
# operator's private tfvars, and when a replacement instance flipped one side
# without the other, CI died on `AccessDeniedException ... ssm:SendCommand`.

# Look the role up externally ONLY when this workspace doesn't create it. When
# manage_github_oidc_role=true the role is created in github-oidc.tf in the same
# apply, so a data-source read would fail on a fresh account (role not yet
# created) — reference the resource directly instead.
data "aws_iam_role" "github_actions_ecr_push" {
  count = local.ci_ssm_deploy_enabled && !var.manage_github_oidc_role ? 1 : 0
  name  = var.github_oidc_role_name
}

# Resolved during plan (config is fully known), so `.ids` is available to the
# policy below without an apply-time unknown. Stopped/pending states are
# included: a sandbox that happens to be stopped at release time is still the
# deploy target, and dropping it from the grant would break the next rollout.
data "aws_instances" "ci_ssm_deploy_targets" {
  count = local.ci_ssm_tag_lookup_enabled ? 1 : 0

  instance_tags        = var.ci_ssm_deploy_instance_tags
  instance_state_names = ["pending", "running", "stopping", "stopped"]
}

locals {
  # `ci_ssm_deploy_enabled` gates resource counts, so it may only depend on
  # inputs — never on resolved instance ids. The "did anything actually
  # resolve?" question is a precondition on the policy instead.
  ci_ssm_tag_lookup_enabled = var.enable_ci_ssm_deploy_after_ecr_push && length(var.ci_ssm_deploy_instance_tags) > 0
  ci_ssm_instance_id        = trimspace(var.ci_ssm_deploy_instance_id)
  ci_ssm_deploy_enabled = var.enable_ci_ssm_deploy_after_ecr_push && (
    local.ci_ssm_instance_id != "" || length(var.ci_ssm_deploy_instance_tags) > 0
  )
  ci_ssm_account_id = data.aws_caller_identity.current.account_id

  ci_ssm_discovered_instance_ids = local.ci_ssm_tag_lookup_enabled ? data.aws_instances.ci_ssm_deploy_targets[0].ids : []

  ci_ssm_target_instance_ids = sort(toset(concat(
    local.ci_ssm_instance_id != "" ? [local.ci_ssm_instance_id] : [],
    local.ci_ssm_discovered_instance_ids,
  )))
  ci_ssm_target_instance_arns = [
    for id in local.ci_ssm_target_instance_ids :
    "arn:aws:ec2:${var.aws_region}:${local.ci_ssm_account_id}:instance/${id}"
  ]

  ci_ssm_deploy_role_name = local.ci_ssm_deploy_enabled ? (
    var.manage_github_oidc_role
    ? aws_iam_role.gha_ecr_push[0].name
    : data.aws_iam_role.github_actions_ecr_push[0].name
  ) : null
}

resource "aws_iam_role_policy" "github_actions_ecr_push_ssm_dev_deploy" {
  count = local.ci_ssm_deploy_enabled ? 1 : 0

  name = "agent-hub-ci-ssm-deploy-after-ecr-push"
  role = local.ci_ssm_deploy_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Ec2DescribeForSsmTargets"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      },
      {
        Sid    = "SendRunShellScriptToDeployTarget"
        Effect = "Allow"
        Action = [
          "ssm:SendCommand"
        ]
        Resource = concat(local.ci_ssm_target_instance_arns, [
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
          "arn:aws:ssm:${var.aws_region}:${local.ci_ssm_account_id}:document/AWS-RunShellScript",
          # Run Command creation also evaluates in-account ephemeral resources for the invocation.
          "arn:aws:ssm:${var.aws_region}:${local.ci_ssm_account_id}:*"
        ])
      },
      {
        Sid    = "ReadCommandInvocation"
        Effect = "Allow"
        Action = [
          "ssm:GetCommandInvocation",
          "ssm:ListCommandInvocations",
          "ssm:ListCommands",
          "ssm:DescribeDocument",
          "ssm:GetDocument"
        ]
        Resource = "*"
      }
    ]
  })

  # A tag map that matches nothing would otherwise ship a policy whose only
  # SendCommand resources are document ARNs: apply succeeds, then every rollout
  # fails with AccessDenied. Fail here instead, where the message can say why.
  lifecycle {
    precondition {
      condition     = length(local.ci_ssm_target_instance_ids) > 0
      error_message = "enable_ci_ssm_deploy_after_ecr_push = true resolved zero deploy targets. Set ci_ssm_deploy_instance_id to the instance CI restarts, and/or ci_ssm_deploy_instance_tags to a tag map matching it (e.g. { Name = \"agenthub-dev-sandbox\" }) in this workspace's region. The target must match the DOCKER_DEPLOY_INSTANCE_ID repo Variable used by .github/workflows/ecr-publish-rollout-docker-dev.yml."
    }
  }
}

output "ci_ssm_deploy_target_instance_ids" {
  description = "Instance ids the CI role may SSM after an ECR push. Must contain the DOCKER_DEPLOY_INSTANCE_ID repo Variable."
  value       = local.ci_ssm_target_instance_ids
}
