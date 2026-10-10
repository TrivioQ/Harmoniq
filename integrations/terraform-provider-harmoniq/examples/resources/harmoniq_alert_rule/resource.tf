# Abort the checkout canary in production when more than 5% of its loads fail.
resource "harmoniq_alert_rule" "checkout_canary_errors" {
  workspace      = harmoniq_workspace.checkout_team.slug
  name           = "checkout canary errors"
  condition      = "canary_error_rate"
  threshold      = 0.05
  action         = "auto_rollback"
  module_id      = harmoniq_remote_module.checkout.id
  environment    = harmoniq_environment.production.slug
  window_minutes = 10
  min_samples    = 50
}
