# S3 backend configuration for the `ryan` environment (personal dev sandbox).
# Account: dev (120569607241). Same bucket as test123 — different state key.
#
# init: AWS_PROFILE=dev-mcsteen ./scripts/tf-init.sh ryan

bucket  = "agent-hub-tfstate-120569607241"
key     = "ryan/terraform.tfstate"
region  = "us-east-2"
encrypt = true

dynamodb_table = "agent-hub-tfstate-lock"
