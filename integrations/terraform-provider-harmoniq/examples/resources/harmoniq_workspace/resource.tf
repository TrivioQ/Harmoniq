resource "harmoniq_workspace" "checkout_team" {
  organization                 = "acme"
  slug                         = "checkout-team"
  name                         = "Checkout team"
  retention_days               = 90
  allow_ephemeral_environments = true
}
