# EXAMPLE: ALB in one AWS account, public DNS in another (e.g. example.com).
# 1) Issue or import an ACM cert in the *ALB/EC2* region+account; validate it using
#    DNS in the other account (CNAMEs in *their* Route 53) or use email validation.
# 2) Set acm_certificate_arn below. Do NOT set lookup / route53_zone_id here for the
#    public zone in the other account (or Terraform cannot create the A/validation records there).
# 3) In the account that owns the zone, create an A/AAAA alias: name = the relative part
#    of public_fqdn under the zone (e.g. agenthub.myenv) → alias to:
#    outputs.dedicated_alb_dns_name + dedicated_alb_zone_id from this apply.
#
# project_name  = "agenthub"
# public_fqdn   = "agenthub.myenv.example.com"
# base_domain   = "example.com" # must match your certificate SAN and logical parent; used in outputs
# enable_dedicated_alb = true
# lookup_route53_zone_in_this_account = false
# acm_certificate_arn    = "arn:aws:acm:us-east-2:ACCOUNT:..."
# # route53_zone_id    = null
# # ssh_cidr_blocks = [ "YOUR_IP/32" ]
