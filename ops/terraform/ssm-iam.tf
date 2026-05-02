# Systems Manager Session Manager: connect without SSH keys.
# See outputs ssm_start_session_one_liner, ssm_secrets_manager (optional) in outputs.tf

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
# via var.enable_pr_env_route53_iam.

resource "aws_iam_role_policy" "pr_env_route53" {
  # Gate on the feature flag only — the lifecycle.precondition blocks below
  # surface enable_instance_ssm / has_route53_zone misconfigurations at plan
  # time. A wider `count` expression (e.g. && var.enable_instance_ssm) would
  # silently evaluate to 0 and bypass the preconditions, leaving the operator
  # with a confusing runtime IAM error instead of a plan-time message — same
  # pattern as aws_acm_certificate.pr_env_wildcard in alb.tf.
  count = var.enable_pr_env_route53_iam ? 1 : 0

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
        Sid      = "PollChangeStatus"
        Effect   = "Allow"
        Action   = "route53:GetChange"
        Resource = "arn:aws:route53:::change/*"
      },
    ]
  })

  lifecycle {
    precondition {
      condition     = !var.enable_pr_env_route53_iam || var.enable_instance_ssm
      error_message = "enable_pr_env_route53_iam = true requires enable_instance_ssm = true (the inline policy attaches to the SSM EC2 instance role)."
    }

    precondition {
      condition     = !var.enable_pr_env_route53_iam || local.has_route53_zone
      error_message = "enable_pr_env_route53_iam = true requires a discoverable Route 53 zone for base_domain. Set route53_zone_id, or set lookup_route53_zone_in_this_account = true."
    }
  }
}
