# A deploy key for the checkout repository's CI, limited to its module.
resource "harmoniq_api_key" "checkout_ci" {
  workspace  = harmoniq_workspace.checkout_team.slug
  name       = "checkout-github-actions"
  scopes     = ["deploy:write"]
  module_ids = [harmoniq_remote_module.checkout.id]
}

output "checkout_ci_key" {
  value     = harmoniq_api_key.checkout_ci.key
  sensitive = true
}
