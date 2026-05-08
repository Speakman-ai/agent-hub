# Optional: let the GitHub Actions OIDC role (same role as ECR push) restart the
# dev sandbox via SSM after each successful image push (.github/workflows/push-image.yml).
#
# Apply from exactly one workspace per AWS account (e.g. enable only in
# environments/ryan/ryan.tfvars) so the inline policy is not doubly-managed.

data "aws_iam_role" "github_actions_ecr_push" {
  count = local.ci_ssm_deploy_enabled ? 1 : 0
  name  = var.github_oidc_role_name
}

locals {
  ci_ssm_deploy_enabled = var.enable_ci_ssm_deploy_after_ecr_push && trimspace(var.ci_ssm_deploy_instance_id) != ""
}

resource "aws_iam_role_policy" "github_actions_ecr_push_ssm_dev_deploy" {
  count = local.ci_ssm_deploy_enabled ? 1 : 0

  name = "agent-hub-ci-ssm-deploy-after-ecr-push"
  role = data.aws_iam_role.github_actions_ecr_push[0].name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SendRunShellScriptToDeployTarget"
        Effect = "Allow"
        Action = [
          "ssm:SendCommand"
        ]
        Resource = [
          "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${trimspace(var.ci_ssm_deploy_instance_id)}",
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"
        ]
      },
      {
        Sid    = "ReadCommandInvocation"
        Effect = "Allow"
        Action = [
          "ssm:GetCommandInvocation",
          "ssm:ListCommandInvocations"
        ]
        Resource = "*"
      }
    ]
  })
}
