# ── Hub data volume + automated snapshots ────────────────────────────────────
# A dedicated, encrypted EBS data volume for the Hub instance (SQLite DB,
# sessions, kanban, wiki, artifacts), mounted at /dev/sdf, plus a Data Lifecycle
# Manager policy that takes daily snapshots (14-day retention).
#
# These resources were originally applied to prod OUT OF BAND — they lived in the
# prod state but were defined in no committed config, so any `terraform apply`
# planned to DESTROY the live 256 GiB data volume and its backups. This file
# re-adopts them into source control. The `[0]` count index matches the existing
# state addresses (e.g. aws_ebs_volume.hub_data[0]) so the plan reconciles to a
# no-op for these resources instead of destroy+recreate.
#
# Gated on var.enable_hub_data_volume (default false) so only prod creates them;
# every other env evaluates count = 0 and is unaffected.

data "aws_iam_policy_document" "dlm_assume" {
  count = var.enable_hub_data_volume ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  count              = var.enable_hub_data_volume ? 1 : 0
  name               = "${var.project_name}-dlm-lifecycle"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume[0].json
  tags               = { Project = var.project_name }
}

resource "aws_iam_role_policy_attachment" "dlm" {
  count      = var.enable_hub_data_volume ? 1 : 0
  role       = aws_iam_role.dlm[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_ebs_volume" "hub_data" {
  count = var.enable_hub_data_volume ? 1 : 0
  # Pinned to an explicit AZ (the live volume's), NOT aws_instance.app.availability_zone:
  # coupling to the mutable instance means a future instance replacement in another
  # AZ would force-replace this database volume (and prevent_destroy would then
  # dead-end the apply). An explicit pin keeps the volume independent of the host.
  availability_zone = var.hub_data_availability_zone
  size              = var.hub_data_volume_size
  type              = "gp3"
  iops              = 3000
  throughput        = 125
  encrypted         = true
  kms_key_id        = var.hub_data_kms_key_arn

  tags = {
    Name    = "${var.project_name}-hub-data"
    Backup  = "${var.project_name}-hub-data"
    Project = var.project_name
  }

  lifecycle {
    # This is the live prod database volume — never let a plan destroy/replace it.
    prevent_destroy = true

    # Required-when-enabled inputs (variable validation can't cross-reference
    # enable_hub_data_volume, so enforce here where the resource only exists when
    # the volume is enabled). Both must be non-empty or the apply would fail at the
    # AWS provider with an opaque error / risk wrong-AZ or default-key encryption.
    precondition {
      condition     = trimspace(var.hub_data_availability_zone) != ""
      error_message = "hub_data_availability_zone must be set to the live volume's AZ (e.g. us-east-2a) when enable_hub_data_volume = true."
    }
    precondition {
      condition     = trimspace(var.hub_data_kms_key_arn) != ""
      error_message = "hub_data_kms_key_arn must be a non-empty KMS CMK ARN when enable_hub_data_volume = true (it must match the live volume's key exactly)."
    }
  }
}

resource "aws_volume_attachment" "hub_data" {
  count       = var.enable_hub_data_volume ? 1 : 0
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.hub_data[0].id
  instance_id = aws_instance.app.id

  # The app may be mid-write to the mounted SQLite DB on this volume. Never let
  # Terraform hot-detach it from a running instance (filesystem/DB corruption).
  # Defense in depth:
  #   - stop_instance_before_detaching = true: if a detach is ever performed,
  #     the provider stops the instance first so the FS is quiesced (clean unmount).
  #   - prevent_destroy: routine Terraform can't destroy/replace this attachment
  #     at all (e.g. an instance replacement that would re-attach elsewhere
  #     dead-ends at plan time instead of silently detaching the live DB volume).
  # A deliberate detach is an operator action: drain/stop the Hub, temporarily
  # drop prevent_destroy, then apply.
  stop_instance_before_detaching = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_dlm_lifecycle_policy" "hub_data" {
  count              = var.enable_hub_data_volume ? 1 : 0
  description        = "Daily snapshots of the ${var.project_name} Hub data volume"
  execution_role_arn = aws_iam_role.dlm[0].arn
  state              = "ENABLED"
  tags               = { Project = var.project_name }

  policy_details {
    policy_type        = "EBS_SNAPSHOT_MANAGEMENT"
    resource_types     = ["VOLUME"]
    resource_locations = ["CLOUD"]
    target_tags = {
      Backup = "${var.project_name}-hub-data"
    }

    schedule {
      name      = "daily-14d"
      copy_tags = true
      tags_to_add = {
        SnapshotType = "dlm-daily"
        Project      = var.project_name
      }

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["07:00"]
        location      = "CLOUD"
      }

      retain_rule {
        count = 14
      }
    }
  }
}
