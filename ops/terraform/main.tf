terraform {
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
  }
}

provider "aws" {
  region = var.aws_region
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

# --- Security Group ---

resource "aws_security_group" "instance" {
  name        = "${var.project_name}-sg"
  description = "Allow SSH, HTTP, HTTPS inbound"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_cidr_blocks
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
}

# --- Key Pair ---

resource "tls_private_key" "instance" {
  algorithm = "ED25519"
}

resource "aws_key_pair" "instance" {
  key_name   = "${var.project_name}-key"
  public_key = tls_private_key.instance.public_key_openssh
}

resource "local_file" "private_key" {
  content         = tls_private_key.instance.private_key_openssh
  filename        = "${path.module}/${var.project_name}-key.pem"
  file_permission = "0600"
}

# --- EC2 Instance ---

resource "aws_instance" "app" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.instance.id]
  key_name               = aws_key_pair.instance.key_name

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = var.root_volume_type
  }

  user_data = <<-EOF
    #!/bin/bash
    set -e

    # System updates
    apt-get update && apt-get upgrade -y

    # Install Node.js ${var.node_major_version}
    curl -fsSL https://deb.nodesource.com/setup_${var.node_major_version}.x | bash -
    apt-get install -y nodejs

    # Install PM2 globally
    npm install -g pm2

    # Install Nginx
    apt-get install -y nginx
    systemctl enable nginx

    # Create app user
    useradd -m -s /bin/bash ${var.app_user}
    mkdir -p /home/${var.app_user}/app
    chown ${var.app_user}:${var.app_user} /home/${var.app_user}/app

    # Install cursor-agent CLI (used by sessions with engine=cursor-agent).
    # The official installer (https://cursor.com/install) is per-user and
    # hardcodes the install path to $HOME/.local/share/cursor-agent/versions
    # with a symlink at $HOME/.local/bin/agent. It does NOT honor PREFIX /
    # INSTALL_DIR env vars, so we run it as the app user and then symlink
    # into /usr/local/bin/agent to match the server's cursorBin default.
    #
    # IMPORTANT: `sudo -u` alone preserves $HOME from the caller (root), so
    # the installer would write to /root/.local/... instead of the app user's
    # home. We pass `-H` so sudo remaps $HOME to /home/${var.app_user}.
    # Verified against https://cursor.com/docs/cli/installation on 2026-04-21.
    sudo -H -u ${var.app_user} bash -c 'curl -fsSL https://cursor.com/install | bash' \
      || echo "cursor-agent install failed; sessions with engine=cursor-agent will ENOENT" >&2
    if [ -x /home/${var.app_user}/.local/bin/agent ]; then
      ln -sf /home/${var.app_user}/.local/bin/agent /usr/local/bin/agent
    else
      echo "cursor-agent binary not found at /home/${var.app_user}/.local/bin/agent; /usr/local/bin/agent symlink NOT created" >&2
    fi
  EOF

  tags = {
    Name = "${var.project_name}-sandbox"
  }
}
