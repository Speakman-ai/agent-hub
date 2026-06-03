# GitHub Actions → AWS via OIDC. The provider already exists on the dev account
# (created manually earlier); we reference it via a data source rather than
# creating a second one. Trust policy matches push-image.yml triggers:
#   - push to main       (regular releases: push :<sha> and :main)
#   - workflow_dispatch  (manual one-off; main only — add branches explicitly if needed)
#
# To import an existing role from a prior bootstrap:
#   terraform import aws_iam_role.gha_ecr_push agent-hub-ci-ecr-push

data "aws_iam_openid_connect_provider" "github" {
  count = var.manage_github_oidc_role ? 1 : 0

  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "gha_ecr_push" {
  count = var.manage_github_oidc_role ? 1 : 0

  name        = var.github_oidc_role_name
  description = "Assumed by GitHub Actions (${var.github_repo_owner}/${var.github_repo_name}) to push images to ECR Public."
  path        = "/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          # Scoped to match push-image.yml triggers: push to main + workflow_dispatch.
          StringLike = {
            "token.actions.githubusercontent.com:sub" = [
              "repo:${var.github_repo_owner}/${var.github_repo_name}:ref:refs/heads/main",
              "repo:${var.github_repo_owner}/${var.github_repo_name}:environment:*",
              "repo:${var.github_repo_owner}/${var.github_repo_name}:ref:refs/tags/*",
            ]
          }
        }
      }
    ]
  })

  tags = {
    Name    = var.github_oidc_role_name
    Project = var.project_name
  }
}

# Scoped policy: push only to the agent-hub public repo. No wildcard across
# the account's ECR Public namespace.
resource "aws_iam_role_policy" "gha_ecr_push" {
  count = var.manage_github_oidc_role ? 1 : 0

  name = "${var.github_oidc_role_name}-policy"
  role = aws_iam_role.gha_ecr_push[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Authorization token is a registry-wide operation — no resource constraint.
        Effect = "Allow"
        Action = [
          "ecr-public:GetAuthorizationToken",
          "sts:GetServiceBearerToken"
        ]
        Resource = "*"
      },
      {
        # Push operations scoped to the single agent-hub repo.
        Effect = "Allow"
        Action = [
          "ecr-public:BatchCheckLayerAvailability",
          "ecr-public:InitiateLayerUpload",
          "ecr-public:UploadLayerPart",
          "ecr-public:CompleteLayerUpload",
          "ecr-public:PutImage",
          "ecr-public:DescribeRepositories",
          "ecr-public:DescribeImages",
          "ecr-public:ListImages",
          "ecr-public:DescribeImageTags"
        ]
        # Note: ECR Public repo ARNs are account-scoped, not region-scoped.
        Resource = [
          "arn:aws:ecr-public::${data.aws_caller_identity.current.account_id}:repository/${var.ecr_public_repo_name}",
          "arn:aws:ecr-public::${data.aws_caller_identity.current.account_id}:repository/${var.ecr_public_finalize_runner_repo_name}",
        ]
      }
    ]
  })
}

data "aws_caller_identity" "current" {}

output "github_oidc_role_arn" {
  description = "IAM role GitHub Actions should assume to push images."
  value = (
    var.manage_github_oidc_role
    ? aws_iam_role.gha_ecr_push[0].arn
    : null
  )
}
