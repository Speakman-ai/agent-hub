# Bootstrap env + git URL (same Terraform module as alb.tf locals: local.alb_fqdn, etc.)
locals {
  # Autonomous-dispatch cross-hub Secrets Manager IAM. Defaults to enabled
  # whenever the EC2 SSM instance role exists (enable_instance_ssm = true).
  # Operators can set enable_cross_hub_secrets_iam = false to opt out.
  cross_hub_secrets_iam_enabled = (
    var.enable_cross_hub_secrets_iam != null
    ? var.enable_cross_hub_secrets_iam
    : var.enable_instance_ssm
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

  # Self log-shipping (server/log-shipper.ts). AHLOG_TOKEN gates the whole group
  # — the shipper no-ops without it, so the optional endpoint/service/environment
  # overrides are only meaningful alongside a token. `ahlog_` tokens are
  # URL-safe ([A-Za-z0-9_-]) with no quotes/newlines, but we still newline-strip
  # for the raw docker `--env-file` path and jsonencode for the bash-sourced PM2
  # path, consistent with the other secrets here.
  # Null-safe trims: `coalesce(x, "")` errors when x is empty/null (all-empty arg
  # list), so use the same ternary guard as agent_hub_allowed_origins_safe above.
  agent_hub_ahlog_token_trim       = trimspace(var.agent_hub_ahlog_token == null ? "" : var.agent_hub_ahlog_token)
  agent_hub_ahlog_endpoint_trim    = trimspace(var.agent_hub_ahlog_endpoint == null ? "" : var.agent_hub_ahlog_endpoint)
  agent_hub_ahlog_service_trim     = trimspace(var.agent_hub_ahlog_service == null ? "" : var.agent_hub_ahlog_service)
  agent_hub_ahlog_environment_trim = trimspace(var.agent_hub_ahlog_environment == null ? "" : var.agent_hub_ahlog_environment)
  emit_ahlog_env                   = length(local.agent_hub_ahlog_token_trim) > 0

  # KEY=VALUE lines for the docker `--env-file` path (raw values, newline-stripped).
  agent_hub_ahlog_env_docker = local.emit_ahlog_env ? concat(
    ["AHLOG_TOKEN=${replace(local.agent_hub_ahlog_token_trim, "\n", "")}"],
    local.agent_hub_ahlog_endpoint_trim != "" ? ["AHLOG_ENDPOINT=${replace(local.agent_hub_ahlog_endpoint_trim, "\n", "")}"] : [],
    local.agent_hub_ahlog_service_trim != "" ? ["AHLOG_SERVICE=${replace(local.agent_hub_ahlog_service_trim, "\n", "")}"] : [],
    local.agent_hub_ahlog_environment_trim != "" ? ["AHLOG_ENVIRONMENT=${replace(local.agent_hub_ahlog_environment_trim, "\n", "")}"] : [],
  ) : []

  # Same pairs for the bash-sourced PM2 env file (jsonencode'd so quotes are stripped).
  agent_hub_ahlog_env_pm2 = local.emit_ahlog_env ? concat(
    [join("", ["AHLOG_TOKEN=", jsonencode(local.agent_hub_ahlog_token_trim)])],
    local.agent_hub_ahlog_endpoint_trim != "" ? [join("", ["AHLOG_ENDPOINT=", jsonencode(local.agent_hub_ahlog_endpoint_trim)])] : [],
    local.agent_hub_ahlog_service_trim != "" ? [join("", ["AHLOG_SERVICE=", jsonencode(local.agent_hub_ahlog_service_trim)])] : [],
    local.agent_hub_ahlog_environment_trim != "" ? [join("", ["AHLOG_ENVIRONMENT=", jsonencode(local.agent_hub_ahlog_environment_trim)])] : [],
  ) : []

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
    [
      "AGENT_HUB_REPLAY_RETENTION_DAYS=${tostring(var.replay_retention_days)}",
      "AGENT_HUB_REPLAY_MASK_ALL_ENFORCED=${var.replay_mask_all_enforced ? "true" : "false"}",
    ],
    # S3-backed artifacts + RUM replays (see artifacts.tf). Absent → local data dir.
    local.artifacts_bucket_enabled ? [
      join("", ["AGENT_HUB_ARTIFACTS_BUCKET=", jsonencode(var.artifacts_bucket_name)]),
      join("", ["AGENT_HUB_ARTIFACTS_BUCKET_REGION=", jsonencode(var.aws_region)]),
    ] : [],
    # Self log-shipping (server/log-shipper.ts). Empty unless agent_hub_ahlog_token is set.
    local.agent_hub_ahlog_env_pm2,
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
    [
      "AGENT_HUB_REPLAY_RETENTION_DAYS=${tostring(var.replay_retention_days)}",
      "AGENT_HUB_REPLAY_MASK_ALL_ENFORCED=${var.replay_mask_all_enforced ? "true" : "false"}",
    ],
    [
      "AGENT_HUB_CONTAINER_PROJECTS_DIR=/home/node/projects",
      "AGENT_HUB_CONTAINER_WORKSPACES_DIR=/home/node/.agent-hub/workspaces",
      "AGENT_HUB_PREVIEW_HEALTH_HOST=host.docker.internal",
      "AGENT_HUB_PREVIEW_READY_TIMEOUT_MS=600000",
    ],
    # Subdomain preview mode (live HMR): activate the server-side dispatcher
    # whenever the wildcard cert + Route 53 alias exist (enable_preview_subdomain).
    # Pairs with the *.preview.<alb_fqdn> infra in alb.tf — both are required,
    # so deriving this from the same local keeps them from drifting apart (the
    # exact half-configured state that silently broke HMR before). See
    # ops/RUNBOOK-subdomain-preview-hmr.md.
    local.preview_subdomain_create ? [
      "AGENT_HUB_PREVIEW_SUBDOMAIN_BASE=${local.preview_subdomain_base}",
    ] : [],
    # S3-backed artifacts + RUM replays (see artifacts.tf). Absent → local data dir
    # (/data/artifacts on the hub-data volume).
    local.artifacts_bucket_enabled ? [
      "AGENT_HUB_ARTIFACTS_BUCKET=${var.artifacts_bucket_name}",
      "AGENT_HUB_ARTIFACTS_BUCKET_REGION=${var.aws_region}",
    ] : [],
    # Remote Finalize fleet wiring (backend=remote, worktree bucket, autoscaler
    # cluster/service + bounds, fleet token) — empty unless enable_finalize_runners.
    local.finalize_hub_fleet_env,
    # Self log-shipping (server/log-shipper.ts). Empty unless agent_hub_ahlog_token is set.
    local.agent_hub_ahlog_env_docker,
  ))

  # ── CI-syncable subset of the Hub .env (ops/scripts/sync-hub-env.sh) ────────
  # Rendered user-data only ever reaches a NEW host — cloud-init does not re-run
  # on an existing instance — so the release pipeline upserts these lines into
  # the live .env over SSM rather than replacing the box. Two classes of key are
  # deliberately withheld from that sync:
  #
  #   - Secret-bearing (API key, fleet token, Owner password, AHLOG token). An
  #     SSM SendCommand payload is retained in command history and CloudTrail, so
  #     syncing these would hand plaintext secrets to anyone holding
  #     ssm:GetCommandInvocation. They are written once at first boot and rotated
  #     out-of-band.
  #   - AGENT_HUB_REPLAY_MASK_ALL_ENFORCED, which the in-app project settings UI
  #     owns. Re-asserting the Terraform default on every release would silently
  #     stomp whatever an operator picked in the app.
  hub_env_unmanaged_keys   = ["AGENT_HUB_REPLAY_MASK_ALL_ENFORCED"]
  hub_env_secret_key_regex = "(KEY|TOKEN|PASSWORD|SECRET)"
  hub_env_emitted          = local.use_docker_bootstrap || local.use_ecr_pull

  # The file the SSM sync edits must be the exact file the container is created
  # from, so both come from local.agent_hub_repo_dir: it is passed to the
  # user-data template as `repo_dir`, which writes "$REPO_DIR/.env" and then
  # starts the container with `--env-file "$REPO_DIR/.env"`. Re-deriving the path
  # here instead would let the two drift, and the sync would silently edit a file
  # nothing reads.
  #
  # NOT var.docker_app_path. That variable belongs to the legacy
  # bootstrap.sh.tftpl path (var.docker_bootstrap, selected only when
  # bootstrap_agent_hub = false), which never sets hub_env_emitted, so the sync
  # does not run there at all. Pointing this output at docker_app_path would aim
  # the sync at a file the running Hub was not created from. See
  # output.docker_env_path for that other path.
  hub_env_file_path_on_host = "${local.agent_hub_repo_dir}/.env"

  # Every key the sync OWNS, whether or not this configuration emits it right
  # now. The rendered env drops optional keys entirely when a feature goes off
  # (flipping enable_finalize_runners to false removes the whole FINALIZE_* group
  # from docker_bootstrap_env), so the desired lines alone cannot tell the host
  # which is which: "we do not manage this" or "we manage this and it must go".
  # Without the inventory a disabled feature keeps running on the live Hub: the
  # stale FINALIZE_RUNNER_BACKEND=remote line survives, the file compares
  # unchanged, and the service is never restarted. The host removes inventory
  # keys that are absent from the desired set; anything NOT listed here is never
  # written and never removed, which is what keeps secret-bearing and UI-owned
  # keys safe.
  hub_env_managed_key_inventory = [
    "NODE_ENV",
    "AGENT_HUB_DATA_DIR",
    "AGENT_HUB_PORT",
    "AGENT_HUB_HOST",
    "AGENT_HUB_PUBLIC_URL",
    "TRUST_PROXY",
    "ALLOWED_ORIGINS",
    "AGENT_HUB_DEFAULT_USERNAME",
    "AGENT_HUB_REPLAY_RETENTION_DAYS",
    "AGENT_HUB_CONTAINER_PROJECTS_DIR",
    "AGENT_HUB_CONTAINER_WORKSPACES_DIR",
    "AGENT_HUB_PREVIEW_HEALTH_HOST",
    "AGENT_HUB_PREVIEW_READY_TIMEOUT_MS",
    "AGENT_HUB_PREVIEW_SUBDOMAIN_BASE",
    "AGENT_HUB_ARTIFACTS_BUCKET",
    "AGENT_HUB_ARTIFACTS_BUCKET_REGION",
    "AWS_REGION",
    "FINALIZE_RUNNER_BACKEND",
    "FINALIZE_WORKTREE_BUCKET",
    "FINALIZE_WORKTREE_BUCKET_REGION",
    "FINALIZE_FLEET_ECS_CLUSTER",
    "FINALIZE_FLEET_ECS_SERVICE",
    "FINALIZE_FLEET_MIN_AGENTS",
    "FINALIZE_FLEET_MAX_AGENTS",
    "FINALIZE_FLEET_DYNAMIC_SCALE_DOWN",
    "FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS",
    "AHLOG_ENDPOINT",
    "AHLOG_SERVICE",
    "AHLOG_ENVIRONMENT",
  ]

  # Owned keys that legitimately remain visible inside the container after they
  # are removed from .env, so the host script must not treat them as a failed
  # retraction. Two sources, both outside .env:
  #
  #   - `docker run -e` in agenthub-server-run.sh (agent-hub-user-data.tftpl).
  #     Docker gives -e precedence over --env-file, so these are pinned by the
  #     run command and .env cannot move or clear them.
  #   - `ENV` lines baked into server/Dockerfile. --env-file overrides the image
  #     value while the key is present, but removing the key falls back to it.
  #
  # Kept in lockstep with both sources by server/hub-env-managed-keys.test.ts.
  # Everything else must actually disappear from the container, which is how a
  # disabled feature is proven off rather than assumed off.
  hub_env_runtime_injected_keys = [
    "NODE_ENV",
    "AGENT_HUB_DATA_DIR",
    "AGENT_HUB_HOST",
    "AGENT_HUB_CONTAINER_PROJECTS_DIR",
    "AGENT_HUB_CONTAINER_WORKSPACES_DIR",
    "AGENT_HUB_PREVIEW_HEALTH_HOST",
  ]

  # Non-secret, non-UI-owned lines the current configuration renders. Every key
  # here must appear in the inventory above, or the sync would write a key it can
  # never retract. Asserted by the precondition on output.hub_env_managed.
  hub_env_syncable_lines = [
    for line in split("\n", local.docker_bootstrap_env) : line
    if length(trimspace(line)) > 0
    && !contains(local.hub_env_unmanaged_keys, split("=", line)[0])
    && length(regexall(local.hub_env_secret_key_regex, split("=", line)[0])) == 0
  ]

  hub_env_unlisted_keys = distinct([
    for line in local.hub_env_syncable_lines : split("=", line)[0]
    if !contains(local.hub_env_managed_key_inventory, split("=", line)[0])
  ])

  hub_env_managed_lines = [
    for line in local.hub_env_syncable_lines : line
    if contains(local.hub_env_managed_key_inventory, split("=", line)[0])
  ]

  agent_hub_image_uri_trim = trimspace(var.agent_hub_image_uri)
  # Same tag as the server image; CI pushes both repos on every main merge.
  agent_hub_finalize_runner_image_uri = (
    length(local.agent_hub_image_uri_trim) > 0
    ? replace(
      local.agent_hub_image_uri_trim,
      "/${var.ecr_public_repo_name}:",
      "/${var.ecr_public_finalize_runner_repo_name}:",
    )
    : ""
  )
  use_ecr_pull = var.bootstrap_agent_hub && length(local.agent_hub_image_uri_trim) > 0
  # When ECR pull is active it takes precedence over docker-build-from-clone.
  use_docker_bootstrap = var.bootstrap_agent_hub && var.agent_hub_bootstrap_docker && !local.use_ecr_pull
  use_pm2_bootstrap    = var.bootstrap_agent_hub && !var.agent_hub_bootstrap_docker && !local.use_ecr_pull

  agent_hub_bootstrap_env_b64 = local.use_pm2_bootstrap ? base64encode(local.agent_hub_bootstrap_env) : ""
  # ECR pull path and docker-build path share the same .env contract — the
  # server expects the same variables regardless of how the image was sourced.
  docker_bootstrap_env_b64 = (local.use_docker_bootstrap || local.use_ecr_pull) ? base64encode(local.docker_bootstrap_env) : ""
  data_root_for_docker     = "/var/lib/agent-hub"

  # The app checkout on the instance, and therefore the directory holding the
  # .env the container is started with. Single source for the user-data template
  # (`repo_dir`) and for local.hub_env_file_path_on_host, so the file the SSM
  # sync edits cannot drift from the file the container reads.
  agent_hub_repo_dir = "/home/${var.app_user}/${var.agent_hub_repo_basename}"

  # Embedded in EC2 user-data (base64) so first boot can compile a no-op
  # libprofiler.so.0 on AL2023 when stock nginx links a broken gperftools build.
  libprofiler_stub_c_b64 = filebase64("${path.module}/templates/libprofiler-stub.c")

  user_data_templated = templatefile(
    "${path.module}/agent-hub-user-data.tftpl",
    {
      node_major                = var.node_major_version
      app_user                  = var.app_user
      bootstrap                 = var.bootstrap_agent_hub
      use_ecr_pull              = local.use_ecr_pull
      use_docker_bootstrap      = local.use_docker_bootstrap
      use_pm2_bootstrap         = local.use_pm2_bootstrap
      data_root_for_docker      = local.data_root_for_docker
      app_port                  = tostring(var.agent_hub_target_port)
      git_url                   = local.git_url_for_bootstrap
      git_ref                   = var.agent_hub_git_ref
      repo_dir                  = local.agent_hub_repo_dir
      env_b64                   = local.agent_hub_bootstrap_env_b64
      docker_env_b64            = local.docker_bootstrap_env_b64
      image_uri                 = local.agent_hub_image_uri_trim
      finalize_runner_image_uri = local.agent_hub_finalize_runner_image_uri
      ssm_deb_url               = "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/debian_amd64/amazon-ssm-agent.deb"
      libprofiler_stub_c_b64    = local.libprofiler_stub_c_b64
      # Finalize fleet base-image pull-through cache (registry:2 proxy on this Hub).
      enable_finalize_registry_mirror = var.enable_finalize_registry_mirror
      finalize_dockerhub_secret_arn   = var.finalize_dockerhub_secret_arn
      aws_region                      = var.aws_region
    }
  )
}
