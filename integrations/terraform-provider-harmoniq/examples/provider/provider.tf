terraform {
  required_providers {
    harmoniq = {
      source  = "harmoniq-dev/harmoniq"
      version = "~> 0.1"
    }
  }
}

# Or set HARMONIQ_REGISTRY_URL and HARMONIQ_API_KEY.
provider "harmoniq" {
  registry_url = "https://registry.acme.dev"
  api_key      = var.harmoniq_org_key # an organization key with the admin scope
}

variable "harmoniq_org_key" {
  type      = string
  sensitive = true
}
