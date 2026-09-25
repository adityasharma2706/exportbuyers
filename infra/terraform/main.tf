# M01 Platform foundation — all environments in ONE India region (REQ-057 latency,
# REQ-061/REQ-062 DPDP India hosting). The region is validated, not merely defaulted.

terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
  }
  backend "s3" {
    # bucket / key / dynamodb_table supplied with -backend-config per environment.
    region = "ap-south-1"
  }
}

variable "env" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
  validation {
    condition     = contains(["ap-south-1", "ap-south-2"], var.region)
    error_message = "All infrastructure must be in an India region (ap-south-1 or ap-south-2)."
  }
}

variable "vpc_id" {
  type    = string
  default = ""
}

variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

provider "aws" {
  region              = var.region
  allowed_account_ids = null
  default_tags {
    tags = { app = "exportbuyers", env = var.env, module = "m01_platform" }
  }
}

locals {
  name = "exportbuyers-${var.env}"
}

resource "aws_kms_key" "data" {
  description         = "${local.name} data-at-rest key"
  enable_key_rotation = true
}

# --- Secrets manager: one JSON bundle per plane, values set out-of-band -----------------
resource "aws_secretsmanager_secret" "app" {
  name       = "exportbuyers/${var.env}/app"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret" "kp" {
  name       = "exportbuyers/${var.env}/kp"
  kms_key_id = aws_kms_key.data.arn
}

# --- Versioned object storage --------------------------------------------------------------
resource "aws_s3_bucket" "objects" {
  bucket = "${local.name}-objects"
}

resource "aws_s3_bucket_versioning" "objects" {
  bucket = aws_s3_bucket.objects.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "objects" {
  bucket                  = aws_s3_bucket.objects.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# TLS-only access to the bucket.
resource "aws_s3_bucket_policy" "objects_tls" {
  bucket = aws_s3_bucket.objects.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.objects.arn, "${aws_s3_bucket.objects.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# --- Postgres 16 (+ pgvector) ---------------------------------------------------------------
resource "aws_db_subnet_group" "pg" {
  name       = "${local.name}-pg"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "timezone"
    value = "UTC"
  }
}

resource "aws_db_instance" "pg" {
  identifier                    = "${local.name}-pg"
  engine                        = "postgres"
  engine_version                = "16"
  instance_class                = var.env == "production" ? "db.r6g.large" : "db.t4g.medium"
  allocated_storage             = 100
  max_allocated_storage         = 1000
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.data.arn
  db_subnet_group_name          = aws_db_subnet_group.pg.name
  parameter_group_name          = aws_db_parameter_group.pg16.name
  username                      = "app_admin_login"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn
  multi_az                      = var.env == "production"
  backup_retention_period       = var.env == "production" ? 14 : 3
  deletion_protection           = var.env == "production"
  publicly_accessible           = false
  performance_insights_enabled  = true
  skip_final_snapshot           = var.env != "production"
  final_snapshot_identifier     = var.env == "production" ? "${local.name}-pg-final" : null
}

# --- Redis ------------------------------------------------------------------------------------
resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.name}-redis"
  description                = "${local.name} cache, budget flags, rate limits"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.env == "production" ? "cache.r7g.large" : "cache.t4g.small"
  num_cache_clusters         = var.env == "production" ? 2 : 1
  automatic_failover_enabled = var.env == "production"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
}

output "object_bucket" { value = aws_s3_bucket.objects.bucket }
output "app_secret_id" { value = aws_secretsmanager_secret.app.name }
output "kp_secret_id" { value = aws_secretsmanager_secret.kp.name }
output "pg_endpoint" { value = aws_db_instance.pg.address }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
