output "terraform_state_bucket" {
  value = aws_s3_bucket.terraform_state.id
}

output "terraform_state_key" {
  value = "state/${var.environment}.tfstate"
}

output "github_infra_role_arn" {
  value = aws_iam_role.github_infra.arn
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}

output "github_oidc_provider_arn" {
  value = local.github_oidc_provider_arn
}

output "github_infra_oidc_subject" {
  value = local.github_infra_sub
}

output "github_deploy_oidc_subject" {
  value = local.github_deploy_sub
}

output "runtime_permissions_boundary_arn" {
  value = aws_iam_policy.runtime_boundary.arn
}
