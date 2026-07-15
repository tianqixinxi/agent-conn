output "public_url" {
  value = "https://${var.domain_name}"
}

output "public_ip" {
  value = aws_eip.relay.public_ip
}

output "instance_id" {
  value = aws_instance.relay.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.relay.repository_url
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}

output "cloudwatch_log_group" {
  value = aws_cloudwatch_log_group.relay.name
}
