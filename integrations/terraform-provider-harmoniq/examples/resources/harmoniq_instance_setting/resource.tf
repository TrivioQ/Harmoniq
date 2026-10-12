# Instance administration uses an instance API key (hq_inst_…, scope instance:admin),
# created by an instance owner in the admin panel.
provider "harmoniq" {
  alias   = "instance"
  api_key = var.harmoniq_instance_api_key
}

resource "harmoniq_instance_setting" "gc" {
  provider = harmoniq.instance
  key      = "gc"
  value = jsonencode({
    keepVersions         = 20
    defaultRetentionDays = 90
  })
}

resource "harmoniq_instance_setting" "branding" {
  provider = harmoniq.instance
  key      = "branding"
  value = jsonencode({
    name       = "Acme Frontends"
    supportUrl = "https://help.acme.example"
  })
}
