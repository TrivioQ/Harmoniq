resource "harmoniq_webhook_endpoint" "slack_bridge" {
  workspace = harmoniq_workspace.checkout_team.slug
  url       = "https://hooks.acme.dev/harmoniq"
  events    = ["deploy.success", "deploy.approval_requested", "canary.auto_rolled_back"]
}
