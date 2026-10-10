resource "harmoniq_host_app" "storefront" {
  workspace            = harmoniq_workspace.checkout_team.slug
  slug                 = "storefront"
  name                 = "Storefront"
  preview_url_template = "https://preview.acme.dev/?harmoniq-env={environment}"
  shared_dependencies = {
    react     = "^19.0.0"
    react-dom = "^19.0.0"
  }
  strict_exposes = true
}
