resource "harmoniq_workspace_plan" "checkout_team" {
  provider          = harmoniq.instance
  workspace         = "checkout-team"
  plan              = "startup"
  feature_overrides = { saml = true }
  # -1 is unlimited.
  limit_overrides = { modules = 100, deploysPerMonth = -1 }
}
