# A trial of enterprise until the end of January, then back to startup.
resource "harmoniq_organization_plan" "acme" {
  provider     = harmoniq.instance
  organization = "acme"
  plan         = "enterprise"
  expires_at   = "2027-01-31T00:00:00Z"
  base_plan    = "startup"
}
