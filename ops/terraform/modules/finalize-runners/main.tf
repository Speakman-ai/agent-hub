# Finalize runner fleet: ECS-on-EC2 with privileged DinD job containers.
# DRAFT — pending `terraform validate`/`plan` on the box.
#
# Model: an ECS *service* of N runner-agent tasks polls the Hub, claims jobs, and
# starts privileged sibling DinD job containers on the instance (via the mounted
# host docker.sock — same model the Hub uses locally). One job per task →
# task `memory` reservation ≈ instance RAM so the scheduler places one task per
# instance and the capacity provider scales the ASG to match.

data "aws_caller_identity" "current" {}

locals {
  name = "${var.project_name}-finalize-runner"
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/agent-hub/finalize/runner/${var.project_name}"
  retention_in_days = 14
  tags              = var.tags
}

# Egress-only SG — agents dial OUT to the Hub/ECR/S3; nothing inbound.
resource "aws_security_group" "runner" {
  name        = "${local.name}-sg"
  description = "Finalize runner fleet (egress only)"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(var.tags, { Name = "${local.name}-sg" })
}

resource "aws_ecs_cluster" "fleet" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = var.tags
}

# ── EC2 capacity: launch template + ASG + capacity provider ──────────────────
resource "aws_launch_template" "runner" {
  name_prefix   = "${local.name}-"
  image_id      = var.ami_id
  instance_type = var.instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.runner.arn
  }

  metadata_options {
    http_tokens   = "required" # IMDSv2
    http_endpoint = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.root_volume_size
      volume_type           = "gp3"
      iops                  = 6000
      throughput            = 250
      delete_on_termination = true
    }
  }

  # Register with the cluster + enable task IAM roles + spot draining.
  # Also pre-create the shared worktree dir sticky-world-writable: it's bind-
  # mounted into the agent task at /finalize-ws, and the agent (non-root `runner`
  # user) materializes the git worktree into a subdir there. Without this the
  # host dir is root-owned and the agent gets EACCES.
  user_data = base64encode(<<-EOT
    #!/bin/bash
    cat <<'ECSCFG' >> /etc/ecs/ecs.config
    ECS_CLUSTER=${local.name}
    ECS_ENABLE_TASK_IAM_ROLE=true
    ECS_ENABLE_SPOT_INSTANCE_DRAINING=true
    ECS_IMAGE_PULL_BEHAVIOR=prefer-cached
    ECS_RESERVED_MEMORY=512
    ECSCFG
    mkdir -p /finalize-ws && chmod 1777 /finalize-ws
    # The agent task's non-root `runner` user reaches the HOST docker socket to
    # start sibling job containers; its in-image docker-group GID won't match the
    # host socket's GID and ECS task defs can't --group-add, so open the socket
    # (single-tenant-per-instance fleet). Wait for dockerd to create it first.
    ( for i in $(seq 1 60); do [ -S /var/run/docker.sock ] && chmod 666 /var/run/docker.sock && break; sleep 2; done ) &
    # AL2023 hardens fs.protected_regular (=1), which stops the job container's
    # root dockerd from writing its log file (runner-owned) in sticky /tmp,
    # wedging inner-dockerd startup (and tripping the overlay2 graphdriver probe).
    # Relax it on this single-tenant CI host so DinD comes up on overlay2.
    echo 'fs.protected_regular=0' > /etc/sysctl.d/99-finalize-dind.conf && sysctl -p /etc/sysctl.d/99-finalize-dind.conf
    # Pre-pull the runner image so the agent's `docker run` for sibling JOB
    # containers finds it cached. The agent's docker CLI (in the task) can't auth
    # to ECR — ECS only auths the agent task's OWN image pull, not the sibling
    # `docker run`. The instance role has ECR pull, so log in + pull here at boot;
    # a cached image means `docker run` never contacts the registry. Backgrounded
    # so it doesn't delay ECS registration.
    ( for i in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
      aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${split("/", var.agent_image_uri)[0]} >/dev/null 2>&1
      docker pull ${var.agent_image_uri} ) &
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = local.name })
  }
}

resource "aws_autoscaling_group" "fleet" {
  name_prefix         = "${local.name}-"
  vpc_zone_identifier = var.subnet_ids
  min_size            = var.min_size
  max_size            = var.max_size
  # desired_capacity is owned by the ECS capacity provider (managed scaling) and
  # the Hub's queue-depth scaler at runtime — TF must NOT set/reset it. And TF
  # must not block an apply waiting for capacity it doesn't control, which is what
  # made the apply time out ("want 0 healthy, have 6") while a run was scaled up.
  wait_for_capacity_timeout = "0"

  # Spot fleet (interruptible — CI re-runs) across a diversified pool of 32 GB
  # instance types so Spot stays available. capacity-optimized picks the deepest
  # pools (fewest interruptions). spot=false → 100% on-demand.
  mixed_instances_policy {
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.runner.id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = var.instance_types
        content {
          instance_type = override.value
        }
      }
    }
    instances_distribution {
      on_demand_base_capacity                  = var.spot ? 0 : var.max_size
      on_demand_percentage_above_base_capacity = var.spot ? 0 : 100
      spot_allocation_strategy                 = "capacity-optimized"
    }
  }

  # Required for ECS managed termination protection.
  protect_from_scale_in = true

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
  lifecycle {
    create_before_destroy = true
    ignore_changes        = [desired_capacity]
  }
}

resource "aws_ecs_capacity_provider" "fleet" {
  name = local.name
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.fleet.arn
    managed_termination_protection = "ENABLED"
    managed_scaling {
      status          = "ENABLED"
      target_capacity = 100
      # Scale out in big steps so a run's shards get instances fast (one job per
      # instance), instead of adding a single instance per scaling action.
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = var.max_size
      instance_warmup_period    = 30
    }
  }
  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "fleet" {
  cluster_name       = aws_ecs_cluster.fleet.name
  capacity_providers = [aws_ecs_capacity_provider.fleet.name]
  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.fleet.name
    weight            = 1
  }
}

# ── Runner-agent service ─────────────────────────────────────────────────────
resource "aws_ecs_task_definition" "agent" {
  family                   = "${local.name}-agent"
  network_mode             = "bridge"
  requires_compatibilities = ["EC2"]
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # Host docker.sock + a host workspace dir so the agent can start privileged
  # sibling job containers on the instance and bind-mount the materialized
  # worktree by its HOST path (FINALIZE_RUNNER_WORKSPACE_DIR).
  volume {
    name      = "docker-sock"
    host_path = "/var/run/docker.sock"
  }
  volume {
    name      = "workspace"
    host_path = "/finalize-ws"
  }

  container_definitions = jsonencode([
    {
      name              = "runner-agent"
      image             = var.agent_image_uri
      essential         = true
      memoryReservation = var.task_memory_mib
      # Override the image's default CMD (["daemon"], which starts an inner
      # dockerd for JOB containers) so this task runs the pull-based agent loop.
      command = ["agent"]
      mountPoints = [
        { sourceVolume = "docker-sock", containerPath = "/var/run/docker.sock" },
        { sourceVolume = "workspace", containerPath = "/finalize-ws" },
      ]
      environment = [
        { name = "FINALIZE_RUNNER_HUB_URL", value = var.hub_url },
        { name = "FINALIZE_RUNNER_WORKSPACE_DIR", value = "/finalize-ws" },
        { name = "FINALIZE_RUNNER_ORG_SCOPE", value = "shared" },
      ]
      secrets = [
        { name = "FINALIZE_RUNNER_FLEET_TOKEN", valueFrom = var.fleet_token_secret_arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.runner.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "agent"
        }
      }
    }
  ])
  tags = var.tags
}

resource "aws_ecs_service" "agent" {
  name            = "${local.name}-agent"
  cluster         = aws_ecs_cluster.fleet.id
  task_definition = aws_ecs_task_definition.agent.arn
  desired_count   = var.agent_desired_count

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.fleet.name
    weight            = 1
  }

  # Avoid a deploy deadlock when capacity is scaling from zero.
  deployment_minimum_healthy_percent = 0
  # >100 so a rolling deploy can stand up new-revision tasks WHILE old tasks that
  # are still running a job hold ECS task scale-in protection (they won't drain
  # until the job finishes/protection expires). At 100 the deploy would block on
  # the protected tasks (DEPLOYMENT_BLOCKED). One task per instance, so the extra
  # headroom is transient and the capacity provider adds/removes instances to match.
  deployment_maximum_percent = 200

  # The Hub's queue-depth autoscaler owns desiredCount at runtime (scales the
  # agent count to match active jobs, back to zero when idle). Don't let TF
  # reset it on apply.
  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = var.tags
}
