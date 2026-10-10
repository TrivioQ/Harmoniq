data "harmoniq_workspace" "checkout_team" {
  slug = "checkout-team"
}

output "host_apps" {
  value = [for h in data.harmoniq_workspace.checkout_team.host_apps : h.slug]
}
