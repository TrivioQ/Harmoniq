resource "harmoniq_remote_module" "checkout" {
  workspace   = harmoniq_workspace.checkout_team.slug
  host_app    = harmoniq_host_app.storefront.slug
  slug        = "checkout"
  name        = "Checkout"
  description = "Cart and payment"
  specifier   = "@acme/checkout"
}
