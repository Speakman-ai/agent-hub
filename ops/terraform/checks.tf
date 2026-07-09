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

# pr_env_wildcard_requires_zone check removed in PR-Env Removal #6. See
# alb.tf for the teardown note.

check "artifacts_bucket_requires_ssm" {
  assert {
    # The artifacts/replays S3 policy attaches to the SSM EC2 instance role, so
    # the whole S3 backend (bucket + IAM policy + AGENT_HUB_ARTIFACTS_BUCKET env)
    # only wires up when enable_instance_ssm = true — see
    # local.artifacts_bucket_enabled in artifacts.tf, which folds the two together
    # so they can't diverge. This assert surfaces the requested-but-not-wired case
    # (bucket asked for, SSM off) instead of silently degrading to the local data
    # dir. Unconditional by design: the old lifecycle precondition lived on a
    # resource whose count is 0 in exactly this case, so it never fired.
    condition     = !local.artifacts_bucket_requested || var.enable_instance_ssm
    error_message = "enable_artifacts_bucket = true requires enable_instance_ssm = true (the artifacts/replays S3 policy attaches to the SSM EC2 instance role). Set enable_instance_ssm = true to use the S3 backend, or leave the artifacts bucket disabled to keep using the local data dir."
  }
}

check "finalize_spot_pool_depth" {
  assert {
    # A Spot Finalize fleet survives reclaims by diversifying across many
    # capacity-optimized pools: the more distinct instance types, the smaller the
    # fraction of the fleet a single capacity-pool reclaim can take. On-demand
    # doesn't get reclaimed, so the floor only applies when use_spot = true.
    # (2026-06-23: a 5-type pool took a 29/64-instance correlated reclaim wave.)
    condition = !var.enable_finalize_runners || !var.finalize_runner_use_spot || (
      length(toset(var.finalize_runner_instance_types)) >= 8
    )
    error_message = "A Spot Finalize fleet (finalize_runner_use_spot = true) needs a diversified mixed-instances pool of at least 8 DISTINCT instance types so a single capacity-pool reclaim can't take a large fraction of the fleet at once. Add more host-sized xlarge types to finalize_runner_instance_types (duplicates don't count), or set finalize_runner_use_spot = false."
  }
}
