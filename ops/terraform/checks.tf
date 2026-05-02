# Terraform 1.5+ configuration validation
check "ssh_ingress_cidrs" {
  assert {
    condition     = !var.enable_ssh_ingress || (length(var.ssh_cidr_blocks) > 0)
    error_message = "With enable_ssh_ingress = true, set ssh_cidr_blocks to at least one CIDR, or set enable_ssh_ingress = false and use SSM only (enable_instance_ssm = true, create_ssh_key = false recommended)."
  }
}

check "agent_hub_bootstrap_cors" {
  assert {
    condition     = !var.bootstrap_agent_hub || (length(local.agent_hub_cors) > 0)
    error_message = "When bootstrap_agent_hub = true, set agent_hub_allowed_origins to a comma-separated list, or enable a dedicated ALB with a hostname so CORS can default to https://<public hostname>."
  }
}

check "agent_hub_bootstrap_source" {
  assert {
    # When bootstrapping, you need EITHER an image URI (ECR-pull path) OR a git
    # URL (legacy clone+build path). The two paths are mutually exclusive at
    # runtime — see locals-agent-hub.tf (use_ecr_pull takes precedence).
    condition = !var.bootstrap_agent_hub || (
      length(trimspace(var.agent_hub_image_uri)) > 0
      || (length(trimspace(var.agent_hub_git_url)) > 0 && can(regex("^https://", var.agent_hub_git_url)))
    )
    error_message = "When bootstrap_agent_hub = true, set either (a) agent_hub_image_uri to a container image like public.ecr.aws/h9t4v7h0/agent-hub:main — recommended — or (b) agent_hub_git_url to a non-empty https:// clone URL."
  }
}

# Early-warning surface for the PR-env wildcard cert. The hard error lives on
# aws_acm_certificate.pr_env_wildcard's preconditions (alb.tf), which halt
# `terraform plan`. This `check` block additionally surfaces the same advice
# when only lookup_route53_zone_in_this_account is wired (no explicit zone id),
# so operators see one consolidated message in plan output.
check "pr_env_wildcard_requires_zone" {
  assert {
    condition     = !var.enable_pr_env_wildcard_cert || local.has_route53_zone
    error_message = "enable_pr_env_wildcard_cert = true requires a discoverable Route 53 zone for base_domain. Set route53_zone_id directly, or set lookup_route53_zone_in_this_account = true so the zone for base_domain is resolved in this account."
  }
}
