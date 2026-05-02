output "instance_public_ip" {
  description = "Public IP of the EC2 instance"
  value       = aws_instance.app.public_ip
}

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.app.id
}

output "ssh_command" {
  description = "SSH command (only if create_ssh_key = true; otherwise use ssm_start_session command)"
  value       = var.create_ssh_key ? "ssh -i ${local_file.private_key[0].filename} ${var.ssh_user}@${aws_instance.app.public_ip}" : "SSH key not created: use AWS Systems Manager (see ssm_start_session or ssm console)."
}

output "ssm_start_session" {
  description = "Start an interactive SSM session (Session Manager) without SSH. Requires: AWS CLI, session manager plugin, and IAM to start ssm:StartSession. Instance must have the SSM agent and profile (enable_instance_ssm)."
  value       = var.enable_instance_ssm ? "aws ssm start-session --target ${aws_instance.app.id} --region ${var.aws_region}" : "SSM not enabled: set enable_instance_ssm = true in tfvars and apply to attach the instance profile; ensure SSM console permissions on your user/role"
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "agenthub_public_fqdn" {
  description = "Public hostname when the dedicated ALB is enabled: var.public_fqdn if set, else <dns_subdomain>.<name>.<base_domain>."
  value       = local.alb_fqdn
}

output "agenthub_public_url" {
  description = "https URL for the intended hostname; set server ALLOWED_ORIGINS to this origin for browser clients."
  value       = local.alb_fqdn != null ? "https://${local.alb_fqdn}" : null
}

output "dedicated_alb_dns_name" {
  description = "Application load balancer DNS name: Route 53 alias target if the zone is outside this stack or in another account."
  value       = try(aws_lb.agenthub[0].dns_name, null)
}

output "dedicated_alb_zone_id" {
  description = "ALB hosted zone id for a Route 53 A alias record."
  value       = try(aws_lb.agenthub[0].zone_id, null)
}

output "agent_hub_bootstrap_enabled" {
  description = "If true, first boot clones the repo. With agent_hub_bootstrap_docker (default), it builds server/Dockerfile and runs a container; otherwise it uses host PM2."
  value       = var.bootstrap_agent_hub
}

output "agent_hub_bootstrap_uses_docker" {
  description = "If true, bootstrap used Docker. If false, legacy PM2 on the host."
  value       = var.bootstrap_agent_hub && var.agent_hub_bootstrap_docker
}

output "agent_hub_api_key" {
  description = "x-api-key for connecting to Agent Hub. Present when set in tfvars or when Terraform auto-generated a key. Null when no app API key applies to this user_data (e.g. minimal bootstrap, no docker)."
  value       = length(local.effective_agent_hub_api_key) > 0 ? local.effective_agent_hub_api_key : null
  sensitive   = true
}

output "agent_hub_allowed_origins" {
  description = "CORS/ALLOWED_ORIGINS computed for this stack (ALB FQDN when unset in tfvars). Shown in bootstrap and should match the browser web UI origin."
  value       = length(local.agent_hub_cors) > 0 ? local.agent_hub_cors : null
}

output "docker_env_path" {
  description = "Path on the instance to .env (written at first boot for legacy docker_bootstrap; clone bootstrap uses a path under the app user). Copy of bootstrap is also at /root/.agent-hub-bootstrap.env on the host."
  value       = "${var.docker_app_path}/.env"
}

output "ec2_docker_howto" {
  description = "When using legacy docker .env: rsync the repo, then compose up."
  value       = <<-EOT
    1) rsync this repo to ${var.docker_app_path}/ on the instance (do not remove the host .env there)
    2) sudo -u ${var.app_user} bash -lc "cd ${var.docker_app_path} && docker compose up -d --build"
  EOT
}

# --- PR Envs ------------------------------------------------------------------
# Surfaced for downstream PRs (host nginx config, per-PR DNS automation) to
# reference without having to re-derive locals. Null when the relevant feature
# flag is off or the inputs are insufficient.

output "pr_env_wildcard_cert_arn" {
  description = "Validated ACM certificate ARN for *.<pr_env_preview_subdomain>.<alb_fqdn>, present when enable_pr_env_wildcard_cert = true. Consumed by host nginx (NOT attached to the ALB listener)."
  value       = one(aws_acm_certificate_validation.pr_env_wildcard[*].certificate_arn)
}

output "pr_env_route53_zone_id" {
  description = "Hosted zone ID used by PR-env DNS automation. Equals local.route53_zone_id_effective (the zone for base_domain), or null when no zone is discoverable."
  value       = local.route53_zone_id_effective
}

output "pr_env_preview_host" {
  description = "Suffix for per-PR preview hostnames: <pr-id>.<this>. Equals <pr_env_preview_subdomain>.<alb_fqdn>; null when alb_fqdn cannot be composed."
  value       = local.pr_env_preview_host
}
