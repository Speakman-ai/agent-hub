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

# --- PR Envs: Route 53 write permissions for per-PR DNS + DNS-01 ACME --------
#
# Inline policy on the EC2 SSM instance role. ChangeResourceRecordSets and
# ListResourceRecordSets are scoped to the discovered hosted zone for
# base_domain; route53:GetChange must use change/* (change IDs are dynamic and
# AWS rejects a hostedzone-scoped resource for that action). Default-disabled
# via local.pr_env_route53_iam_enabled.

resource "aws_iam_role_policy" "pr_env_route53" {
  # Gate on the feature flag only — the lifecycle.precondition blocks below
  # surface enable_instance_ssm / has_route53_zone misconfigurations at plan
  # time. A wider `count` expression (e.g. && var.enable_instance_ssm) would
  # silently evaluate to 0 and bypass the preconditions, leaving the operator
  # with a confusing runtime IAM error instead of a plan-time message — same
  # pattern as aws_acm_certificate.pr_env_wildcard in alb.tf.
  count = local.pr_env_route53_iam_enabled ? 1 : 0

  name = "${var.project_name}-pr-env-route53"
  role = aws_iam_role.ec2_ssm[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ManagePrEnvRecordsInZone"
        Effect = "Allow"
        Action = [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
        ]
        Resource = "arn:aws:route53:::hostedzone/${local.route53_zone_id_effective}"
      },
      {
        # certbot-dns-route53 calls ListHostedZones to auto-discover the zone
        # that owns the cert's domain. AWS only honors this action with a
        # Resource of "*" — there is no per-zone scope for the list operation.
        # Without this, first-boot wildcard cert issuance fails with:
        #   AccessDenied: ... is not authorized to perform: route53:ListHostedZones
        Sid      = "DiscoverHostedZoneForCertbot"
        Effect   = "Allow"
        Action   = "route53:ListHostedZones"
        Resource = "*"
      },
      {
        Sid      = "PollChangeStatus"
        Effect   = "Allow"
        Action   = "route53:GetChange"
        Resource = "arn:aws:route53:::change/*"
      },
    ]
  })

  lifecycle {
    precondition {
      condition     = !local.pr_env_route53_iam_enabled || var.enable_instance_ssm
      error_message = "PR-env Route 53 IAM is enabled (enable_pr_environments = true, or enable_pr_env_route53_iam = true) but enable_instance_ssm = false. The inline policy attaches to the SSM EC2 instance role; set enable_instance_ssm = true, or set enable_pr_environments = false (or enable_pr_env_route53_iam = false) to skip the inline policy."
    }

    precondition {
      condition     = !local.pr_env_route53_iam_enabled || local.has_route53_zone
      error_message = "PR-env Route 53 IAM is enabled (enable_pr_environments = true, or enable_pr_env_route53_iam = true) but no Route 53 zone is discoverable for base_domain. Set route53_zone_id, or set lookup_route53_zone_in_this_account = true. Alternatively set enable_pr_environments = false (or enable_pr_env_route53_iam = false) to skip the inline policy."
    }
  }
}

# --- PR Envs: SSM Parameter Store read for `$${ssm:/path}` env-var refs -------
#
# Lets operators paste references like `$${ssm:/agent-hub/dev/aws-secret}` into
# a project's `prEnv.env` block in projects.json (or via the Settings UI) so
# secrets aren't stored in plaintext on disk. The server resolves the
# reference at PR-env build time using the EC2 instance role identity — no
# static AWS credentials needed in the container.
#
# Scope: GetParameter/GetParameters on parameters under
# `pr_env_ssm_path_prefix` (default `/agent-hub/`) so an operator can't
# inadvertently reference an unrelated parameter from another tenant. The
# kms:Decrypt grant on the default SSM CMK (`alias/aws/ssm`) is required for
# SecureString parameter types — without it the resolver gets
# AccessDeniedException at decrypt time even though the GetParameter call
# itself returns OK metadata.

resource "aws_iam_role_policy" "pr_env_ssm_secrets" {
  count = local.pr_env_ssm_secrets_enabled ? 1 : 0

  name = "${var.project_name}-pr-env-ssm-secrets"
  role = aws_iam_role.ec2_ssm[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadPrEnvSecretParameters"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
        ]
        Resource = "arn:aws:ssm:*:*:parameter${var.pr_env_ssm_path_prefix}*"
      },
      {
        # Required for SecureString parameter types under the default SSM
        # CMK. Customer-managed CMKs (alias/<custom>) must be added here
        # explicitly — operators using a non-default key should override this
        # policy or extend it via a sibling resource.
        Sid    = "DecryptDefaultSsmCmk"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      },
    ]
  })

  lifecycle {
    precondition {
      condition     = !local.pr_env_ssm_secrets_enabled || var.enable_instance_ssm
      error_message = "PR-env SSM secrets is enabled (enable_pr_environments = true, or enable_pr_env_ssm_secrets = true) but enable_instance_ssm = false. The inline policy attaches to the SSM EC2 instance role; set enable_instance_ssm = true, or set enable_pr_environments = false (or enable_pr_env_ssm_secrets = false) to skip the inline policy."
    }
  }
}

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
