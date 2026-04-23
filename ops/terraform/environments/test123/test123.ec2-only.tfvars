# test123 – VPC + EC2 + SSH key only (no ALB, no Route 53, no ACM).
# Use this when you want a quick smoke test or the surveytracker.io zone
# is not in this AWS account.
#
#   terraform apply -var-file=environments/test123/test123.ec2-only.tfvars -state=state/test123-ec2only.tfstate

aws_region   = "us-east-2"
project_name = "test123"
name         = "test123"

enable_dedicated_alb                = false
lookup_route53_zone_in_this_account = false

ssh_cidr_blocks         = ["0.0.0.0/0"]
web_cidr_blocks         = ["0.0.0.0/0"]
alb_ingress_cidr_blocks = ["0.0.0.0/0"]
