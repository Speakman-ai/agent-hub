# Optional: let the GitHub Actions OIDC role (same role as ECR push) restart the
# dev sandbox via SSM after each successful image push (.github/workflows/push-image.yml).
#
# Apply from exactly one workspace per AWS account (e.g. enable only in
# environments/ryan/ryan.tfvars) so the inline policy is not doubly-managed.

# Look the role up externally ONLY when this workspace doesn't create it. When
# manage_github_oidc_role=true the role is created in github-oidc.tf in the same
# apply, so a data-source read would fail on a fresh account (role not yet
# created) — reference the resource directly instead.
data "aws_iam_role" "github_actions_ecr_push" {
  count = local.ci_ssm_deploy_enabled && !var.manage_github_oidc_role ? 1 : 0
  name  = var.github_oidc_role_name
}

locals {
  ci_ssm_deploy_enabled = var.enable_ci_ssm_deploy_after_ecr_push && trimspace(var.ci_ssm_deploy_instance_id) != ""
  ci_ssm_account_id     = data.aws_caller_identity.current.account_id
  ci_ssm_instance_id    = trimspace(var.ci_ssm_deploy_instance_id)
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
        Resource = [
          "arn:aws:ec2:${var.aws_region}:${local.ci_ssm_account_id}:instance/${local.ci_ssm_instance_id}",
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
          "arn:aws:ssm:${var.aws_region}:${local.ci_ssm_account_id}:document/AWS-RunShellScript",
          # Run Command creation also evaluates in-account ephemeral resources for the invocation.
          "arn:aws:ssm:${var.aws_region}:${local.ci_ssm_account_id}:*"
        ]
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
}
