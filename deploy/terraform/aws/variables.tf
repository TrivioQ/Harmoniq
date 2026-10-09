variable "name" {
  description = "Prefix for all resources"
  type        = string
  default     = "harmoniq"
}

variable "vpc_id" {
  description = "Existing VPC"
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets for the load balancer"
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets for ECS tasks, RDS and Redis (need egress for image pulls and webhooks)"
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate covering registry_domain and web_domain"
  type        = string
}

variable "registry_domain" {
  description = "Public hostname of the registry API, e.g. registry.acme.dev"
  type        = string
}

variable "web_domain" {
  description = "Public hostname of the dashboard, e.g. harmoniq.acme.dev"
  type        = string
}

variable "registry_image" {
  description = "Registry image, e.g. ghcr.io/acme/harmoniq-registry:v1.0.0"
  type        = string
}

variable "web_image" {
  description = "Dashboard image, e.g. ghcr.io/acme/harmoniq-web:v1.0.0"
  type        = string
}

variable "registry_count" {
  description = "Registry replicas (Redis keeps their caches consistent)"
  type        = number
  default     = 2
}

variable "web_count" {
  description = "Dashboard replicas"
  type        = number
  default     = 1
}

variable "db_multi_az" {
  description = "Run Postgres as a Multi-AZ deployment"
  type        = bool
  default     = true
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "smtp_url" {
  description = "SMTP connection URL for email sign-in (optional)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "github_client_id" {
  type    = string
  default = ""
}

variable "github_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
