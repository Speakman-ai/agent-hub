variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "ryan-remote-server"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "ami_id" {
  description = "Ubuntu 24.04 AMI ID for us-east-2"
  type        = string
  default     = "ami-0be45a99d3b2708c6"
}

variable "ssh_cidr_blocks" {
  description = "CIDR blocks allowed to SSH — no default so terraform apply fails without an explicit value (e.g. [\"<your-ip>/32\"])"
  type        = list(string)
}

variable "web_cidr_blocks" {
  description = "CIDR blocks allowed to reach HTTP/HTTPS (ports 80, 443)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "egress_cidr_blocks" {
  description = "CIDR blocks allowed for outbound traffic from the instance"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr_block" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr_block" {
  description = "CIDR block for the public subnet"
  type        = string
  default     = "10.0.150.0/24"
}

variable "availability_zone_suffix" {
  description = "Availability zone suffix (appended to aws_region, e.g. \"a\" for us-east-2a)"
  type        = string
  default     = "a"
}

variable "internet_route_cidr_block" {
  description = "Destination CIDR for the public route table default route"
  type        = string
  default     = "0.0.0.0/0"
}

variable "root_volume_size" {
  description = "Size (GB) of the root EBS volume"
  type        = number
  default     = 30
}

variable "root_volume_type" {
  description = "Type of the root EBS volume (e.g. gp3, gp2, io1)"
  type        = string
  default     = "gp3"
}

variable "node_major_version" {
  description = "Major Node.js version installed by user_data (via NodeSource)"
  type        = string
  default     = "20"
}

variable "app_user" {
  description = "Linux user created on the instance to own the app directory"
  type        = string
  default     = "agenthub"
}

variable "ssh_user" {
  description = "Default SSH username for the AMI (Ubuntu AMIs use \"ubuntu\")"
  type        = string
  default     = "ubuntu"
}
