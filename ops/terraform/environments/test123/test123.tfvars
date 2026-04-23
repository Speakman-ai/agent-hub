# test123: EC2 + dedicated ALB + ACM + A record.
#
# The `dev` Route 53 zone and other resources live in the `dev` AWS account/profile:
#   export AWS_PROFILE=dev
#
# Plan/apply (isolated state file so you do not clobber an existing local terraform.tfstate):
#   cd ops/terraform && mkdir -p state
#   AWS_PROFILE=dev terraform plan  -var-file=environments/test123/test123.tfvars  -state=state/test123.tfstate
#   AWS_PROFILE=dev terraform apply -var-file=environments/test123/test123.tfvars  -state=state/test123.tfstate
#
# If plan fails: "no matching Route 53 Hosted Zone", `base_domain` must match the
# *hosted zone name* in this AWS account (e.g. dev.surveytracker.io, not the root
# zone if the root lives elsewhere). Or set `route53_zone_id` / `acm_certificate_arn` as
# in the file header above. For EC2 only: environments/test123/test123.ec2-only.tfvars
#
# Access: SSM Session Manager (no EC2 key pair, no public SSH). Install the
# "Session Manager plugin" for the AWS CLI, then use the `ssm_start_session`
# output after apply. See:
#   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html

aws_region   = "us-east-2"
project_name = "test123"
name         = "test123"

# Public URL: https://agenthub.test123.dev.surveytracker.io
public_fqdn = "agenthub.test123.dev.surveytracker.io"
base_domain = "dev.surveytracker.io"
# Optional: pin TG name (from first apply) so hostname edits never replace the target group
target_group_name_override = "ahd851c8b5"
# dns_subdomain = "agenthub"  # ignored when public_fqdn is set; default matches this FQDN

enable_dedicated_alb                = true
lookup_route53_zone_in_this_account = true
# If the zone is not in this account, set lookup to false and set route53_zone_id
# to the public zone_id string, or set acm_certificate_arn to an ARN in this region
# and manage the A record elsewhere.

# SSM-only: no SSH from the internet, no key pair; use SSM to get a shell.
create_ssh_key      = false
enable_ssh_ingress  = false
enable_instance_ssm = true
ssh_cidr_blocks     = [] # only used if enable_ssh_ingress = true

# First boot: pull the agent-hub image from ECR Public and `docker run` on 3051.
# The image is pushed by .github/workflows/push-image.yml on every merge to main.
# To pin a specific release, change ":main" to ":<git-sha>" (e.g. ":ab12cd34ef56").
#
# The ECR-pull path skips git clone + docker build entirely — no GitHub token
# needed, no long boot time. AMI (ECS-optimized AL2023, via SSM parameter) has
# Docker preinstalled so first boot is ~45s vs ~3min.
bootstrap_agent_hub = true
agent_hub_image_uri = "public.ecr.aws/h9t4v7h0/agent-hub:main"

# Legacy clone+build path is kept as a fallback if agent_hub_image_uri is unset:
# agent_hub_git_url = "https://github.com/Speakman-ai/agent-hub.git"
# agent_hub_git_ref = "main"

web_cidr_blocks         = ["0.0.0.0/0"]
alb_ingress_cidr_blocks = ["0.0.0.0/0"]
