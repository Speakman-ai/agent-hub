# Systems Manager Session Manager: connect without SSH keys.
# See outputs ssm_start_session_one_liner, ssm_secrets_manager (optional) in outputs.tf

resource "aws_iam_role" "ec2_ssm" {
  count = var.enable_instance_ssm ? 1 : 0

  name = "${var.project_name}-ec2-ssm"
  path = "/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-ec2-ssm"
  }
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  count = var.enable_instance_ssm ? 1 : 0

  role       = aws_iam_role.ec2_ssm[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2_ssm" {
  count = var.enable_instance_ssm ? 1 : 0

  name = "${var.project_name}-ssm"
  path = "/"
  role = aws_iam_role.ec2_ssm[0].name

  tags = {
    Name = "${var.project_name}-ssm"
  }
}
