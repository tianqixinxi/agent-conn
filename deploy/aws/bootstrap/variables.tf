variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "project_name" {
  type    = string
  default = "agent-comm"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "github_repository" {
  description = "GitHub repository in owner/name form."
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must use owner/name form."
  }
}

variable "github_oidc_subject_prefix" {
  description = "Optional immutable GitHub OIDC repo prefix, for example repo:owner@OWNER_ID/repo@REPO_ID."
  type        = string
  default     = null
  nullable    = true
}

variable "github_environment" {
  description = "Protected GitHub Environment used by infrastructure plan/apply jobs."
  type        = string
  default     = "production"
}

variable "github_deploy_environment" {
  description = "Protected GitHub Environment used only by release deployment jobs."
  type        = string
  default     = "production-release"
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub Actions OIDC provider ARN. Leave null to create it."
  type        = string
  default     = null
  nullable    = true
}
