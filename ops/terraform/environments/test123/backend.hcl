# S3 backend configuration for the `test123` environment.
# Values fed into `terraform init -backend-config=...` via scripts/tf-init.sh.
#
# Naming convention:
#   bucket: agent-hub-tfstate-<aws-account-id>
#   key   : <env>/terraform.tfstate
#
# Keep the bucket in the same region as the stack so latency is negligible and
# there's no cross-region egress on plan/apply.

bucket  = "agent-hub-tfstate-120569607241"
key     = "test123/terraform.tfstate"
region  = "us-east-2"
encrypt = true

# State locking — DynamoDB table, auto-created by scripts/tf-init.sh.
# Works on any Terraform >= 0.12. If/when all operators run TF >= 1.10,
# comment this line out and uncomment `use_lockfile = true` below to drop
# the DynamoDB dependency (native S3 locking is cheaper + simpler).
dynamodb_table = "agent-hub-tfstate-lock"

# use_lockfile = true   # Native S3 locking, Terraform >= 1.10 only (Nov 2024)
