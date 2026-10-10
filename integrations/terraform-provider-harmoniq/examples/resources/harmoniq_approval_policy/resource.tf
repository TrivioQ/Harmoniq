resource "harmoniq_approval_policy" "staging" {
  workspace          = harmoniq_workspace.checkout_team.slug
  host_app           = harmoniq_host_app.storefront.slug
  environment        = harmoniq_environment.staging.slug
  required_approvers = 1
  eligible_roles     = ["developer", "admin", "owner"]
}
