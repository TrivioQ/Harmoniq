resource "harmoniq_environment" "staging" {
  workspace = harmoniq_workspace.checkout_team.slug
  host_app  = harmoniq_host_app.storefront.slug
  slug      = "staging"
  name      = "Staging"
}

resource "harmoniq_environment" "production" {
  workspace  = harmoniq_workspace.checkout_team.slug
  host_app   = harmoniq_host_app.storefront.slug
  slug       = "production"
  name       = "Production"
  is_default = true

  approval_policy = {
    required_approvers    = 2
    eligible_roles        = ["admin", "owner"]
    require_change_ticket = true
    ticket_url_pattern    = "https://acme.atlassian.net/browse/{id}"
    expiry_hours          = 24
  }
}
