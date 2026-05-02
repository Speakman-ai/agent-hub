# Dedicated public ALB → Agent Hub on EC2 (TLS at the load balancer, HTTP to the app port).
# Requires a second public subnet in another AZ (see main.tf). Enable with
# `enable_dedicated_alb = true` plus `name` and either `acm_certificate_arn` or
# `route53_zone_id` (or optional public_fqdn) (to issue/validate an ACM cert via DNS).

data "aws_route53_zone" "base" {
  count = var.enable_dedicated_alb && var.lookup_route53_zone_in_this_account && (var.route53_zone_id == null || var.route53_zone_id == "") ? 1 : 0

  name         = "${var.base_domain}."
  private_zone = false
}

locals {
  # Avoid coalesce(…, try(data[0]…)) when the data block has count=0 — not all nulls/empty.
  route53_zone_id_effective = (
    var.route53_zone_id != null && var.route53_zone_id != "" ? var.route53_zone_id : (
      length(data.aws_route53_zone.base) > 0 ? data.aws_route53_zone.base[0].zone_id : null
    )
  )
  has_route53_zone = local.route53_zone_id_effective != null && local.route53_zone_id_effective != ""
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

# App port on EC2: only the ALB may connect (in addition to any CIDRs you open on the instance for direct access).
resource "aws_vpc_security_group_ingress_rule" "agenthub_app_from_alb" {
  count = var.enable_dedicated_alb ? 1 : 0

  security_group_id = aws_security_group.instance.id
  from_port         = var.agent_hub_target_port
  to_port           = var.agent_hub_target_port
  ip_protocol       = "tcp"
  # IPv4-only: ALB ENIs use security group reference (replaces 0.0.0.0/0 to the app port)
  referenced_security_group_id = aws_security_group.agenthub_alb[0].id
}

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

  lifecycle {
    precondition {
      condition     = !var.enable_dedicated_alb || local.has_public_fqdn || (var.name != null && var.name != "")
      error_message = "When enable_dedicated_alb is true, set public_fqdn to the full hostname (e.g. agenthub.ryan.aimetrics.com), or set name (and usually dns_subdomain) to build <dns_subdomain>.<name>.<base_domain>."
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
    unhealthy_threshold = 2
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  tags = {
    Name = "${var.project_name}-ah-tg"
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
      error_message = "public_fqdn (or composed hostname) must equal base_domain or end with .<base_domain> so the record can live in the zone for var.base_domain (e.g. agenthub.ryan.aimetrics.com with base_domain=aimetrics.com)."
    }
  }
}

# --- PR Envs: wildcard ACM cert for *.<pr_env_preview_subdomain>.<alb_fqdn> --
#
# Issued for host nginx to terminate TLS on per-PR preview hostnames such as
# `pr-123.preview.agenthub.ryan.dev.surveytracker.io`. NOT attached to the ALB
# listener — the ALB only fronts the canonical Agent Hub host. Default-disabled
# (gated on var.enable_pr_env_wildcard_cert) so existing stacks plan as 0
# changes until they opt in.

locals {
  pr_env_preview_host = local.alb_fqdn != null ? "${var.pr_env_preview_subdomain}.${local.alb_fqdn}" : null
}

resource "aws_acm_certificate" "pr_env_wildcard" {
  count = var.enable_pr_env_wildcard_cert ? 1 : 0

  domain_name       = "*.${local.pr_env_preview_host}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = local.has_route53_zone
      error_message = "enable_pr_env_wildcard_cert = true requires a discoverable Route 53 zone for base_domain. Set route53_zone_id, or set lookup_route53_zone_in_this_account = true so DNS-01 validation records can be written."
    }

    precondition {
      condition     = local.alb_fqdn != null
      error_message = "enable_pr_env_wildcard_cert = true requires alb_fqdn to resolve. Set public_fqdn (preferred) or set name + dns_subdomain + base_domain so the wildcard host *.<pr_env_preview_subdomain>.<alb_fqdn> can be composed."
    }
  }

  tags = {
    Name = "${var.project_name}-pr-env-wildcard"
  }
}

resource "aws_route53_record" "pr_env_wildcard_cert_validation" {
  for_each = var.enable_pr_env_wildcard_cert ? {
    for dvo in aws_acm_certificate.pr_env_wildcard[0].domain_validation_options : dvo.domain_name => dvo
  } : {}

  zone_id = local.route53_zone_id_effective
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 60
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "pr_env_wildcard" {
  count = var.enable_pr_env_wildcard_cert ? 1 : 0

  certificate_arn         = aws_acm_certificate.pr_env_wildcard[0].arn
  validation_record_fqdns = [for r in aws_route53_record.pr_env_wildcard_cert_validation : r.fqdn]
}
