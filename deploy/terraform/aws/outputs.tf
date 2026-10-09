output "alb_dns_name" {
  description = "Point registry_domain and web_domain at this (CNAME or alias)"
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "For Route 53 alias records"
  value       = aws_lb.this.zone_id
}

output "manifest_cdn_url" {
  description = "Base URL of published manifests (SDK cdnBaseUrl)"
  value       = "https://${aws_cloudfront_distribution.manifests.domain_name}"
}

output "manifest_bucket" {
  value = aws_s3_bucket.manifests.bucket
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "migrate_command" {
  description = "Run before first start and before each upgrade"
  value = join(" ", [
    "aws ecs run-task --cluster ${aws_ecs_cluster.this.name}",
    "--launch-type FARGATE --task-definition ${aws_ecs_task_definition.migrate.family}",
    "--network-configuration 'awsvpcConfiguration={subnets=[${join(",", var.private_subnet_ids)}],securityGroups=[${aws_security_group.tasks.id}]}'",
  ])
}

output "secret_arn" {
  description = "Secrets Manager entry holding JWT_SECRET, HARMONIQ_ENCRYPTION_KEY and database URLs"
  value       = aws_secretsmanager_secret.app.arn
}
