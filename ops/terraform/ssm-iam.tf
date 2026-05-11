# Systems Manager Session Manager: connect without SSH keys.
# See outputs ssm_start_session_one_liner, ssm_secrets_manager (optional) in outputs.tf

# Region for kms:ViaService scoping in the SSM secrets policy below. Declared
# here (vs a generic data.tf) because it's the only consumer in this module.
data "aws_region" "current" {}

resource "aws_iam_role" "ec2_ssm" {
  count = var.enable_instance_ssm ? 1 : 0

  name = "${var.project_name}-ec2-ssm"
  path = "/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-ec2-ssm"
  }
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  count = var.enable_instance_ssm ? 1 : 0

  role       = aws_iam_role.ec2_ssm[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2_ssm" {
  count = var.enable_instance_ssm ? 1 : 0

  name = "${var.project_name}-ssm"
  path = "/"
  role = aws_iam_role.ec2_ssm[0].name

  tags = {
    Name = "${var.project_name}-ssm"
  }
}

# PR-env IAM policies (pr_env_route53, pr_env_ssm_secrets) were removed in
# PR-Env Removal #6 alongside the rest of the PR-env Terraform stack. See
# alb.tf for the teardown note.

# --- Autonomous-dispatch cross-hub API key (Secrets Manager) ------------------
#
# Grants the EC2 instance role `secretsmanager:GetSecretValue` on the
# per-user `ahub_*` key provisioned on the dev hub and stored at
# `agent-hub/dev-hub/api-key`.  The wildcard suffix (`-*`) covers the
# 6-char rotation ID that AWS appends to every secret ARN — without it a
# `PutSecretValue` rotation would create a new ARN suffix and immediately
# break access even though the logical secret name is unchanged.
#
# The kms:Decrypt grant below covers the default Secrets Manager CMK
# (`alias/aws/secretsmanager`); operators who use a customer-managed CMK
# must add the key's ARN here explicitly.
#
# Gate: `enable_cross_hub_secrets_iam` (default true when
# `enable_instance_ssm = true`).  Flip to false in tfvars to opt out.

resource "aws_iam_role_policy" "cross_hub_secrets" {
  count = local.cross_hub_secrets_iam_enabled ? 1 : 0

  name = "${var.project_name}-cross-hub-secrets"
  role = aws_iam_role.ec2_ssm[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadDevHubApiKey"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        # Wildcard suffix matches the rotation-ID postfix AWS appends to ARNs.
        Resource = "arn:aws:secretsmanager:${data.aws_region.current.name}:*:secret:agent-hub/dev-hub/api-key-*"
      },
      {
        # kms:Decrypt is required for any KMS-encrypted secret. Resource = "*"
        # combined with the kms:ViaService condition effectively scopes this to
        # any CMK used via Secrets Manager in this region — including the AWS
        # managed default key (alias/aws/secretsmanager) AND any customer-managed
        # CMK accessed through Secrets Manager. It does NOT grant general KMS
        # decrypt across the account; the ViaService condition is the binding
        # constraint. Operators who want tighter scoping can replace "*" with the
        # specific CMK ARN(s) for their secrets.
        Sid      = "DecryptViaSecretsManager"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      },
    ]
  })

  lifecycle {
    precondition {
      condition     = !local.cross_hub_secrets_iam_enabled || var.enable_instance_ssm
      error_message = "cross_hub_secrets_iam is enabled but enable_instance_ssm = false. The inline policy attaches to the SSM EC2 instance role; set enable_instance_ssm = true, or set enable_cross_hub_secrets_iam = false to skip the inline policy."
    }
  }
}
