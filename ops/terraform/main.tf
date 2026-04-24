# State migration: key / local_file resources now use [0] when using count
moved {
  from = tls_private_key.instance
  to   = tls_private_key.instance[0]
}

moved {
  from = aws_key_pair.instance
  to   = aws_key_pair.instance[0]
}

moved {
  from = local_file.private_key
  to   = local_file.private_key[0]
}

terraform {
  # Keep the floor low so operators on older TF (e.g. 1.7.x) can still plan/apply.
  # Features that require a newer TF (e.g. `use_lockfile = true` for native S3
  # state locking, which needs >= 1.10) are opt-in per-env via backend.hcl, not
  # globally enforced here. Operators on TF < 1.10 use the DynamoDB lock-table
  # fallback — see environments/*/backend.hcl.
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Resolve the latest ECS-optimized Amazon Linux 2023 AMI from SSM. This AMI has
# Docker + SSM agent + the ECR credential helper preinstalled, which is what the
# ECR-pull bootstrap path needs. AWS publishes the same parameter in every
# region; TF will pick up new AL2023 releases automatically on re-apply.
data "aws_ssm_parameter" "ecs_optimized_al2023" {
  count = var.use_ecs_optimized_ami && var.ami_id == null ? 1 : 0

  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended"
}

locals {
  # The SSM parameter returns a JSON blob — extract image_id.
  ecs_optimized_ami_id = (
    length(data.aws_ssm_parameter.ecs_optimized_al2023) > 0
    ? jsondecode(data.aws_ssm_parameter.ecs_optimized_al2023[0].value).image_id
    : null
  )
  effective_ami_id = coalesce(
    var.ami_id,
    local.ecs_optimized_ami_id,
    # Final fallback so plan doesn't hit `null` if neither source is configured.
    "ami-03f272c8e6091aa73", # AL2023 ECS-optimized in us-east-2 on 2026-04-23
  )
  # Legacy bootstrap.sh.tftpl: IMDS for ALLOWED_ORIGINS and public URL
  use_imds_for_allowed = (var.allowed_origins == "" || var.allowed_origins == "AUTO")
  allowed_from_tf      = local.use_imds_for_allowed ? "" : var.allowed_origins
  allowed_b64          = base64encode(local.allowed_from_tf)
  public_b64           = base64encode(var.agent_hub_public_url)
  use_imds_for_public  = tostring(var.agent_hub_public_url == "")
}

# --- VPC ---

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.project_name}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidr_block
  availability_zone       = "${var.aws_region}${var.availability_zone_suffix}"
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = var.internet_route_cidr_block
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Second public subnet in another AZ — required for an application load balancer (2 AZs minimum).
resource "aws_subnet" "public_b" {
  count = var.enable_dedicated_alb ? 1 : 0

  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.second_public_subnet_cidr_block
  availability_zone       = "${var.aws_region}${var.alb_availability_zone_suffix_b}"
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public-b"
  }
}

resource "aws_route_table_association" "public_b" {
  count = var.enable_dedicated_alb ? 1 : 0

  subnet_id      = aws_subnet.public_b[0].id
  route_table_id = aws_route_table.public.id
}

# --- Security Group ---

resource "aws_security_group" "instance" {
  # name_prefix (not a fixed `name`) allows create_before_destroy: create the replacement
  # first, move the instance to it, then remove the old SG. A fixed name would block
  # replacement with DependencyViolation.
  name_prefix = "${var.project_name}-sg-"
  description = "SSM, optional SSH, web for local nginx; app port for ALB"
  vpc_id      = aws_vpc.main.id

  dynamic "ingress" {
    for_each = var.enable_ssh_ingress && length(var.ssh_cidr_blocks) > 0 ? [1] : []
    content {
      description = "SSH (optional; prefer SSM if disabled)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_cidr_blocks
    }
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.web_cidr_blocks
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.web_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = var.egress_cidr_blocks
  }

  tags = {
    Name = "${var.project_name}-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Key Pair (optional; SSM is preferred) ---

resource "tls_private_key" "instance" {
  count = var.create_ssh_key ? 1 : 0

  algorithm = "ED25519"
}

resource "aws_key_pair" "instance" {
  count = var.create_ssh_key ? 1 : 0

  key_name   = "${var.project_name}-key"
  public_key = tls_private_key.instance[0].public_key_openssh
}

resource "local_file" "private_key" {
  count = var.create_ssh_key ? 1 : 0

  content         = tls_private_key.instance[0].private_key_openssh
  filename        = "${path.module}/${var.project_name}-key.pem"
  file_permission = "0600"
}

# --- EC2 Instance ---

resource "aws_instance" "app" {
  ami                    = local.effective_ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.instance.id]
  key_name               = var.create_ssh_key ? aws_key_pair.instance[0].key_name : null
  iam_instance_profile   = var.enable_instance_ssm ? aws_iam_instance_profile.ec2_ssm[0].id : null

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = var.root_volume_type
  }

  user_data = var.bootstrap_agent_hub ? local.user_data_templated : (
    var.docker_bootstrap ? templatefile("${path.module}/bootstrap.sh.tftpl", {
      app_user              = var.app_user
      node_major_version    = var.node_major_version
      docker_app_path       = var.docker_app_path
      web_port              = tostring(var.agent_hub_web_port)
      agent_hub_api_key_b64 = base64encode(nonsensitive(local.effective_agent_hub_api_key))
      allowed_b64           = local.allowed_b64
      public_b64            = local.public_b64
      use_imds_for_public   = local.use_imds_for_public
      }) : templatefile("${path.module}/bootstrap-minimal.sh.tftpl", {
      app_user           = var.app_user
      node_major_version = var.node_major_version
  }))

  user_data_replace_on_change = var.user_data_replace_on_change

  tags = {
    Name = "${var.project_name}-sandbox"
  }
}
