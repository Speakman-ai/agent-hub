# ECR Public repository for the Agent Hub image.
#
# The repo was created out-of-band with `aws ecr-public create-repository` so the
# registry auto-assigned alias `h9t4v7h0` was locked in before Terraform.
# Import the existing repo the first time you apply this file:
#
#   AWS_PROFILE=dev terraform import -state=state/test123.tfstate \
#     aws_ecrpublic_repository.agent_hub agent-hub
#
# ECR Public lives in us-east-1 only (the API is regional even though pulls are
# anonymous from anywhere). We use a second provider alias rather than changing
# the default region of the module.
provider "aws" {
  alias  = "ecr_public"
  region = "us-east-1"
}

resource "aws_ecrpublic_repository" "agent_hub" {
  count = var.manage_ecr_public_repo ? 1 : 0

  provider        = aws.ecr_public
  repository_name = var.ecr_public_repo_name

  catalog_data {
    description       = "Agent Hub — self-hosted AI agent orchestration platform"
    about_text        = "Open-source platform for managing Claude Code and Cursor Agent sessions. See https://github.com/Speakman-ai/agent-hub."
    architectures     = ["x86-64"]
    operating_systems = ["Linux"]
  }

  tags = {
    Name    = var.ecr_public_repo_name
    Project = var.project_name
  }
}

output "ecr_public_repository_uri" {
  description = "Pull URI for the Agent Hub container image, e.g. public.ecr.aws/h9t4v7h0/agent-hub"
  value = (
    var.manage_ecr_public_repo
    ? aws_ecrpublic_repository.agent_hub[0].repository_uri
    : "public.ecr.aws/${var.ecr_public_registry_alias}/${var.ecr_public_repo_name}"
  )
}

output "ecr_public_image_uri_main" {
  description = "Default image URI consumed by the EC2 bootstrap (tag = main)."
  value = (
    var.manage_ecr_public_repo
    ? "${aws_ecrpublic_repository.agent_hub[0].repository_uri}:main"
    : "public.ecr.aws/${var.ecr_public_registry_alias}/${var.ecr_public_repo_name}:main"
  )
}
