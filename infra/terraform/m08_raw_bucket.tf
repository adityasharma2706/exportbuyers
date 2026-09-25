# M08 raw landing bucket (LLD M08). Dated, immutable object storage for connector payloads:
#   s3://<raw bucket>/<source_id>/<yyyy>/<mm>/<dd>/<sha256>
#
# - Versioning on, Object Lock in GOVERNANCE mode. Each object is written with a per-object
#   retain-until date equal to its expiry (see kp.m08_sources.storage), so it cannot be changed
#   or deleted before then except by a principal holding s3:BypassGovernanceRetention (M38
#   erasure runbook only).
# - Lifecycle expiry per source prefix is derived from knowledge.source.retention_days and is
#   written by the nightly job `m08.sync_raw_lifecycle`, NOT by Terraform. Terraform therefore
#   ignores changes to the lifecycle configuration so the two never fight.

resource "aws_s3_bucket" "raw" {
  bucket              = "${local.name}-raw"
  object_lock_enabled = true
  tags                = { module = "m08_sources" }
}

resource "aws_s3_bucket_versioning" "raw" {
  bucket = aws_s3_bucket.raw.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_object_lock_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id
  # No default retention: retention is set per object from the source's retention_days, so a
  # short-retention source is not blocked from expiring by a longer bucket default.
  depends_on = [aws_s3_bucket_versioning.raw]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "raw" {
  bucket                  = aws_s3_bucket.raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Baseline lifecycle rule; the nightly job replaces the whole configuration with this rule plus
# one expiry rule per source prefix.
resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id
  rule {
    id     = "m08-baseline"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  depends_on = [aws_s3_bucket_versioning.raw]
  lifecycle { ignore_changes = [rule] }
}

resource "aws_s3_bucket_policy" "raw_tls" {
  bucket = aws_s3_bucket.raw.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.raw.arn, "${aws_s3_bucket.raw.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

output "raw_bucket" { value = aws_s3_bucket.raw.bucket }
