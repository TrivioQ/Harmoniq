data "harmoniq_environment" "production" {
  workspace = "checkout-team"
  host_app  = "storefront"
  slug      = "production"
}
