# ──────────────────────────────────────────────────────────────────────────────
# Remote state — S3 backend
#
# Concrete values (bucket, key, region, locking) are supplied per-environment
# via `-backend-config=environments/<env>/backend.hcl`. Do NOT hardcode them
# here; keeping the block empty lets one tree serve every environment.
#
# Usage (wrapped by scripts/tf-init.sh, which also creates the bucket on first
# run if it doesn't exist yet):
#
#   cd ops/terraform
#   ./scripts/tf-init.sh test123        # create bucket (if new) + init + migrate
#   AWS_PROFILE=dev terraform plan -var-file=environments/test123/test123.tfvars
#
# State locking:
#   * Terraform >= 1.10 — native S3 locking via `use_lockfile = true` in the
#     backend.hcl. No DynamoDB table needed.
#   * Terraform <  1.10 — set `dynamodb_table = "agent-hub-tfstate-lock"` in
#     the backend.hcl; the bootstrap script will create it.
# ──────────────────────────────────────────────────────────────────────────────
terraform {
  backend "s3" {}
}
