# S3 backend for the PRODUCTION Agent Hub (dedicated account, agenthub profile).
# Account: 350025135582 (us-east-2). Separate bucket from dev — fully isolated.
#
# init:  AWS_PROFILE=agenthub terraform init -reconfigure -backend-config=environments/prod/backend.hcl
# plan:  AWS_PROFILE=agenthub terraform plan  -var-file=environments/prod/prod.tfvars
# apply: AWS_PROFILE=agenthub terraform apply -var-file=environments/prod/prod.tfvars

bucket         = "agent-hub-tfstate-350025135582"
key            = "prod/terraform.tfstate"
region         = "us-east-2"
encrypt        = true
dynamodb_table = "agent-hub-tfstate-lock"
