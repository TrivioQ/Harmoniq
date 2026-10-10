// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

var (
	_ resource.Resource                = &apiKeyResource{}
	_ resource.ResourceWithImportState = &apiKeyResource{}
)

// NewAPIKeyResource returns harmoniq_api_key.
func NewAPIKeyResource() resource.Resource { return &apiKeyResource{} }

type apiKeyResource struct{ client *client.Client }

type apiKeyModel struct {
	ID        types.String `tfsdk:"id"`
	Workspace types.String `tfsdk:"workspace"`
	Name      types.String `tfsdk:"name"`
	Scopes    types.Set    `tfsdk:"scopes"`
	ModuleIDs types.Set    `tfsdk:"module_ids"`
	ExpiresAt types.String `tfsdk:"expires_at"`
	Key       types.String `tfsdk:"key"`
	Prefix    types.String `tfsdk:"prefix"`
}

func (r *apiKeyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_api_key"
}

func (r *apiKeyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		MarkdownDescription: "A workspace API key, e.g. for CI. Issued by the provider's organization key " +
			"(workspace keys can't issue keys). Changing anything issues a new key; destroying revokes it. " +
			"The secret is only known when the key is created: `key` is empty after an import.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Key id.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"workspace": schema.StringAttribute{Required: true, MarkdownDescription: "Workspace slug.", PlanModifiers: replace},
			"name":      schema.StringAttribute{Required: true, MarkdownDescription: "Name, e.g. `github-actions`.", PlanModifiers: replace},
			"scopes": schema.SetAttribute{
				ElementType: types.StringType,
				Optional:    true,
				Computed:    true,
				Default: setdefault.StaticValue(types.SetValueMust(types.StringType,
					[]attr.Value{types.StringValue("deploy:write")})),
				MarkdownDescription: "`manifest:read`, `deploy:write` (default) or `admin`.",
				PlanModifiers:       []planmodifier.Set{setplanmodifier.RequiresReplace()},
				Validators: []validator.Set{
					setvalidator.SizeAtLeast(1),
					setvalidator.ValueStringsAre(stringvalidator.OneOf("manifest:read", "deploy:write", "admin")),
				},
			},
			"module_ids": schema.SetAttribute{
				ElementType:         types.StringType,
				Optional:            true,
				MarkdownDescription: "Restrict the key to these modules (`harmoniq_remote_module.x.id`). All modules when unset.",
				PlanModifiers:       []planmodifier.Set{setplanmodifier.RequiresReplace()},
			},
			"expires_at": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Expiry as an RFC 3339 time, e.g. `2027-01-01T00:00:00Z`.",
				PlanModifiers:       replace,
			},
			"key": schema.StringAttribute{
				Computed:            true,
				Sensitive:           true,
				MarkdownDescription: "The secret (`hq_…`), known only at creation. Store it in your CI secrets.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"prefix": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Displayed prefix of the key.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *apiKeyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *apiKeyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan apiKeyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"name":      plan.Name.ValueString(),
		"scopes":    setStrings(ctx, plan.Scopes, &resp.Diagnostics),
		"moduleIds": setStrings(ctx, plan.ModuleIDs, &resp.Diagnostics),
	}
	if !plan.ExpiresAt.IsNull() && !plan.ExpiresAt.IsUnknown() {
		body["expiresAt"] = plan.ExpiresAt.ValueString()
	}
	created, err := r.client.CreateAPIKey(ctx, plan.Workspace.ValueString(), body)
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("creating API key", err))
		return
	}
	plan.ID = types.StringValue(created.ID)
	plan.Key = types.StringValue(created.Key)
	plan.Prefix = types.StringValue(created.Prefix)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *apiKeyResource) read(ctx context.Context, m *apiKeyModel, diags *diag.Diagnostics) bool {
	k, err := r.client.GetAPIKey(ctx, m.Workspace.ValueString(), m.ID.ValueString())
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading API key", err))
		return true
	}
	// Revoked out of band: gone, Terraform will issue a new one.
	if k.RevokedAt != nil {
		return false
	}
	m.Name = types.StringValue(k.Name)
	m.Scopes = stringSet(k.Scopes)
	if len(k.ModuleIDs) > 0 || !m.ModuleIDs.IsNull() {
		m.ModuleIDs = stringSet(k.ModuleIDs)
	}
	m.Prefix = types.StringValue(k.Prefix)
	if m.Key.IsNull() || m.Key.IsUnknown() {
		m.Key = types.StringValue("")
	}
	return true
}

func (r *apiKeyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state apiKeyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if !r.read(ctx, &state, &resp.Diagnostics) {
		resp.State.RemoveResource(ctx)
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

// Update never runs: every configurable attribute forces a new key.
func (r *apiKeyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan apiKeyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *apiKeyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state apiKeyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.RevokeAPIKey(ctx, state.Workspace.ValueString(), state.ID.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("revoking API key", err))
	}
}

// ImportState takes "workspace/key-id".
func (r *apiKeyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := splitID(req.ID, 2, "workspace/key-id", &resp.Diagnostics)
	if parts == nil {
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workspace"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[1])...)
}
