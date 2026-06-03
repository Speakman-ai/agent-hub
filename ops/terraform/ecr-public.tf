# ECR Public repositories for Agent Hub images.
#
# These files do NOT manage the ECR Public repos. Repos are one-time, shared
# infrastructure — the registry auto-assigns an alias on first creation
# (e.g. `h9t4v7h0`) and that alias becomes part of the public pull URL forever.
# Putting them in a per-env Terraform stack risks `terraform destroy` deleting
# registry images other envs depend on.
#
# One-time setup (already done for dev — alias h9t4v7h0):
#
#   AWS_PROFILE=<account> aws ecr-public create-repository \
#     --region us-east-1 \
#     --repository-name agent-hub \
#     --catalog-data 'description=Agent Hub — self-hosted AI agent orchestration platform'
#
#   AWS_PROFILE=<account> aws ecr-public create-repository \
#     --region us-east-1 \
#     --repository-name agent-hub-finalize-runner \
#     --catalog-data 'description=Agent Hub Finalize CI DinD runner (ubuntu-24.04)'
#
# After creation, note the registry alias from the output and either:
#   - leave var.ecr_public_registry_alias = "h9t4v7h0" (current dev account), or
#   - override per-env in tfvars if a different account assigns a different alias.
#
# CI pushes images via the GitHub OIDC role defined in github-oidc.tf, which
# references both repo names and the caller account.

output "ecr_public_repository_uri" {
  description = "Pull URI for the Agent Hub container image, e.g. public.ecr.aws/h9t4v7h0/agent-hub"
  value       = "public.ecr.aws/${var.ecr_public_registry_alias}/${var.ecr_public_repo_name}"
}

output "ecr_public_finalize_runner_repository_uri" {
  description = "Pull URI for the Finalize DinD runner image, e.g. public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner"
  value       = "public.ecr.aws/${var.ecr_public_registry_alias}/${var.ecr_public_finalize_runner_repo_name}"
}

output "ecr_public_image_uri_main" {
  description = "Default image URI consumed by the EC2 bootstrap (tag = main)."
  value       = "public.ecr.aws/${var.ecr_public_registry_alias}/${var.ecr_public_repo_name}:main"
}

output "ecr_public_finalize_runner_image_uri_main" {
  description = "Default Finalize runner image URI (tag = main, pushed in lockstep with agent-hub)."
  value       = "public.ecr.aws/${var.ecr_public_registry_alias}/${var.ecr_public_finalize_runner_repo_name}:main"
}
