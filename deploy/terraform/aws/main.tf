# Copyright The Harmoniq Authors
# SPDX-License-Identifier: Apache-2.0

data "aws_region" "current" {}

locals {
  tags         = merge({ Application = "harmoniq" }, var.tags)
  region       = data.aws_region.current.name
  registry_url = "https://${var.registry_domain}"
  web_url      = "https://${var.web_domain}"

  db_owner = "harmoniq"
  db_app   = "harmoniq_app"
  db_name  = "harmoniq"
  db_host  = aws_db_instance.this.address
  # Prisma accepts sslmode=require without verification; node-pg (pg-boss) treats it as
  # verify-full, so every task loads the RDS CA bundle first (see local.with_rds_ca).
  owner_url = "postgresql://${local.db_owner}:${random_password.db_owner.result}@${local.db_host}:5432/${local.db_name}?sslmode=require"
  app_url   = "postgresql://${local.db_app}:${random_password.db_app.result}@${local.db_host}:5432/${local.db_name}?sslmode=require"
  redis_url = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"

  with_rds_ca = "wget -qO /tmp/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem && export NODE_EXTRA_CA_CERTS=/tmp/rds-ca.pem"

  secret_keys = merge(
    {
      JWT_SECRET              = random_password.jwt.result
      HARMONIQ_ENCRYPTION_KEY = random_id.encryption_key.b64_std
      DATABASE_URL            = local.app_url
      SYSTEM_DATABASE_URL     = local.owner_url
    },
    var.smtp_url != "" ? { SMTP_URL = var.smtp_url } : {},
    var.github_client_secret != "" ? { GITHUB_CLIENT_SECRET = var.github_client_secret } : {},
  )
  registry_secrets = [for k in keys(local.secret_keys) : { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }]
  web_secrets      = [{ name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_SECRET::" }]

  registry_env = concat(
    [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "4000" },
      { name = "PUBLIC_URL", value = local.registry_url },
      { name = "WEB_ORIGIN", value = local.web_url },
      { name = "CACHE_ADAPTER", value = "redis" },
      { name = "REDIS_URL", value = local.redis_url },
      { name = "STORAGE_ADAPTER", value = "s3" },
      { name = "S3_BUCKET", value = aws_s3_bucket.manifests.bucket },
      { name = "S3_REGION", value = local.region },
      { name = "S3_PUBLIC_URL", value = "https://${aws_cloudfront_distribution.manifests.domain_name}" },
    ],
    var.github_client_id != "" ? [{ name = "GITHUB_CLIENT_ID", value = var.github_client_id }] : [],
  )

  log_config = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.this.name
      awslogs-region        = local.region
      awslogs-stream-prefix = "harmoniq"
    }
  }
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_id" "encryption_key" {
  byte_length = 32
}

# URL-safe so they can be embedded in connection strings unescaped.
resource "random_password" "db_owner" {
  length  = 40
  special = false
}

resource "random_password" "db_app" {
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name_prefix = "${var.name}-"
  description = "Harmoniq application secrets"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.secret_keys)
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "tasks" {
  name_prefix = "${var.name}-tasks-"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    from_port       = 3000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  # Dashboard → registry over Service Connect.
  ingress {
    from_port = 4000
    to_port   = 4000
    protocol  = "tcp"
    self      = true
  }
  # Bundle validation, webhooks, GitHub OAuth, image pulls.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "data" {
  name_prefix = "${var.name}-data-"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}

# ---------------------------------------------------------------------------
# Postgres and Redis
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name_prefix = "${var.name}-"
  subnet_ids  = var.private_subnet_ids
  tags        = local.tags
}

resource "aws_db_instance" "this" {
  identifier_prefix         = "${var.name}-"
  engine                    = "postgres"
  engine_version            = "16"
  instance_class            = var.db_instance_class
  allocated_storage         = 20
  max_allocated_storage     = 200
  storage_encrypted         = true
  db_name                   = local.db_name
  username                  = local.db_owner
  password                  = random_password.db_owner.result
  db_subnet_group_name      = aws_db_subnet_group.this.name
  vpc_security_group_ids    = [aws_security_group.data.id]
  multi_az                  = var.db_multi_az
  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"
  tags                      = local.tags
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = "${var.name}-redis"
  description                = "Harmoniq manifest cache and rate limits"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  tags                       = local.tags
}

# ---------------------------------------------------------------------------
# Published manifests: private S3 bucket behind CloudFront
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "manifests" {
  bucket_prefix = "${var.name}-manifests-"
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "manifests" {
  bucket                  = aws_s3_bucket.manifests.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "manifests" {
  name                              = "${var.name}-manifests"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "cors" {
  name = "Managed-SimpleCORS"
}

resource "aws_cloudfront_distribution" "manifests" {
  enabled         = true
  comment         = "Harmoniq published manifests"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"
  tags            = local.tags

  origin {
    domain_name              = aws_s3_bucket.manifests.bucket_regional_domain_name
    origin_id                = "manifests"
    origin_access_control_id = aws_cloudfront_origin_access_control.manifests.id
  }

  # The managed policy honours the objects' Cache-Control (max-age=30, swr=300).
  default_cache_behavior {
    target_origin_id           = "manifests"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.cors.id
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "manifests_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.manifests.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.manifests.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "manifests" {
  bucket = aws_s3_bucket.manifests.id
  policy = data.aws_iam_policy_document.manifests_bucket.json
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.app.arn]
    }]
  })
}

# The registry publishes manifests with its task role (no static S3 keys).
resource "aws_iam_role" "registry" {
  name_prefix        = "${var.name}-registry-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "registry_s3" {
  role = aws_iam_role.registry.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.manifests.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.manifests.arn]
      },
    ]
  })
}

resource "aws_iam_role" "web" {
  name_prefix        = "${var.name}-web-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

# ---------------------------------------------------------------------------
# ECS
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  tags = local.tags
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# The dashboard calls the registry privately (http://registry:4000) instead of through
# the public load balancer and NAT, so the registry sees users' addresses (forwarded by
# the dashboard, trusted from private networks) rather than the NAT gateway's.
resource "aws_service_discovery_http_namespace" "this" {
  name = var.name
  tags = local.tags
}

resource "aws_ecs_task_definition" "registry" {
  family                   = "${var.name}-registry"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.registry.arn
  tags                     = local.tags

  container_definitions = jsonencode([{
    name             = "registry"
    image            = var.registry_image
    essential        = true
    command          = ["sh", "-c", "${local.with_rds_ca} && exec node dist/index.js"]
    portMappings     = [{ name = "registry", containerPort = 4000, protocol = "tcp", appProtocol = "http" }]
    environment      = local.registry_env
    secrets          = local.registry_secrets
    logConfiguration = local.log_config
  }])
}

# One-off: create the app role, then apply migrations. Run before each upgrade
# (see the README for the aws ecs run-task command).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.registry.arn
  tags                     = local.tags

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = var.registry_image
    essential = true
    command = ["sh", "-c", join(" && ", [
      local.with_rds_ca,
      "npx tsx scripts/bootstrap-db.ts",
      "cd ../../packages/db",
      "npx prisma migrate deploy",
    ])]
    environment      = [{ name = "NODE_ENV", value = "production" }]
    secrets          = local.registry_secrets
    logConfiguration = local.log_config
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web.arn
  tags                     = local.tags

  container_definitions = jsonencode([{
    name         = "web"
    image        = var.web_image
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "HARMONIQ_ENV", value = "production" },
      # Server-side calls stay inside the VPC (Service Connect); browsers use the public URL.
      { name = "REGISTRY_URL", value = "http://registry:4000" },
      { name = "PUBLIC_REGISTRY_URL", value = local.registry_url },
      { name = "APP_URL", value = local.web_url },
    ]
    secrets          = local.web_secrets
    logConfiguration = local.log_config
  }])
}

resource "aws_ecs_service" "registry" {
  name            = "${var.name}-registry"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.registry.arn
  desired_count   = var.registry_count
  launch_type     = "FARGATE"
  tags            = local.tags

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.registry.arn
    container_name   = "registry"
    container_port   = 4000
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.this.arn
    service {
      port_name = "registry"
      client_alias {
        dns_name = "registry"
        port     = 4000
      }
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.registry]
}

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_count
  launch_type     = "FARGATE"
  tags            = local.tags

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.this.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.web]
}

# ---------------------------------------------------------------------------
# Load balancer: host-based routing (the dashboard has its own /api/* routes,
# so the two apps can't share a hostname by path).
# ---------------------------------------------------------------------------

resource "aws_lb" "this" {
  name_prefix        = substr(var.name, 0, 6)
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]
  tags               = local.tags
}

resource "aws_lb_target_group" "registry" {
  name_prefix = "hqreg-"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  tags        = local.tags

  health_check {
    path    = "/health"
    matcher = "200"
  }
}

resource "aws_lb_target_group" "web" {
  name_prefix = "hqweb-"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  tags        = local.tags

  # The root redirects to a locale or sign-in.
  health_check {
    path    = "/"
    matcher = "200-399"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "registry" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.registry.arn
  }
  condition {
    host_header {
      values = [var.registry_domain]
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  condition {
    host_header {
      values = [var.web_domain]
    }
  }
}
