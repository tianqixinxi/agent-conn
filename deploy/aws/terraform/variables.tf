variable "aws_region" {
  description = "AWS region used by the first AgentComm channel cell."
  type        = string
  default     = "us-west-2"
}

variable "project_name" {
  description = "Resource name and tag prefix."
  type        = string
  default     = "agent-comm"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.project_name))
    error_message = "project_name must be 2-21 lowercase letters, numbers, or hyphens."
  }
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "production"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lowercase letters, numbers, or hyphens."
  }
}

variable "domain_name" {
  description = "Public relay hostname, for example relay.agentcomm.example."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]+[a-z0-9]$", var.domain_name))
    error_message = "domain_name must be a DNS hostname without scheme or path."
  }
}

variable "route53_zone_id" {
  description = "Optional Route53 hosted zone ID. Leave empty when DNS is managed elsewhere."
  type        = string
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Optional Cloudflare zone ID. Set this instead of route53_zone_id for Cloudflare DNS."
  type        = string
  default     = ""
}

variable "cloudflare_proxied" {
  description = "Proxy the relay through Cloudflare after creating its DNS record."
  type        = bool
  default     = true
}

variable "instance_type" {
  description = "EC2 instance type for the SQLite relay baseline."
  type        = string
  default     = "t3.small"
}

variable "root_volume_size_gb" {
  description = "Encrypted gp3 root volume size. Relay data is backed up separately to S3."
  type        = number
  default     = 40

  validation {
    condition     = var.root_volume_size_gb >= 20
    error_message = "root_volume_size_gb must be at least 20."
  }
}

variable "backup_retention_days" {
  description = "Number of days to retain online SQLite backups in S3."
  type        = number
  default     = 30
}

variable "enable_a2a_ingress" {
  description = "Expose the trusted plaintext A2A ingress. Keep false for the E2E relay."
  type        = bool
  default     = false
}

variable "caddy_image" {
  description = "Pinned Caddy image used as the TLS reverse proxy."
  type        = string
  default     = "caddy:2.10.2-alpine"
}
