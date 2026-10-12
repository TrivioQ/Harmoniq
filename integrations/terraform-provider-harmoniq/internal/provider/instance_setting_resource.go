// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"encoding/json"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

// instanceSettingKeys are the settings an instance keeps in its database (INST-11..17, 34).
var instanceSettingKeys = []string{
	"storage", "email", "auth", "branding", "tenancy", "plans", "rateLimits", "gc", "bundles",
}

var (
	_ resource.Resource                = &instanceSettingResource{}
	_ resource.ResourceWithImportState = &instanceSettingResource{}
)

// NewInstanceSettingResource returns harmoniq_instance_setting.
func NewInstanceSettingResource() resource.Resource { return &instanceSettingResource{} }

type instanceSettingResource struct{ client *client.Client }

type instanceSettingModel struct {
	ID      types.String `tfsdk:"id"`
	Key     types.String `tfsdk:"key"`
	Value   types.String `tfsdk:"value"`
	Version types.Int64  `tfsdk:"version"`
}

func (r *instanceSettingResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_instance_setting"
}

func (r *instanceSettingResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An instance setting kept in the registry's database, over the environment's " +
			"defaults (INST-34). Needs an instance API key (`hq_inst_…`, scope `instance:admin`). " +
			"Destroying it resets the setting to the environment's defaults. A change made " +
			"elsewhere (the admin panel, an import) shows as a diff and the next apply restores " +
			"this value.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The setting key.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"key": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "`storage`, `email`, `auth`, `branding`, `tenancy`, `plans`, `rateLimits`, " +
					"`gc` or `bundles`.",
				Validators:    []validator.String{stringvalidator.OneOf(instanceSettingKeys...)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"value": schema.StringAttribute{
				Required:  true,
				Sensitive: true,
				MarkdownDescription: "The setting as JSON, usually `jsonencode({...})`; see the registry's " +
					"API reference for each key. Secrets (SMTP password, storage keys) are write-only.",
			},
			"version": schema.Int64Attribute{
				Computed:            true,
				MarkdownDescription: "The setting's saved version (INST-35).",
			},
		},
	}
}

func (r *instanceSettingResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *instanceSettingResource) put(ctx context.Context, m *instanceSettingModel, diags *diag.Diagnostics) {
	raw := json.RawMessage(m.Value.ValueString())
	if !json.Valid(raw) {
		diags.AddAttributeError(path.Root("value"), "Invalid JSON", "value must be a JSON object, e.g. jsonencode({...}).")
		return
	}
	key := m.Key.ValueString()
	if err := r.client.PutInstanceSetting(ctx, key, raw); err != nil {
		diags.AddError(apiErrorDetail("saving instance setting "+key, err))
		return
	}
	latest, err := r.client.LatestInstanceSetting(ctx, key)
	if err != nil || latest == nil {
		diags.AddError(apiErrorDetail("reading instance setting "+key, errOr(err, "no saved version")))
		return
	}
	m.ID = types.StringValue(key)
	m.Version = types.Int64Value(latest.Version)
}

// read reports false when the setting is no longer stored (reset elsewhere). When a newer
// version was saved outside Terraform, value takes the stored one (without secrets), so
// the plan shows the difference.
func (r *instanceSettingResource) read(ctx context.Context, m *instanceSettingModel, diags *diag.Diagnostics) bool {
	latest, err := r.client.LatestInstanceSetting(ctx, m.Key.ValueString())
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading instance setting", err))
		return true
	}
	if latest == nil || latest.Source == "reset" {
		return false
	}
	if m.Version.IsNull() || m.Version.ValueInt64() != latest.Version {
		m.Value = types.StringValue(string(latest.Value))
		m.Version = types.Int64Value(latest.Version)
	}
	m.ID = m.Key
	return true
}

func (r *instanceSettingResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan instanceSettingModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
	}
}

func (r *instanceSettingResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state instanceSettingModel
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

func (r *instanceSettingResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan instanceSettingModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
	}
}

func (r *instanceSettingResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state instanceSettingModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteInstanceSetting(ctx, state.Key.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("resetting instance setting", err))
	}
}

// ImportState takes the setting key.
func (r *instanceSettingResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("key"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
