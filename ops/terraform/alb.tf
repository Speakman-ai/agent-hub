# Dedicated public ALB → Agent Hub on EC2 (TLS at the load balancer, HTTP to the app port).
# Requires a second public subnet in another AZ (see main.tf). Enable with
# `enable_dedicated_alb = true` plus `name` and either `acm_certificate_arn` or
# `route53_zone_id` (or optional public_fqdn) (to issue/validate an ACM cert via DNS).

data "aws_route53_zone" "base" {
  count = var.enable_dedicated_alb && !var.create_route53_zone && var.lookup_route53_zone_in_this_account && (var.route53_zone_id == null || var.route53_zone_id == "") ? 1 : 0

  name         = "${var.base_domain}."
  private_zone = false
}

# Dedicated-account / prod model: create + own the public hosted zone for
# base_domain in THIS account (e.g. agenthub.example.com in the agent-hub
# account). The NS delegation into the root apex zone is written below.
resource "aws_route53_zone" "owned" {
  count = var.enable_dedicated_alb && var.create_route53_zone ? 1 : 0
  name  = var.base_domain
}

# Delegate base_domain from the ROOT apex zone (example.com) to the zone we
# just created — mirrors a root-account route53 module: an NS
# record in the root zone, written cross-account via the assumed root role.
resource "aws_route53_record" "owned_zone_delegation" {
  count           = var.enable_dedicated_alb && var.create_route53_zone && trimspace(var.root_delegation_role_arn) != "" && trimspace(var.root_delegation_zone_id) != "" ? 1 : 0
  provider        = aws.root_dns
  zone_id         = var.root_delegation_zone_id
  name            = var.base_domain
  type            = "NS"
  ttl             = 30
  records         = aws_route53_zone.owned[0].name_servers
  allow_overwrite = true
}

locals {
  # Avoid coalesce(…, try(data[0]…)) when the data block has count=0 — not all nulls/empty.
  route53_zone_id_effective = (
    length(aws_route53_zone.owned) > 0 ? aws_route53_zone.owned[0].zone_id : (
      var.route53_zone_id != null && var.route53_zone_id != "" ? var.route53_zone_id : (
        length(data.aws_route53_zone.base) > 0 ? data.aws_route53_zone.base[0].zone_id : null
      )
    )
  )
  # Determined from INTENT (known at plan time), not route53_zone_id_effective —
  # which, when create_route53_zone is set, is the created zone's computed zone_id
  # (unknown until apply) and would make count-gated cert/record resources fail
  # with "Invalid count argument".
  has_route53_zone = var.create_route53_zone || (var.route53_zone_id != null && var.route53_zone_id != "") || length(data.aws_route53_zone.base) > 0
  has_public_fqdn  = var.public_fqdn != null && trimspace(var.public_fqdn) != ""
  # When public_fqdn is not set: dns_subdomain.name.base_domain (requires var.name)
  composed_fqdn = var.name != "" ? "${var.dns_subdomain}.${var.name}.${var.base_domain}" : null
  # Normalize manual hostname: no surrounding dots or whitespace. Do not paste a URL here (hostname only).
  alb_fqdn = !var.enable_dedicated_alb ? null : (
    local.has_public_fqdn
    ? trimsuffix(trimprefix(trimspace(var.public_fqdn), "."), ".")
    : local.composed_fqdn
  )
  # Create ACM only when we can validate via Route 53 and the caller did not supply a cert ARN.
  acm_create = var.enable_dedicated_alb && (var.acm_certificate_arn == null || var.acm_certificate_arn == "") && local.has_route53_zone && local.alb_fqdn != null
  # Public DNS A alias when a zone in this plan can host the name under base_domain.
  r53_alias = var.enable_dedicated_alb && local.has_route53_zone && local.alb_fqdn != null
  alb_cert_arn = var.enable_dedicated_alb ? coalesce(
    (var.acm_certificate_arn != null && var.acm_certificate_arn != "" ? var.acm_certificate_arn : null),
    (length(aws_acm_certificate_validation.agenthub) > 0 ? aws_acm_certificate_validation.agenthub[0].certificate_arn : null)
  ) : null
  # Relative record name in the zone whose apex is base_domain (or "" for the zone apex when hostname == base_domain).
  r53_name_in_zone = local.alb_fqdn == null ? null : (
    local.alb_fqdn == var.base_domain ? "" : trimsuffix(local.alb_fqdn, ".${var.base_domain}")
  )
  # Stable, unique; max 32 characters for the target group name.
  target_group_name = "ah${substr(sha256("${var.project_name}-${coalesce(local.alb_fqdn, local.composed_fqdn, "x")}"), 0, 8)}"
}

# --- ACM (optional) ---

resource "aws_acm_certificate" "agenthub" {
  count = local.acm_create ? 1 : 0

  domain_name       = local.alb_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.project_name}-agenthub"
  }
}

resource "aws_route53_record" "agenthub_cert_validation" {
  for_each = local.acm_create ? { for dvo in aws_acm_certificate.agenthub[0].domain_validation_options : dvo.domain_name => dvo } : {}

  zone_id = local.route53_zone_id_effective
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 60
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "agenthub" {
  count = local.acm_create ? 1 : 0

  certificate_arn         = aws_acm_certificate.agenthub[0].arn
  validation_record_fqdns = [for r in aws_route53_record.agenthub_cert_validation : r.fqdn]
}

# --- ALB security group (ingress from the internet) ---

resource "aws_security_group" "agenthub_alb" {
  count = var.enable_dedicated_alb ? 1 : 0

  name        = "${var.project_name}-alb-sg"
  description = "ALB in front of Agent Hub (${var.project_name})"
  vpc_id      = aws_vpc.main.id

  dynamic "ingress" {
    for_each = var.alb_ingress_cidr_blocks
    content {
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = var.alb_ingress_cidr_blocks
    content {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = var.egress_cidr_blocks
  }

  tags = {
    Name = "${var.project_name}-alb-sg"
  }
}

# App port on EC2: only the ALB may connect — defined inline on
# aws_security_group.instance (see main.tf). Do not add aws_vpc_security_group_ingress_rule
# for the same port; inline blocks revoke standalone rules on apply.

# --- Application load balancer ---

resource "aws_lb" "agenthub" {
  count = var.enable_dedicated_alb ? 1 : 0

  name               = "${substr(var.project_name, 0, 20)}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.agenthub_alb[0].id]
  subnets = [
    aws_subnet.public.id,
    aws_subnet.public_b[0].id
  ]
  ip_address_type = "ipv4"
  idle_timeout    = var.alb_idle_timeout

  # Access logs are on in prod (adopted from live). Empty bucket → no block →
  # logging disabled, so non-prod envs are unaffected.
  dynamic "access_logs" {
    for_each = trimspace(var.alb_access_logs_bucket) != "" ? [1] : []
    content {
      bucket  = var.alb_access_logs_bucket
      enabled = true
    }
  }

  lifecycle {
    precondition {
      condition     = !var.enable_dedicated_alb || local.has_public_fqdn || (var.name != null && var.name != "")
      error_message = "When enable_dedicated_alb is true, set public_fqdn to the full hostname (e.g. agenthub.myenv.example.com), or set name (and usually dns_subdomain) to build <dns_subdomain>.<name>.<base_domain>."
    }
  }

  tags = {
    Name = "${var.project_name}-agenthub-alb"
  }
}

resource "aws_lb_target_group" "agenthub" {
  count = var.enable_dedicated_alb ? 1 : 0

  name        = coalesce(var.target_group_name_override, local.target_group_name)
  port        = var.agent_hub_target_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/api/health"
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = var.alb_health_check_unhealthy_threshold
    timeout             = var.alb_health_check_timeout
    interval            = 30
    matcher             = "200"
  }

  tags = {
    Name = "${var.project_name}-ah-tg"
  }

  # The TG name is a hash of project_name + alb_fqdn (see local.target_group_name).
  # Renaming public_fqdn changes the hash → terraform plans a replacement. Without
  # create_before_destroy, terraform tries to destroy the TG while the HTTPS
  # listener's default_action still references it (ResourceInUse 400). Forcing
  # create-first lets the listener flip to the new TG ARN before the old one is
  # released.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group_attachment" "agenthub" {
  count = var.enable_dedicated_alb ? 1 : 0

  target_group_arn = aws_lb_target_group.agenthub[0].arn
  target_id        = aws_instance.app.id
  port             = var.agent_hub_target_port
}

resource "aws_lb_listener" "agenthub_http" {
  count = var.enable_dedicated_alb ? 1 : 0

  load_balancer_arn = aws_lb.agenthub[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "agenthub_https" {
  count = var.enable_dedicated_alb ? 1 : 0

  load_balancer_arn = aws_lb.agenthub[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = local.alb_cert_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.agenthub[0].arn
  }

  lifecycle {
    precondition {
      condition     = !var.enable_dedicated_alb || local.has_route53_zone || (var.acm_certificate_arn != null && var.acm_certificate_arn != "")
      error_message = "With enable_dedicated_alb = true, set route53_zone_id, set lookup_route53_zone_in_this_account = true (zone for base_domain in this account), OR set acm_certificate_arn. One of these is required for a TLS listener."
    }
  }
}

# --- Public DNS: <dns_subdomain>.<name>.<base_domain> → ALB ---

resource "aws_route53_record" "agenthub" {
  count = local.r53_alias ? 1 : 0

  zone_id = local.route53_zone_id_effective
  name    = local.r53_name_in_zone
  type    = "A"

  alias {
    name                   = aws_lb.agenthub[0].dns_name
    zone_id                = aws_lb.agenthub[0].zone_id
    evaluate_target_health = true
  }

  depends_on = [aws_lb_listener.agenthub_https]

  lifecycle {
    precondition {
      condition = (
        local.r53_name_in_zone == null ||
        local.alb_fqdn == var.base_domain ||
        endswith(local.alb_fqdn, ".${var.base_domain}")
      )
      error_message = "public_fqdn (or composed hostname) must equal base_domain or end with .<base_domain> so the record can live in the zone for var.base_domain (e.g. agenthub.myenv.example.com with base_domain=example.com)."
    }
  }
}

# PR-env teardown (PR-Env Removal #6): the PR-env wildcard ACM cert,
# DNS-01 validation records, and *.preview.<alb_fqdn> A-record alias
# used to live here. They have been removed along with the rest of the
# PR-env subsystem (cards #1–#5). Operators must run `terraform apply`
# against prod state to actually destroy the ACM cert + Route 53
# records the previous plan provisioned.

# ── Session-preview subdomain mode (RFC Phase 4a) ─────────────────────────
# Wildcard ACM cert + Route 53 alias + ALB listener cert attachment for
# `*.preview.<alb_fqdn>`. Lets each session preview live at its own
# subdomain (<sessionId>.preview.<alb_fqdn>) so the app inside the
# iframe sees itself at `/` and renders correctly without per-app
# base-path config. The server-side dispatcher (Phase 4b) reads the
# matching `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE` env on the agent-hub
# process; setting one without the other is a no-op (resources idle,
# dispatcher off).
#
# Gated on `enable_preview_subdomain` (default false) AND the same
# `enable_dedicated_alb` + Route 53 zone preconditions that gate the
# main ACM resources above, so a partial config can never half-create.

locals {
  # Subdomain base ("preview.<alb_fqdn>") and wildcard FQDN
  # ("*.preview.<alb_fqdn>"). Both null when prerequisites are missing
  # so every conditional downstream collapses cleanly.
  preview_subdomain_create = var.enable_preview_subdomain && var.enable_dedicated_alb && local.has_route53_zone && local.alb_fqdn != null
  preview_subdomain_base   = local.preview_subdomain_create ? "preview.${local.alb_fqdn}" : null
  preview_wildcard_fqdn    = local.preview_subdomain_create ? "*.preview.${local.alb_fqdn}" : null
  # Relative record name in the zone for the wildcard alias. The FQDN
  # already starts with `*.`; trimming off `.<base_domain>` yields the
  # in-zone label (e.g. `*.preview.agenthub`). An earlier version
  # prepended another `*.` and produced the broken `*.*.preview.agenthub`
  # record — fixed.
  preview_r53_name_in_zone = local.preview_wildcard_fqdn == null ? null : trimsuffix(local.preview_wildcard_fqdn, ".${var.base_domain}")
}

resource "aws_acm_certificate" "preview_wildcard" {
  count = local.preview_subdomain_create ? 1 : 0

  domain_name       = local.preview_wildcard_fqdn
  validation_method = "DNS"

  lifecycle {
    # ACM cert recreation forces an attachment churn but no instance
    # impact; create_before_destroy keeps the listener serving the old
    # cert until the new one is fully validated + attached.
    create_before_destroy = true
  }

  tags = {
    Name = "${var.project_name}-preview-wildcard"
  }
}

# DNS-01 validation records for the wildcard. Same pattern as the
# main agenthub cert above — one CNAME per domain_validation_option.
# For a single wildcard the for_each will have exactly one entry, but
# keeping the for_each form means a future SAN addition (e.g. a second
# wildcard) Just Works without restructuring this block.
resource "aws_route53_record" "preview_wildcard_cert_validation" {
  for_each = local.preview_subdomain_create ? { for dvo in aws_acm_certificate.preview_wildcard[0].domain_validation_options : dvo.domain_name => dvo } : {}

  zone_id = local.route53_zone_id_effective
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 60
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "preview_wildcard" {
  count = local.preview_subdomain_create ? 1 : 0

  certificate_arn         = aws_acm_certificate.preview_wildcard[0].arn
  validation_record_fqdns = [for r in aws_route53_record.preview_wildcard_cert_validation : r.fqdn]
}

# Attach the wildcard cert to the existing HTTPS listener so the ALB
# serves both `agenthub.<base>` and `*.preview.<base>` via SNI. The
# default cert (set on the listener resource) remains the apex cert
# from earlier in this file; the wildcard piggybacks via SNI.
resource "aws_lb_listener_certificate" "preview_wildcard" {
  count = local.preview_subdomain_create ? 1 : 0

  listener_arn    = aws_lb_listener.agenthub_https[0].arn
  certificate_arn = aws_acm_certificate_validation.preview_wildcard[0].certificate_arn
}

# Wildcard A alias so any `<label>.preview.<alb_fqdn>` resolves to the
# ALB. The server-side dispatcher (Phase 4b) then routes by Host
# header to the right session-preview port. Route 53 alias records
# don't carry an explicit TTL — propagation follows the underlying
# ALB DNS TTL (60s).
resource "aws_route53_record" "preview_wildcard_alias" {
  count = local.preview_subdomain_create ? 1 : 0

  zone_id = local.route53_zone_id_effective
  name    = local.preview_r53_name_in_zone
  type    = "A"

  alias {
    name                   = aws_lb.agenthub[0].dns_name
    zone_id                = aws_lb.agenthub[0].zone_id
    evaluate_target_health = true
  }

  depends_on = [
    aws_lb_listener_certificate.preview_wildcard,
    aws_acm_certificate_validation.preview_wildcard,
  ]
}
