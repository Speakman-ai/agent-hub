# S3 backend configuration for the `test` environment (CI-sized Agent Hub box).
# Account: dev (120569607241). SAME bucket as `ryan` — DIFFERENT state key, so
# this stack can never plan changes against the ryan/agenthub.dev instance.
#
# init: AWS_PROFILE=dev ./scripts/tf-init.sh test

bucket  = "agent-hub-tfstate-120569607241"
key     = "test/terraform.tfstate"
region  = "us-east-2"
encrypt = true

dynamodb_table = "agent-hub-tfstate-lock"
