# Bootstrap env + git URL (same Terraform module as alb.tf locals: local.alb_fqdn, etc.)
locals {
  # ── PR-env feature gating ───────────────────────────────────────────────────
  # `enable_pr_environments` (default true) is the single root flag operators
  # flip in tfvars. The three per-piece variables (`enable_pr_env_*`) are
  # nullable bool overrides — non-null wins; null means "follow the parent."
  # Every resource, check, and template MUST reference these locals (never
  # `var.enable_pr_env_*` directly) so the override semantics stay consistent.
  pr_env_wildcard_cert_enabled = (
    var.enable_pr_env_wildcard_cert != null
    ? var.enable_pr_env_wildcard_cert
    : var.enable_pr_environments
  )
  pr_env_route53_iam_enabled = (
    var.enable_pr_env_route53_iam != null
    ? var.enable_pr_env_route53_iam
    : var.enable_pr_environments
  )
  pr_env_host_nginx_enabled = (
    var.enable_pr_env_host_nginx != null
    ? var.enable_pr_env_host_nginx
    : var.enable_pr_environments
  )
  pr_env_ssm_secrets_enabled = (
    var.enable_pr_env_ssm_secrets != null
    ? var.enable_pr_env_ssm_secrets
    : var.enable_pr_environments
  )

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

  # First-boot Owner credentials (server/auth-bootstrap.ts). Empty values
  # disable auto-provision and leave the interactive /api/auth/setup flow
  # as the only path. `agent_hub_default_password = "auto"` instructs the
  # server to generate a random password and write it to the
  # initial-credentials.txt file inside the data dir.
  default_owner_username_trim = trimspace(coalesce(var.agent_hub_default_username, ""))
  default_owner_password_trim = trimspace(coalesce(var.agent_hub_default_password, ""))
  emit_default_owner_env      = length(local.default_owner_password_trim) > 0

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
    local.emit_default_owner_env ? [
      join("", ["AGENT_HUB_DEFAULT_PASSWORD=", jsonencode(local.default_owner_password_trim)]),
    ] : [],
    local.emit_default_owner_env && length(local.default_owner_username_trim) > 0 ? [
      join("", ["AGENT_HUB_DEFAULT_USERNAME=", jsonencode(local.default_owner_username_trim)]),
    ] : [],
  ))

  # Docker: pass-through to container (server/Dockerfile + --env-file).
  #
  # IMPORTANT: docker `--env-file` does NOT interpret quotes as delimiters —
  # `KEY="value"` lands in the container as the literal 7-char value `"value"`
  # (per docker.com/reference/cli/docker/container/run/#env-file). That broke
  # AGENT_HUB_DEFAULT_USERNAME validation and skipped Owner auto-provision.
  # We previously jsonencode'd every value (necessary for the PM2 path above,
  # which bash-sources the file and therefore strips matching quotes), but
  # for the docker path we must emit raw KEY=VALUE pairs.
  #
  # Newlines are stripped defensively — `--env-file` parses one line per pair
  # and an embedded \n would silently truncate the value or inject the rest
  # as an extra (mis-parsed) variable.
  docker_public_url_value = replace(
    (var.enable_dedicated_alb && local.alb_fqdn != null) ? "https://${local.alb_fqdn}" : "",
    "\n", ""
  )
  docker_bootstrap_env = join("\n", concat(
    [
      "NODE_ENV=production",
      "AGENT_HUB_DATA_DIR=/data",
      "AGENT_HUB_PORT=${tostring(var.agent_hub_target_port)}",
      "AGENT_HUB_HOST=0.0.0.0",
      "AGENT_HUB_PUBLIC_URL=${local.docker_public_url_value}",
    ],
    local.agent_hub_trust_proxy_hops > 0 ? [
      "TRUST_PROXY=${tostring(local.agent_hub_trust_proxy_hops)}",
    ] : [],
    ["ALLOWED_ORIGINS=${replace(local.agent_hub_cors, "\n", "")}"],
    local.effective_agent_hub_api_key != "" ? [
      "AGENT_HUB_API_KEY=${replace(local.effective_agent_hub_api_key, "\n", "")}",
    ] : [],
    local.emit_default_owner_env ? [
      "AGENT_HUB_DEFAULT_PASSWORD=${replace(local.default_owner_password_trim, "\n", "")}",
    ] : [],
    local.emit_default_owner_env && length(local.default_owner_username_trim) > 0 ? [
      "AGENT_HUB_DEFAULT_USERNAME=${replace(local.default_owner_username_trim, "\n", "")}",
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

  # PR-env mode: pre-render the base nginx fragment (no per-template-vars yet,
  # but routing through templatefile() keeps the door open for future
  # interpolations and matches the convention used by every other on-host file
  # written from this module).
  pr_env_base_nginx_conf = templatefile(
    "${path.module}/templates/pr-env-base-nginx.conf.tftpl",
    {}
  )

  # PR-env Tier-3 (host paths) config block written to the canonical Agent
  # Hub `<dataDir>/config.json` at first boot. Tier-1 (general) and Tier-2
  # (encrypted credentials — GitHub App, Route 53 IAM keys, repoFullName,
  # certRenewalLive) live in the SQLite `pr_env_config` row instead and are
  # entered via Settings → PR Environments after first boot. The runtime
  # resolver in `server/container-pool/pr-env-runtime.ts` merges DB → file →
  # env-var-override per-field, so leaving Tier-1+2 absent here is the
  # intentional "operator fills in via UI" path.
  #
  # The hostname is composed exactly the way alb.tf composes
  # `local.pr_env_preview_host` for the wildcard ACM cert (PR 1 of this
  # series), so the cert and the runtime config agree on the same name.
  # Inside the container, the dataDir is bind-mounted at /data, which is
  # why prodDbPath/prEnvDataDir/envFilesDir all anchor at /data here.
  pr_env_preview_host_resolved = (
    local.pr_env_host_nginx_enabled && local.alb_fqdn != null
    ? "${var.pr_env_preview_subdomain}.${local.alb_fqdn}"
    : ""
  )
  pr_env_route53_hosted_zone_id = (
    local.pr_env_host_nginx_enabled && local.route53_zone_id_effective != null
    ? local.route53_zone_id_effective
    : ""
  )
  pr_env_config = local.pr_env_host_nginx_enabled ? {
    prEnv = {
      enabled        = true
      previewHost    = local.pr_env_preview_host_resolved
      previewBaseUrl = "https://${local.pr_env_preview_host_resolved}"
      prodDbPath     = "/data/agent-hub.db"
      prEnvDataDir   = "/data/pr-env-databases"
      envFilesDir    = "/data/pr-env-envfiles"
      nginx = {
        # Amazon Linux uses conf.d (no Debian-style sites-available/enabled).
        # Both fields point at the same dir so the validator and the per-PR
        # vhost writer agree.
        sitesAvailableDir = "/etc/nginx/conf.d"
        sitesEnabledDir   = "/etc/nginx/conf.d"
        # Base vhost the user-data first-boot script writes (line 62 of
        # agent-hub-user-data.tftpl). The validator checks this path is
        # non-empty as proof the OOB nginx wiring landed.
        baseVhostPath = "/etc/nginx/conf.d/agent-hub-pr-base.conf"
        certPath      = "/etc/letsencrypt/live/${local.pr_env_preview_host_resolved}/fullchain.pem"
        keyPath       = "/etc/letsencrypt/live/${local.pr_env_preview_host_resolved}/privkey.pem"
        certHome      = "/etc/letsencrypt"
        previewHost   = local.pr_env_preview_host_resolved
      }
      portRange = {
        min = 3100
        max = 3999
      }
      route53 = {
        hostedZoneId = local.pr_env_route53_hosted_zone_id
      }
    }
  } : null
  pr_env_config_json     = local.pr_env_config != null ? jsonencode(local.pr_env_config) : ""
  pr_env_config_json_b64 = local.pr_env_config_json != "" ? base64encode(local.pr_env_config_json) : ""

  user_data_templated = templatefile(
    "${path.module}/agent-hub-user-data.tftpl",
    {
      node_major             = var.node_major_version
      app_user               = var.app_user
      bootstrap              = var.bootstrap_agent_hub
      use_ecr_pull           = local.use_ecr_pull
      use_docker_bootstrap   = local.use_docker_bootstrap
      use_pm2_bootstrap      = local.use_pm2_bootstrap
      data_root_for_docker   = local.data_root_for_docker
      app_port               = tostring(var.agent_hub_target_port)
      git_url                = local.git_url_for_bootstrap
      git_ref                = var.agent_hub_git_ref
      repo_dir               = "/home/${var.app_user}/${var.agent_hub_repo_basename}"
      env_b64                = local.agent_hub_bootstrap_env_b64
      docker_env_b64         = local.docker_bootstrap_env_b64
      image_uri              = local.agent_hub_image_uri_trim
      ssm_deb_url            = "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/debian_amd64/amazon-ssm-agent.deb"
      pr_env_enabled         = local.pr_env_host_nginx_enabled
      pr_env_base_nginx_conf = local.pr_env_base_nginx_conf
      config_json_b64        = local.pr_env_config_json_b64
      # PR-env first-boot wildcard cert (certbot --dns-route53). The hostname
      # passed here is the resolved cert lineage name (matches
      # pr_env_config.nginx.{certPath,keyPath}). The email is the Let's Encrypt
      # registration contact; it is required at plan time when
      # local.pr_env_host_nginx_enabled = true (precondition on aws_instance.app).
      pr_env_preview_host = local.pr_env_preview_host_resolved
      cert_renewal_email  = var.cert_renewal_email != null ? trimspace(var.cert_renewal_email) : ""
    }
  )
}
