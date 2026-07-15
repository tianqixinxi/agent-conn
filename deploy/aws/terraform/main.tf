data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  name              = "${var.project_name}-${var.environment}"
  backup_bucket     = "${local.name}-backups-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  enable_route53    = var.route53_zone_id != ""
  enable_cloudflare = var.cloudflare_zone_id != ""
  a2a_ingress_value = var.enable_a2a_ingress ? "1" : "0"
}

check "single_dns_provider" {
  assert {
    condition     = !(local.enable_route53 && local.enable_cloudflare)
    error_message = "Configure either route53_zone_id or cloudflare_zone_id, not both."
  }
}

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  availability_zone       = data.aws_availability_zones.available.names[0]
  cidr_block              = "10.42.1.0/24"
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "relay" {
  name        = "${local.name}-relay"
  description = "Public HTTPS only; administration uses SSM with no SSH ingress"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "ACME HTTP challenge and HTTPS redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "AgentComm HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-relay" }
}

resource "aws_ecr_repository" "relay" {
  name                 = "${local.name}-relay"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "relay" {
  repository = aws_ecr_repository.relay.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the newest 50 release images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 50
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_s3_bucket" "backups" {
  bucket = local.backup_bucket
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  depends_on = [aws_s3_bucket_versioning.backups]
  bucket     = aws_s3_bucket.backups.id

  rule {
    id     = "expire-relay-backups"
    status = "Enabled"

    filter { prefix = "relay/" }

    expiration { days = var.backup_retention_days }
    noncurrent_version_expiration { noncurrent_days = 7 }
  }
}

resource "aws_cloudwatch_log_group" "relay" {
  name              = "/${var.project_name}/${var.environment}/relay"
  retention_in_days = 30
}

resource "aws_iam_role" "instance" {
  name = "${local.name}-relay-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "instance" {
  name = "${local.name}-relay-runtime"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = aws_ecr_repository.relay.arn
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.relay.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.backups.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.backups.arn}/relay/*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "relay" {
  name = "${local.name}-relay"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "relay" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.relay.id]
  iam_instance_profile        = aws_iam_instance_profile.relay.name
  associate_public_ip_address = true
  user_data_replace_on_change = false

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    aws_region         = var.aws_region
    domain_name        = var.domain_name
    ecr_repository_url = aws_ecr_repository.relay.repository_url
    backup_bucket      = aws_s3_bucket.backups.id
    cloudwatch_group   = aws_cloudwatch_log_group.relay.name
    a2a_ingress        = local.a2a_ingress_value
    caddy_image        = var.caddy_image
  })

  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name = "${local.name}-relay"
    Role = "relay"
  }
}

resource "aws_eip" "relay" {
  domain   = "vpc"
  instance = aws_instance.relay.id
  tags     = { Name = "${local.name}-relay" }
}

resource "aws_route53_record" "relay" {
  count   = local.enable_route53 ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 60
  records = [aws_eip.relay.public_ip]
}

resource "cloudflare_dns_record" "relay" {
  count   = local.enable_cloudflare ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.domain_name
  content = aws_eip.relay.public_ip
  type    = "A"
  ttl     = 1
  proxied = var.cloudflare_proxied
  comment = "AgentComm official relay; managed by Terraform"
}
