# ──────────────────────────────────────────────────────────────────────────────
# S3 storage for session artifacts, uploads, and RUM session-replay segments.
#
# When enable_artifacts_bucket = true (and a bucket name is set) this creates the
# bucket, grants the Hub EC2 instance role object read/write/delete plus the
# lifecycle-config permissions the server needs to provision RUM retention rules
# at boot (server/replays/replay-lifecycle-s3.ts — best-effort), and the
# AGENT_HUB_ARTIFACTS_BUCKET env is injected via locals-agent-hub.tf so
# getArtifactStore() selects the S3 backend instead of the local data dir.
#
# Existing local replays/artifacts are NOT migrated: reads resolve each row's
# ORIGINAL backend from its recorded storage_kind. Existing local uploads stay
# readable through the static fallback; only new uploads land in S3.
# ──────────────────────────────────────────────────────────────────────────────

locals {
  # Did the operator ask for the S3 backend? (flag on + a non-empty bucket name)
  artifacts_bucket_requested = var.enable_artifacts_bucket && length(trimspace(var.artifacts_bucket_name)) > 0

  # Is it actually wired up? The object-CRUD IAM policy below attaches to the SSM
  # EC2 instance role, so the whole S3 backend requires enable_instance_ssm. Gate
  # the bucket, its IAM policy, AND the AGENT_HUB_ARTIFACTS_BUCKET env injection
  # (locals-agent-hub.tf — both the PM2 and Docker bootstrap env) on this single
  # condition so the three can never diverge into a half-configured state: an S3
  # backend selected at runtime with no IAM policy attached would 500 every
  # replay/artifact/upload PutObject on AccessDenied. A requested-but-not-wired
  # config (enable_artifacts_bucket = true, enable_instance_ssm = false) is surfaced
  # loudly by check "artifacts_bucket_requires_ssm" in checks.tf and otherwise
  # degrades safely to the local data dir.
  artifacts_bucket_enabled = local.artifacts_bucket_requested && var.enable_instance_ssm
}

resource "aws_s3_bucket" "artifacts" {
  count  = local.artifacts_bucket_enabled ? 1 : 0
  bucket = var.artifacts_bucket_name

  tags = {
    Name    = "${var.project_name}-artifacts"
    Project = var.project_name
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  count                   = local.artifacts_bucket_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  count  = local.artifacts_bucket_enabled ? 1 : 0
  bucket = aws_s3_bucket.artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Hub instance role: object CRUD on the bucket contents + the two lifecycle-config
# actions the boot-time RUM lifecycle provisioner calls. s3:PutLifecycleConfiguration
# also authorizes DeleteBucketLifecycle (S3 maps both to the same permission).
resource "aws_iam_role_policy" "hub_artifacts_s3" {
  # local.artifacts_bucket_enabled already requires var.enable_instance_ssm, so
  # aws_iam_role.ec2_ssm[0] is guaranteed to exist whenever count = 1.
  count = local.artifacts_bucket_enabled ? 1 : 0
  name  = "artifacts-s3"
  role  = aws_iam_role.ec2_ssm[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Objects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${var.artifacts_bucket_name}/*"]
      },
      {
        Sid      = "BucketLifecycle"
        Effect   = "Allow"
        Action   = ["s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration"]
        Resource = ["arn:aws:s3:::${var.artifacts_bucket_name}"]
      },
    ]
  })
}
