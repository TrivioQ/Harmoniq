// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

// Instance administration needs an instance key (HARMONIQ_INSTANCE_API_KEY, scope
// instance:admin), a workspace (HARMONIQ_TEST_WORKSPACE) and an organization
// (HARMONIQ_TEST_ORG) to set the plans of.
func testAccInstancePreCheck(t *testing.T) {
	for _, name := range []string{"HARMONIQ_REGISTRY_URL", "HARMONIQ_INSTANCE_API_KEY", "HARMONIQ_TEST_WORKSPACE", "HARMONIQ_TEST_ORG"} {
		if os.Getenv(name) == "" {
			t.Skipf("%s is not set: skipping instance administration tests", name)
		}
	}
}

func instanceConfig(keep int, plan, modules string) string {
	return fmt.Sprintf(`
provider "harmoniq" {
  api_key = %[1]q
}

resource "harmoniq_instance_setting" "gc" {
  key   = "gc"
  value = jsonencode({ keepVersions = %[2]d })
}

resource "harmoniq_workspace_plan" "w" {
  workspace         = %[3]q
  plan              = %[4]q
  feature_overrides = { saml = true }
  limit_overrides   = { modules = %[5]s, members = -1 }
}

resource "harmoniq_organization_plan" "o" {
  organization = %[6]q
  plan         = "enterprise"
  expires_at   = "2099-01-31T00:00:00Z"
  base_plan    = "startup"
}
`, os.Getenv("HARMONIQ_INSTANCE_API_KEY"), keep, os.Getenv("HARMONIQ_TEST_WORKSPACE"), plan, modules,
		os.Getenv("HARMONIQ_TEST_ORG"))
}

func TestAccInstanceAdministration(t *testing.T) {
	ws := os.Getenv("HARMONIQ_TEST_WORKSPACE")
	instance := func() *client.Client {
		return client.New(os.Getenv("HARMONIQ_REGISTRY_URL"), os.Getenv("HARMONIQ_INSTANCE_API_KEY"), "acc-test")
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccInstancePreCheck(t) },
		ProtoV6ProviderFactories: testAccProviders,
		CheckDestroy: func(*terraform.State) error {
			p, err := instance().GetTenantPlan(context.Background(), "workspaces", ws)
			if err != nil {
				return err
			}
			if p.Plan != "hobby" || p.Overrides != nil {
				return fmt.Errorf("workspace plan not reset: %+v", p)
			}
			latest, err := instance().LatestInstanceSetting(context.Background(), "gc")
			if err != nil {
				return err
			}
			if latest != nil && latest.Source != "reset" {
				return fmt.Errorf("gc setting still stored (version %d)", latest.Version)
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config: instanceConfig(5, "startup", "40"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("harmoniq_instance_setting.gc", "id", "gc"),
					resource.TestCheckResourceAttrSet("harmoniq_instance_setting.gc", "version"),
					resource.TestCheckResourceAttr("harmoniq_workspace_plan.w", "plan", "startup"),
					resource.TestCheckResourceAttr("harmoniq_workspace_plan.w", "limit_overrides.modules", "40"),
					resource.TestCheckResourceAttr("harmoniq_workspace_plan.w", "limit_overrides.members", "-1"),
					resource.TestCheckResourceAttr("harmoniq_workspace_plan.w", "feature_overrides.saml", "true"),
					resource.TestCheckResourceAttr("harmoniq_organization_plan.o", "expires_at", "2099-01-31T00:00:00Z"),
					resource.TestCheckResourceAttr("harmoniq_organization_plan.o", "base_plan", "startup"),
				),
			},
			{
				Config: instanceConfig(9, "enterprise", "80"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("harmoniq_workspace_plan.w", "plan", "enterprise"),
					resource.TestCheckResourceAttr("harmoniq_workspace_plan.w", "limit_overrides.modules", "80"),
				),
			},
			// A change made elsewhere shows as a diff.
			{
				PreConfig: func() {
					_ = instance().PutInstanceSetting(context.Background(), "gc", []byte(`{"keepVersions":2}`))
				},
				Config:             instanceConfig(9, "enterprise", "80"),
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
			{Config: instanceConfig(9, "enterprise", "80")},
			{ResourceName: "harmoniq_workspace_plan.w", ImportState: true, ImportStateId: ws, ImportStateVerify: true},
			// The API spells the time with milliseconds; the configured spelling is kept.
			{ResourceName: "harmoniq_organization_plan.o", ImportState: true, ImportStateId: os.Getenv("HARMONIQ_TEST_ORG"), ImportStateVerify: true, ImportStateVerifyIgnore: []string{"expires_at"}},
		},
	})
}
