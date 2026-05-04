variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "ryan-remote-server"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "ami_id" {
  description = "Override AMI. Leave null to use the ECS-optimized Amazon Linux 2023 AMI resolved from SSM (`use_ecs_optimized_ami = true`, default), which has Docker + SSM agent + ECR credential helper preinstalled. Set a raw AMI ID (e.g. Ubuntu) only when you need the legacy PM2-on-host path that installs Node + Docker in user-data."
  type        = string
  default     = null
  nullable    = true
}

variable "use_ecs_optimized_ami" {
  description = "When true and `ami_id` is null, resolve the latest ECS-optimized Amazon Linux 2023 AMI from SSM parameter `/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended`. This is the right default for the ECR-pull bootstrap path; Docker is already installed and systemd-enabled. Set false if you pin an `ami_id`."
  type        = bool
  default     = true
}

variable "ssh_cidr_blocks" {
  description = "CIDR blocks for port 22; used only if enable_ssh_ingress is true (e.g. [\"<your-ip>/32\"]. Use [] and enable_ssh_ingress = false to rely on SSM only.)"
  type        = list(string)
  default     = []
}

variable "enable_ssh_ingress" {
  description = "If false, no security group rule for port 22 (use AWS Systems Manager Session Manager instead; set enable_instance_ssm = true)"
  type        = bool
  default     = true
}

variable "create_ssh_key" {
  description = "If true, create a new EC2 key pair and write a .pem in this module directory. Set false to use SSM only and no SSH key on the instance."
  type        = bool
  default     = true
}

variable "enable_instance_ssm" {
  description = "Attach an IAM instance profile with AmazonSSMManagedInstanceCore so the instance can register for SSM Session Manager."
  type        = bool
  default     = true
}

variable "web_cidr_blocks" {
  description = "CIDR blocks allowed to reach HTTP/HTTPS (ports 80, 443)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "egress_cidr_blocks" {
  description = "CIDR blocks allowed for outbound traffic from the instance"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr_block" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr_block" {
  description = "CIDR block for the public subnet"
  type        = string
  default     = "10.0.150.0/24"
}

variable "availability_zone_suffix" {
  description = "Availability zone suffix (appended to aws_region, e.g. \"a\" for us-east-2a)"
  type        = string
  default     = "a"
}

variable "internet_route_cidr_block" {
  description = "Destination CIDR for the public route table default route"
  type        = string
  default     = "0.0.0.0/0"
}

variable "root_volume_size" {
  description = "Size (GB) of the root EBS volume"
  type        = number
  default     = 30
}

variable "root_volume_type" {
  description = "Type of the root EBS volume (e.g. gp3, gp2, io1)"
  type        = string
  default     = "gp3"
}

variable "node_major_version" {
  description = "Major Node.js version installed by user_data (via NodeSource)"
  type        = string
  default     = "22"
}

variable "app_user" {
  description = "Linux user created on the instance to own the app directory"
  type        = string
  default     = "agenthub"
}

# --- Agent Hub (Docker) — written to <docker_app_path>/.env at first boot
# (x-api-key: see variables-bootstrap.tf; random_id in bootstrap-api-key.tf)

variable "docker_bootstrap" {
  description = "If true, install Docker and create .env for docker compose. If false, use minimal user_data (Node, PM2, Nginx, cursor only). Ignored when bootstrap_agent_hub is true (that path uses agent_hub_bootstrap_docker and agent-hub-user-data.tftpl instead)."
  type        = bool
  default     = true
}

variable "docker_app_path" {
  description = "Host path for the app checkout (e.g. rsync target). .env is created here before the repo is copied."
  type        = string
  default     = "/home/agenthub/agent-hub"
}

variable "allowed_origins" {
  description = "Comma-separated browser origins for CORS (no trailing slash). Set empty or \"AUTO\" to use http://<IMDS public IPv4> at boot."
  type        = string
  default     = "AUTO"
}

variable "agent_hub_public_url" {
  description = "Public base URL (OAuth/GitHub, etc.). Empty = same as IMDS http://<public-ip> when combined with default behavior."
  type        = string
  default     = ""
}

variable "agent_hub_web_port" {
  description = "Host port published for the client container (AGENT_HUB_WEB_PORT in .env, maps docker-compose 80:80 by default)."
  type        = number
  default     = 80
}

variable "user_data_replace_on_change" {
  description = "Set true (the default) to replace the instance when user_data (bootstrap) changes. Without this, TF updates the user_data attribute in-place but cloud-init doesn't re-run on the existing instance — meaning the OS keeps running whatever was first-booted. Turn off only if you have an explicit out-of-band mechanism for re-running bootstrap (e.g. SSM)."
  type        = bool
  default     = true
}

variable "ssh_user" {
  description = "Default SSH username for the AMI. Ubuntu AMIs use \"ubuntu\"; ECS-optimized Amazon Linux 2023 uses \"ec2-user\". Unused when create_ssh_key = false and enable_ssh_ingress = false."
  type        = string
  default     = "ec2-user"
}

# --- ECR Public (agent-hub image registry) -----------------------------------
#
# The ECR Public repo itself is NOT managed by Terraform — it's one-time shared
# infra (see ecr-public.tf for the create-repository runbook). Per-env stacks
# only need the URI (alias + name) to construct the pull URL.

variable "ecr_public_repo_name" {
  description = "ECR Public repository name (URI suffix after the alias). Used by CI push + user-data pull."
  type        = string
  default     = "agent-hub"
}

variable "ecr_public_registry_alias" {
  description = "ECR Public registry alias — the URL path between public.ecr.aws/ and the repo name. AWS auto-assigned \"h9t4v7h0\" on first repo creation in this account; a vanity alias like \"agenthub\" can be requested via the console (same-day AWS approval) and both URIs keep working."
  type        = string
  default     = "h9t4v7h0"
}

# --- GitHub Actions OIDC (CI image push) -------------------------------------

variable "manage_github_oidc_role" {
  description = "If true, create the IAM role assumed by GitHub Actions to push images to ECR Public. The OIDC provider itself is assumed to exist (AWS dev account has one already). Set false if you manage the role in another module."
  type        = bool
  default     = true
}

variable "github_oidc_role_name" {
  description = "Name of the IAM role GitHub Actions assumes (for `aws-actions/configure-aws-credentials`). Must match the `role-to-assume` in .github/workflows/push-image.yml."
  type        = string
  default     = "agent-hub-ci-ecr-push"
}

variable "github_repo_owner" {
  description = "GitHub org/user owning the repo (used in OIDC sub claim)."
  type        = string
  default     = "Speakman-ai"
}

variable "github_repo_name" {
  description = "GitHub repo name (used in OIDC sub claim)."
  type        = string
  default     = "agent-hub"
}

# --- Dedicated ALB (ops/terraform/alb.tf) — TLS at ALB, HTTP to Agent Hub on the instance ---

variable "enable_dedicated_alb" {
  description = "If true, create a public application load balancer, target group, optional ACM cert + Route 53 record, and restrict app port ingress to the ALB. Requires a second public subnet in another AZ."
  type        = bool
  default     = false
}

variable "name" {
  description = "When public_fqdn is unset, used to build the hostname: <dns_subdomain>.<name>.<base_domain>. If public_fqdn is set, this is ignored for DNS (but can stay empty for naming elsewhere)."
  type        = string
  default     = ""
}

variable "public_fqdn" {
  description = "Full public hostname (e.g. agenthub.ryan.aimetrics.com). When set, overrides the composed <dns_subdomain>.<name>.<base_domain>. The name must be under the Route 53 zone for base_domain when you want Terraform to create ACM + A records in *this* account. If the zone or DNS lives in another account, set acm_certificate_arn and point the name at the ALB in that account; you still set public_fqdn + base_domain for outputs and (with base_domain) for any in-Terraform R53."
  type        = string
  default     = null
  nullable    = true
}

variable "base_domain" {
  description = "Parent DNS name for the public hostname. Must match the Route 53 *hosted zone* you use in this account—often the zone apex (e.g. surveytracker.io) or a delegated sub-zone (e.g. dev.surveytracker.io) if the root zone is elsewhere."
  type        = string
  default     = "surveytracker.io"
}

variable "dns_subdomain" {
  description = "First label of the Agent Hub hostname, before the personal/name label (default yields agenthub.<name>.<base_domain>)."
  type        = string
  default     = "agenthub"
}

variable "route53_zone_id" {
  description = "Route 53 zone ID (same AWS account) for base_domain, used to validate ACM and optionally create an A alias to the ALB. If null, you must set acm_certificate_arn and point DNS to the load balancer yourself, or set lookup_route53_zone_in_this_account = true to resolve base_domain in this account."
  type        = string
  default     = null
}

variable "lookup_route53_zone_in_this_account" {
  description = "If true, resolve the *public* hosted zone for `base_domain` via a data source in this AWS account. Use when you do not have the zone_id string handy; the zone must exist in this account (fails the plan if missing or delegated-only elsewhere). Ignored if route53_zone_id is set non-empty."
  type        = bool
  default     = false
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN in this region (e.g. imported or shared). If set, no new ACM cert is created; route53_zone_id is still used if you want Terraform to create the A alias. The cert must include the public hostname (public_fqdn or composed FQDN)."
  type        = string
  default     = null
}

variable "agent_hub_target_port" {
  description = "Port the Node/PM2 server listens on the EC2 instance (ALB targets this over HTTP in the VPC)."
  type        = number
  default     = 3051
}

variable "alb_idle_timeout" {
  description = "ALB idle timeout in seconds (raise for long-lived WebSocket streams; max 4000)."
  type        = number
  default     = 300
}

variable "second_public_subnet_cidr_block" {
  description = "CIDR for the second public subnet (other AZ) used only when enable_dedicated_alb = true. Must be within vpc_cidr_block and not overlap public_subnet_cidr_block."
  type        = string
  default     = "10.0.151.0/24"
}

variable "alb_availability_zone_suffix_b" {
  description = "AZ letter for the second subnet (e.g. \"b\" for us-east-2b) — must differ from availability_zone_suffix (first subnet)."
  type        = string
  default     = "b"
}

variable "alb_ingress_cidr_blocks" {
  description = "CIDRs allowed to reach the ALB on 80/443. Use a narrow CIDR to restrict the management UI (e.g. your IP/32) or 0.0.0.0/0 for public access."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "target_group_name_override" {
  description = "If set, use this as the target group `name` (max 32 chars) instead of the project+hostname hash. Set to your existing TG name (see `terraform state show aws_lb_target_group.agenthub[0]`) when only changing public_fqdn or base_domain so the TG is not replaced."
  type        = string
  default     = null
  nullable    = true
}

# --- PR Envs (host nginx wildcard + Route 53 IAM for DNS-01 ACME) ------------
#
# `enable_pr_environments` (defaults TRUE) is the single root flag that turns
# the entire PR-env stack on for new operators. It drives, in concert:
#   - wildcard ACM cert for *.<pr_env_preview_subdomain>.<alb_fqdn>     (alb.tf)
#   - Route 53 inline policy on the EC2 SSM instance role               (ssm-iam.tf)
#   - host nginx + certbot + sudoers + docker-socket bind-mount         (main.tf, user-data)
#   - SG ingress range 3100-3999                                        (main.tf)
#   - Tier-3 prEnv block in <dataDir>/config.json                       (locals-agent-hub.tf)
#
# The fine-grained flags `enable_pr_env_wildcard_cert`,
# `enable_pr_env_route53_iam`, and `enable_pr_env_host_nginx` remain as
# **per-piece overrides** for back-compat and for operators who want to
# disable a single piece for testing without flipping the whole stack. They
# are nullable bools defaulting to `null`, which means "follow the parent
# flag." A non-null value (true OR false) overrides the parent.
#
# Effective values are resolved in `locals-agent-hub.tf` as
# `local.pr_env_wildcard_cert_enabled`, `local.pr_env_route53_iam_enabled`,
# and `local.pr_env_host_nginx_enabled`. **All resources/checks/templates
# reference the locals**, never `var.enable_pr_env_*` directly.

variable "enable_pr_environments" {
  description = <<-DESC
    Single root flag for the full per-PR preview environment stack. When true
    (the default), Terraform provisions the wildcard ACM cert, the Route 53
    write IAM policy on the instance role, the host nginx + certbot bootstrap,
    the 3100-3999 security-group range, and the Tier-3 prEnv config block —
    everything required to make per-PR previews work end-to-end after
    ticking the "PR Environments" checkbox in Settings.

    Flip to false (e.g. `enable_pr_environments = false` in tfvars) to
    provision a plain Agent Hub host with no PR-env scaffolding. The
    fine-grained `enable_pr_env_wildcard_cert`, `enable_pr_env_route53_iam`,
    and `enable_pr_env_host_nginx` variables remain available as per-piece
    overrides for testing — set them to `true` or `false` to override this
    parent flag for that one piece.

    Note: enabling host nginx triggers EC2 instance replacement (user-data
    change). New deployments default-on is fine; existing deployments that
    were never on PR-envs and don't want to be will set this to false.
  DESC
  type        = bool
  default     = true
}

variable "enable_pr_env_wildcard_cert" {
  description = <<-DESC
    Per-piece override for the PR-env wildcard ACM certificate (DNS-validated
    via Route 53). Defaults to null, meaning "follow `enable_pr_environments`."
    Set to true or false to override the parent flag for the wildcard cert
    only — useful when testing each piece of the PR-env stack in isolation.
    The cert is intended for host nginx to terminate TLS on per-PR preview
    hostnames and is NOT attached to the ALB listener. Requires a discoverable
    Route 53 zone (route53_zone_id or lookup_route53_zone_in_this_account)
    when effectively enabled.
  DESC
  type        = bool
  default     = null
  nullable    = true
}

variable "enable_pr_env_route53_iam" {
  description = <<-DESC
    Per-piece override for the Route 53 inline policy attached to the EC2 SSM
    instance role. Defaults to null, meaning "follow `enable_pr_environments`."
    Set to true or false to override for this piece only. When effectively
    enabled, grants route53:ChangeResourceRecordSets/ListResourceRecordSets on
    the hosted zone for base_domain plus route53:GetChange and
    route53:ListHostedZones, so the instance can create per-PR DNS records
    (and DNS-01 ACME challenges) under the discovered zone. Requires
    enable_instance_ssm = true and a discoverable Route 53 zone.
  DESC
  type        = bool
  default     = null
  nullable    = true
}

variable "pr_env_preview_subdomain" {
  description = "Single DNS label used to namespace per-PR preview hostnames under the canonical Agent Hub hostname: <pr-id>.<pr_env_preview_subdomain>.<alb_fqdn>. The wildcard ACM cert (when enable_pr_env_wildcard_cert = true) covers *.<pr_env_preview_subdomain>.<alb_fqdn>. Must be a single label (no dots) so downstream PRs can compose per-PR hostnames as <pr-id>.<this>.<alb_fqdn> without ambiguity. Lowercase letters, digits, hyphens; not starting/ending with hyphen; ≤63 chars."
  type        = string
  default     = "preview"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.pr_env_preview_subdomain))
    error_message = "pr_env_preview_subdomain must be a single DNS label: lowercase letters, digits, and hyphens; cannot start or end with a hyphen; cannot contain dots; must be 1–63 characters."
  }
}

variable "cert_renewal_email" {
  description = <<-DESC
    Contact email registered with Let's Encrypt for the wildcard cert issued by
    `certbot certonly --dns-route53` on first boot when `enable_pr_env_host_nginx
    = true`. Lets Encrypt sends expiration warnings to this address. Required
    when `enable_pr_env_host_nginx = true`; ignored otherwise. The hard error is
    enforced as a precondition on `aws_instance.app` (main.tf), so missing email
    fails `terraform plan` with a helpful message rather than failing at boot.
  DESC
  type        = string
  default     = null
  nullable    = true

  validation {
    # Loose email shape check — single `@`, dot-containing domain, no whitespace.
    # Belt-and-suspenders so a stray newline or empty string isn't accepted.
    # The cross-variable "required when pr_env_enabled" check lives on the
    # aws_instance.app precondition (main.tf) since variable validation cannot
    # reference other variables until Terraform 1.9, and we still pin >= 1.5.
    condition     = var.cert_renewal_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.cert_renewal_email))
    error_message = "cert_renewal_email must look like an email address (e.g. ops@example.com) or be null when enable_pr_env_host_nginx = false."
  }
}

variable "enable_pr_env_host_nginx" {
  description = <<-DESC
    Per-piece override for the host nginx + certbot + sudoers + docker-socket
    bootstrap used by per-PR preview environments. Defaults to null, meaning
    "follow `enable_pr_environments`." Set to true or false to override for
    this piece only.

    When effectively enabled, instance user-data:
      - installs host nginx + certbot + python3-certbot-dns-route53
      - drops a base vhost at /etc/nginx/conf.d/agent-hub-pr-base.conf that includes
        /etc/nginx/conf.d/agent-hub-pr-*.conf so the Hub can fan out per-PR fragments
      - writes a narrow sudoers.d allowlist for the app user
        (/usr/sbin/nginx -t, /bin/systemctl reload nginx, /usr/bin/certbot)
      - runs the Hub container with the host docker socket bind-mounted
        (-v /var/run/docker.sock:/var/run/docker.sock, --group-add matching the host's
        docker GID, --add-host host.docker.internal:host-gateway)
      - opens an SG ingress range 3100-3999 from 127.0.0.1/32 (loopback-only marker;
        these ports are reverse-proxied via host nginx and never ALB-exposed)

    WARNING: enabling this gives the Hub container root-equivalent access to the host
    via the docker socket. Acceptable for trusted single-tenant Hub deployments only.
    Triggers an instance replacement on apply (user-data change) — schedule a
    maintenance window.
  DESC
  type        = bool
  default     = null
  nullable    = true
}
