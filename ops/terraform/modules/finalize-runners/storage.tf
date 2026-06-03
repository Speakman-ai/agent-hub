# Shared warm-cache + worktree storage. Created only where
# manage_shared_finalize_infra = true (one env), like ecr-public.tf's pattern;
# other envs reference these by name via the task-role policy. DRAFT.

# ── S3: worktree bundles (short-lived) ───────────────────────────────────────
resource "aws_s3_bucket" "worktree" {
  count         = var.manage_shared_finalize_infra ? 1 : 0
  bucket        = var.worktree_bucket_name
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "worktree" {
  count                   = var.manage_shared_finalize_infra ? 1 : 0
  bucket                  = aws_s3_bucket.worktree[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "worktree" {
  count  = var.manage_shared_finalize_infra ? 1 : 0
  bucket = aws_s3_bucket.worktree[0].id
  rule {
    id     = "expire-worktrees"
    status = "Enabled"
    filter {}
    expiration { days = 2 }
  }
}

# ── S3: build/seed/dep cache (per-tenant prefixes; lifecycle by prefix) ──────
resource "aws_s3_bucket" "cache" {
  count         = var.manage_shared_finalize_infra ? 1 : 0
  bucket        = var.cache_bucket_name
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "cache" {
  count                   = var.manage_shared_finalize_infra ? 1 : 0
  bucket                  = aws_s3_bucket.cache[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "cache" {
  count  = var.manage_shared_finalize_infra ? 1 : 0
  bucket = aws_s3_bucket.cache[0].id
  rule {
    id     = "expire-seed-build"
    status = "Enabled"
    filter { prefix = "" }
    expiration { days = 7 } # node_modules (longer TTL) can get its own prefix rule later
  }
}

# ── ECR: per-run app images the `prepare` job pushes, shards pull ────────────
resource "aws_ecr_repository" "app" {
  count                = var.manage_shared_finalize_infra ? 1 : 0
  name                 = "${var.project_name}-finalize-app"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = false
  }
  force_delete = true
  tags         = var.tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  count      = var.manage_shared_finalize_infra ? 1 : 0
  repository = aws_ecr_repository.app[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "expire per-run app images"
      selection    = { tagStatus = "any", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
      action       = { type = "expire" }
    }]
  })
}

# NOTE: base-image ECR pull-through cache (docker.io) needs an upstream
# credential in Secrets Manager — added with the autoscaler/scaler increment.
