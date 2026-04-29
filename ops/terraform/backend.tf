# ──────────────────────────────────────────────────────────────────────────────
# Remote state — S3 backend (MANDATORY)
#
# Concrete values (bucket, key, region, locking) are supplied per-environment
# via `-backend-config=environments/<env>/backend.hcl`. Do NOT hardcode them
# here; keeping the block empty lets one tree serve every environment.
#
# DO NOT pass `-state=...` to terraform plan/apply/destroy/import. That flag
# bypasses the backend and writes a local state file, which is how envs get
# orphaned (the file lives on one operator's laptop and nobody else can manage
# the stack). One historical example: the test123 env was created with a
# local state file that was then unrecoverable — its infra had to be deleted
# manually via the AWS API instead of `terraform destroy`. Always rely on the
# S3 backend resolved via `./scripts/tf-init.sh <env>`.
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
