// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

// Package provider implements the Harmoniq Terraform provider (IaC-01..03).
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

var _ provider.Provider = &harmoniqProvider{}

type harmoniqProvider struct {
	version string
}

type providerModel struct {
	RegistryURL types.String `tfsdk:"registry_url"`
	APIKey      types.String `tfsdk:"api_key"`
}

// New returns the provider factory for providerserver.
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &harmoniqProvider{version: version} }
}

func (p *harmoniqProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "harmoniq"
	resp.Version = p.version
}

func (p *harmoniqProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages [Harmoniq](https://github.com/TrivioQ/Harmoniq) workspaces, host apps, " +
			"environments, modules, API keys, webhooks, alert rules and approval policies.\n\n" +
			"Authenticate with an **organization API key** with the `admin` scope (Organization → API keys). " +
			"It can create and delete the organization's workspaces and issue workspace API keys. " +
			"A workspace key with the `admin` scope manages everything inside its workspace " +
			"except workspaces and API keys.",
		Attributes: map[string]schema.Attribute{
			"registry_url": schema.StringAttribute{
				MarkdownDescription: "Registry URL, e.g. `https://registry.acme.dev`. Defaults to `HARMONIQ_REGISTRY_URL`.",
				Optional:            true,
			},
			"api_key": schema.StringAttribute{
				MarkdownDescription: "API key (`hq_org_…` or `hq_…`). Defaults to `HARMONIQ_API_KEY`.",
				Optional:            true,
				Sensitive:           true,
			},
		},
	}
}

func (p *harmoniqProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if cfg.RegistryURL.IsUnknown() || cfg.APIKey.IsUnknown() {
		resp.Diagnostics.AddWarning("Provider not configured yet",
			"registry_url or api_key depends on values known only after apply.")
		return
	}

	registryURL := stringOr(cfg.RegistryURL, os.Getenv("HARMONIQ_REGISTRY_URL"))
	apiKey := stringOr(cfg.APIKey, os.Getenv("HARMONIQ_API_KEY"))
	if registryURL == "" {
		resp.Diagnostics.AddAttributeError(path.Root("registry_url"), "Missing registry URL",
			"Set registry_url in the provider block or the HARMONIQ_REGISTRY_URL environment variable.")
	}
	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(path.Root("api_key"), "Missing API key",
			"Set api_key in the provider block or the HARMONIQ_API_KEY environment variable.")
	}
	if resp.Diagnostics.HasError() {
		return
	}

	c := client.New(registryURL, apiKey, "terraform-provider-harmoniq/"+p.version)
	resp.ResourceData = c
	resp.DataSourceData = c
}

func (p *harmoniqProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewWorkspaceResource,
		NewHostAppResource,
		NewEnvironmentResource,
		NewRemoteModuleResource,
		NewAPIKeyResource,
		NewWebhookEndpointResource,
		NewAlertRuleResource,
		NewApprovalPolicyResource,
	}
}

func (p *harmoniqProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewWorkspaceDataSource,
		NewEnvironmentDataSource,
		NewManifestDataSource,
	}
}

func stringOr(v types.String, fallback string) string {
	if v.IsNull() || v.ValueString() == "" {
		return fallback
	}
	return v.ValueString()
}
