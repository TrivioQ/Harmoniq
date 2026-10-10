data "harmoniq_manifest" "production" {
  workspace   = "checkout-team"
  host_app    = "storefront"
  environment = "production"
}

output "checkout_version" {
  value = one([for m in data.harmoniq_manifest.production.modules : m.version if m.name == "checkout"])
}
