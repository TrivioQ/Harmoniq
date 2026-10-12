resource "harmoniq_workspace" "checkout_team" {
  organization                 = "acme"
  slug                         = "checkout-team"
  name                         = "Checkout team"
  retention_days               = 90
  allow_ephemeral_environments = true
  # Invited as owners when the workspace is created.
  owners = ["lead@acme.example"]
}
