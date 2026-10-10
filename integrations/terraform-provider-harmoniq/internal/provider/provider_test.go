// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

// Acceptance tests run real Terraform against a registry (TF_ACC=1). They need
// HARMONIQ_REGISTRY_URL, HARMONIQ_API_KEY (an org key with the admin scope) and
// HARMONIQ_TEST_ORG (that organization's slug); see scripts/acc-env.sh.
var testAccProviders = map[string]func() (tfprotov6.ProviderServer, error){
	"harmoniq": providerserver.NewProtocol6WithError(New("test")()),
}

func testAccPreCheck(t *testing.T) {
	for _, name := range []string{"HARMONIQ_REGISTRY_URL", "HARMONIQ_API_KEY", "HARMONIQ_TEST_ORG"} {
		if os.Getenv(name) == "" {
			t.Fatalf("%s must be set for acceptance tests", name)
		}
	}
}

func testClient() *client.Client {
	return client.New(os.Getenv("HARMONIQ_REGISTRY_URL"), os.Getenv("HARMONIQ_API_KEY"), "acc-test")
}

func config(ws string, v map[string]string) string {
	return fmt.Sprintf(`
resource "harmoniq_workspace" "w" {
  organization   = %[1]q
  slug           = %[2]q
  name           = %[3]q
  retention_days = 30
}

resource "harmoniq_host_app" "portal" {
  workspace           = harmoniq_workspace.w.slug
  slug                = "portal"
  name                = %[4]q
  shared_dependencies = { react = "^19.0.0" }
}

resource "harmoniq_environment" "staging" {
  workspace = harmoniq_workspace.w.slug
  host_app  = harmoniq_host_app.portal.slug
  slug      = "staging"
  name      = "Staging"
}

resource "harmoniq_environment" "production" {
  workspace  = harmoniq_workspace.w.slug
  host_app   = harmoniq_host_app.portal.slug
  slug       = "production"
  name       = "Production"
  is_default = true
  approval_policy = {
    required_approvers = %[5]s
    eligible_roles     = ["admin", "owner"]
  }
}

resource "harmoniq_remote_module" "checkout" {
  workspace = harmoniq_workspace.w.slug
  host_app  = harmoniq_host_app.portal.slug
  slug      = "checkout"
  name      = "Checkout"
  specifier = "@acme/checkout"
}

resource "harmoniq_api_key" "ci" {
  workspace  = harmoniq_workspace.w.slug
  name       = "ci"
  module_ids = [harmoniq_remote_module.checkout.id]
}

resource "harmoniq_webhook_endpoint" "hook" {
  workspace = harmoniq_workspace.w.slug
  url       = "https://example.com/harmoniq"
  events    = ["deploy.success", "canary.auto_rolled_back"]
  active    = %[6]s
}

resource "harmoniq_alert_rule" "errors" {
  workspace   = harmoniq_workspace.w.slug
  name        = "checkout errors"
  condition   = "canary_error_rate"
  threshold   = %[7]s
  action      = "auto_rollback"
  module_id   = harmoniq_remote_module.checkout.id
  environment = harmoniq_environment.production.slug
}

resource "harmoniq_approval_policy" "staging" {
  workspace      = harmoniq_workspace.w.slug
  host_app       = harmoniq_host_app.portal.slug
  environment    = harmoniq_environment.staging.slug
  eligible_roles = ["owner"]
  expiry_hours   = 48
}

data "harmoniq_workspace" "w" {
  slug       = harmoniq_workspace.w.slug
  depends_on = [harmoniq_environment.staging, harmoniq_environment.production]
}

data "harmoniq_environment" "production" {
  workspace = harmoniq_workspace.w.slug
  host_app  = harmoniq_host_app.portal.slug
  slug      = harmoniq_environment.production.slug
}

data "harmoniq_manifest" "production" {
  workspace   = harmoniq_workspace.w.slug
  host_app    = harmoniq_host_app.portal.slug
  environment = harmoniq_environment.production.slug
}
`, os.Getenv("HARMONIQ_TEST_ORG"), ws, v["workspace"], v["hostApp"], v["approvers"], v["active"], v["threshold"])
}

func TestAccFullStack(t *testing.T) {
	ws := fmt.Sprintf("tfacc-%06d", rand.Intn(1_000_000))
	first := map[string]string{"workspace": "TF acceptance", "hostApp": "Portal", "approvers": "2", "active": "true", "threshold": "0.05"}
	second := map[string]string{"workspace": "TF acceptance (renamed)", "hostApp": "Portal app", "approvers": "1", "active": "false", "threshold": "0.1"}

	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProviders,
		CheckDestroy: func(*terraform.State) error {
			if _, err := testClient().GetWorkspace(context.Background(), ws); err == nil {
				return fmt.Errorf("workspace %s still exists", ws)
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config: config(ws, first),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("harmoniq_workspace.w", "id", ws),
					resource.TestCheckResourceAttr("harmoniq_workspace.w", "retention_days", "30"),
					resource.TestCheckResourceAttr("harmoniq_host_app.portal", "id", ws+"/portal"),
					resource.TestCheckResourceAttr("harmoniq_host_app.portal", "shared_dependencies.react", "^19.0.0"),
					resource.TestCheckResourceAttr("harmoniq_host_app.portal", "is_default", "false"),
					resource.TestCheckResourceAttr("harmoniq_environment.production", "is_default", "true"),
					resource.TestCheckResourceAttr("harmoniq_environment.staging", "is_default", "false"),
					resource.TestCheckResourceAttr("harmoniq_environment.production", "approval_policy.required_approvers", "2"),
					resource.TestCheckResourceAttr("harmoniq_environment.production", "approval_policy.expiry_hours", "24"),
					resource.TestCheckResourceAttrSet("harmoniq_remote_module.checkout", "id"),
					resource.TestCheckResourceAttr("harmoniq_remote_module.checkout", "specifier", "@acme/checkout"),
					resource.TestMatchResourceAttr("harmoniq_api_key.ci", "key", keyPattern),
					resource.TestCheckResourceAttr("harmoniq_api_key.ci", "scopes.#", "1"),
					resource.TestCheckResourceAttrSet("harmoniq_webhook_endpoint.hook", "secret"),
					resource.TestCheckResourceAttr("harmoniq_webhook_endpoint.hook", "max_retries", "5"),
					resource.TestCheckResourceAttrPair("harmoniq_alert_rule.errors", "module_id", "harmoniq_remote_module.checkout", "id"),
					resource.TestCheckResourceAttr("harmoniq_alert_rule.errors", "window_minutes", "5"),
					resource.TestCheckResourceAttr("harmoniq_approval_policy.staging", "expiry_hours", "48"),
					resource.TestCheckResourceAttr("data.harmoniq_workspace.w", "host_apps.#", "2"),
					resource.TestCheckResourceAttr("data.harmoniq_environment.production", "frozen", "false"),
					resource.TestCheckResourceAttr("data.harmoniq_manifest.production", "modules.#", "0"),
				),
			},
			{
				Config: config(ws, second),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("harmoniq_workspace.w", "name", "TF acceptance (renamed)"),
					resource.TestCheckResourceAttr("harmoniq_host_app.portal", "name", "Portal app"),
					resource.TestCheckResourceAttr("harmoniq_environment.production", "approval_policy.required_approvers", "1"),
					resource.TestCheckResourceAttr("harmoniq_webhook_endpoint.hook", "active", "false"),
					resource.TestCheckResourceAttr("harmoniq_alert_rule.errors", "threshold", "0.1"),
				),
			},
			// The second apply changes nothing.
			{Config: config(ws, second), PlanOnly: true},
			{ResourceName: "harmoniq_workspace.w", ImportState: true, ImportStateId: os.Getenv("HARMONIQ_TEST_ORG") + "/" + ws, ImportStateVerify: true},
			{ResourceName: "harmoniq_host_app.portal", ImportState: true, ImportStateVerify: true},
			{ResourceName: "harmoniq_environment.staging", ImportState: true, ImportStateVerify: true},
			{ResourceName: "harmoniq_remote_module.checkout", ImportState: true, ImportStateIdFunc: wsScoped("harmoniq_remote_module.checkout", ws), ImportStateVerify: true},
			{ResourceName: "harmoniq_api_key.ci", ImportState: true, ImportStateIdFunc: wsScoped("harmoniq_api_key.ci", ws), ImportStateVerify: true, ImportStateVerifyIgnore: []string{"key"}},
			{ResourceName: "harmoniq_webhook_endpoint.hook", ImportState: true, ImportStateIdFunc: wsScoped("harmoniq_webhook_endpoint.hook", ws), ImportStateVerify: true, ImportStateVerifyIgnore: []string{"secret"}},
			{ResourceName: "harmoniq_alert_rule.errors", ImportState: true, ImportStateIdFunc: wsScoped("harmoniq_alert_rule.errors", ws), ImportStateVerify: true},
			{ResourceName: "harmoniq_approval_policy.staging", ImportState: true, ImportStateVerify: true},
		},
	})
}

var keyPattern = regexp.MustCompile(`^hq_`)

// wsScoped builds "workspace/<id>" import ids.
func wsScoped(name, ws string) resource.ImportStateIdFunc {
	return func(s *terraform.State) (string, error) {
		rs, ok := s.RootModule().Resources[name]
		if !ok {
			return "", fmt.Errorf("%s not in state", name)
		}
		return ws + "/" + rs.Primary.ID, nil
	}
}
