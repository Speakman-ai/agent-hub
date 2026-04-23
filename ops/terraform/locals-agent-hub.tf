# Bootstrap env + git URL (same Terraform module as alb.tf locals: local.alb_fqdn, etc.)
locals {
  # For random_id count (avoids trimspace on null) and for effective API key.
  agent_hub_api_key_trim = (var.agent_hub_api_key == null ? "" : trimspace(var.agent_hub_api_key))
  # New bootstrap (clone + Docker) or legacy 571 user_data (docker_bootstrap, no app clone in TF)
  need_agent_hub_api_key = length(local.agent_hub_api_key_trim) == 0 && (
    (var.bootstrap_agent_hub && var.agent_hub_bootstrap_docker) ||
    (!var.bootstrap_agent_hub && var.docker_bootstrap)
  )

  # Non-empty CORS: explicit override, else https FQDN when an ALB hostname exists in this plan.
  # Use a null-safe string for trim (Terraform 1.8+ coalesce rejects (null, "") in some cases).
  agent_hub_allowed_origins_safe = (var.agent_hub_allowed_origins == null ? "" : var.agent_hub_allowed_origins)
  agent_hub_cors = trimspace(
    coalesce(
      (length(trimspace(local.agent_hub_allowed_origins_safe)) > 0
        ? trimspace(local.agent_hub_allowed_origins_safe)
      : null),
      (var.enable_dedicated_alb && local.alb_fqdn != null ? "https://${local.alb_fqdn}" : null),
      "",
    ),
  )

  agent_hub_trust_proxy_hops = var.agent_hub_trust_proxy != null ? var.agent_hub_trust_proxy : (
    var.enable_dedicated_alb ? 1 : 0
  )

  github_clone_token_filled = var.github_token_for_git_clone != null && var.github_token_for_git_clone != ""

  git_url_for_bootstrap = (
    !local.github_clone_token_filled
    ? var.agent_hub_git_url
    : startswith(var.agent_hub_git_url, "https://github.com/")
    ? replace(
      var.agent_hub_git_url,
      "https://github.com/",
      "https://${var.github_token_for_git_clone}@github.com/"
    )
    : replace(
      var.agent_hub_git_url,
      "https://",
      "https://${var.github_token_for_git_clone}@"
    )
  )

  effective_agent_hub_api_key = (
    length(local.agent_hub_api_key_trim) > 0 ? local.agent_hub_api_key_trim : (
      length(random_id.agent_hub_api_key) > 0 ? random_id.agent_hub_api_key[0].hex : ""
    )
  )

  # Host PM2: small env file
  agent_hub_bootstrap_env = join("\n", concat(
    [
      "NODE_ENV=production",
      "AGENT_HUB_PORT=${tostring(var.agent_hub_target_port)}",
    ],
    local.agent_hub_trust_proxy_hops > 0 ? [
      "TRUST_PROXY=${tostring(local.agent_hub_trust_proxy_hops)}",
    ] : [],
    [join("", ["ALLOWED_ORIGINS=", jsonencode(local.agent_hub_cors)])],
  ))

  # Docker: pass-through to container (server/Dockerfile + --env-file)
  docker_bootstrap_env = join("\n", concat(
    [
      "NODE_ENV=production",
      "AGENT_HUB_DATA_DIR=/data",
      "AGENT_HUB_PORT=${tostring(var.agent_hub_target_port)}",
      "AGENT_HUB_HOST=0.0.0.0",
      join("", [
        "AGENT_HUB_PUBLIC_URL=",
        jsonencode(
          (var.enable_dedicated_alb && local.alb_fqdn != null) ? "https://${local.alb_fqdn}" : ""
        ),
      ]),
    ],
    local.agent_hub_trust_proxy_hops > 0 ? [
      "TRUST_PROXY=${tostring(local.agent_hub_trust_proxy_hops)}",
    ] : [],
    [join("", ["ALLOWED_ORIGINS=", jsonencode(local.agent_hub_cors)])],
    local.effective_agent_hub_api_key != "" ? [
      join("", ["AGENT_HUB_API_KEY=", jsonencode(local.effective_agent_hub_api_key)]),
    ] : [],
  ))

  agent_hub_image_uri_trim = trimspace(var.agent_hub_image_uri)
  use_ecr_pull             = var.bootstrap_agent_hub && length(local.agent_hub_image_uri_trim) > 0
  # When ECR pull is active it takes precedence over docker-build-from-clone.
  use_docker_bootstrap = var.bootstrap_agent_hub && var.agent_hub_bootstrap_docker && !local.use_ecr_pull
  use_pm2_bootstrap    = var.bootstrap_agent_hub && !var.agent_hub_bootstrap_docker && !local.use_ecr_pull

  agent_hub_bootstrap_env_b64 = local.use_pm2_bootstrap ? base64encode(local.agent_hub_bootstrap_env) : ""
  # ECR pull path and docker-build path share the same .env contract — the
  # server expects the same variables regardless of how the image was sourced.
  docker_bootstrap_env_b64 = (local.use_docker_bootstrap || local.use_ecr_pull) ? base64encode(local.docker_bootstrap_env) : ""
  data_root_for_docker     = "/var/lib/agent-hub"

  user_data_templated = templatefile(
    "${path.module}/agent-hub-user-data.tftpl",
    {
      node_major           = var.node_major_version
      app_user             = var.app_user
      bootstrap            = var.bootstrap_agent_hub
      use_ecr_pull         = local.use_ecr_pull
      use_docker_bootstrap = local.use_docker_bootstrap
      use_pm2_bootstrap    = local.use_pm2_bootstrap
      data_root_for_docker = local.data_root_for_docker
      app_port             = tostring(var.agent_hub_target_port)
      git_url              = local.git_url_for_bootstrap
      git_ref              = var.agent_hub_git_ref
      repo_dir             = "/home/${var.app_user}/${var.agent_hub_repo_basename}"
      env_b64              = local.agent_hub_bootstrap_env_b64
      docker_env_b64       = local.docker_bootstrap_env_b64
      image_uri            = local.agent_hub_image_uri_trim
      ssm_deb_url          = "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/debian_amd64/amazon-ssm-agent.deb"
    }
  )
}
