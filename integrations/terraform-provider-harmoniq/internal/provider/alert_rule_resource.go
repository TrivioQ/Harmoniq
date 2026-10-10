// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

var (
	_ resource.Resource                = &alertRuleResource{}
	_ resource.ResourceWithImportState = &alertRuleResource{}
)

// NewAlertRuleResource returns harmoniq_alert_rule.
func NewAlertRuleResource() resource.Resource { return &alertRuleResource{} }

type alertRuleResource struct{ client *client.Client }

type alertRuleModel struct {
	ID              types.String  `tfsdk:"id"`
	Workspace       types.String  `tfsdk:"workspace"`
	Name            types.String  `tfsdk:"name"`
	Condition       types.String  `tfsdk:"condition"`
	Threshold       types.Float64 `tfsdk:"threshold"`
	Action          types.String  `tfsdk:"action"`
	ModuleID        types.String  `tfsdk:"module_id"`
	Environment     types.String  `tfsdk:"environment"`
	WindowMinutes   types.Int64   `tfsdk:"window_minutes"`
	MinSamples      types.Int64   `tfsdk:"min_samples"`
	CooldownMinutes types.Int64   `tfsdk:"cooldown_minutes"`
	Enabled         types.Bool    `tfsdk:"enabled"`
}

func (r *alertRuleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_alert_rule"
}

func (r *alertRuleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		MarkdownDescription: "An alert rule on module health (or webhook failures). `auto_rollback` aborts " +
			"the module's canary, or rolls back to the previous version, when the rule triggers. " +
			"Rates are fractions between 0 and 1; times are milliseconds.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Rule id.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"workspace": schema.StringAttribute{Required: true, MarkdownDescription: "Workspace slug.", PlanModifiers: replace},
			"name":      schema.StringAttribute{Required: true, MarkdownDescription: "Name, unique in the workspace."},
			"condition": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "`canary_error_rate`, `canary_error_rate_delta`, `canary_load_p95ms`, " +
					"`load_success_rate`, `load_p95ms` (module conditions) or `webhook_failure_rate`.",
				PlanModifiers: replace,
				Validators: []validator.String{stringvalidator.OneOf("canary_error_rate", "canary_error_rate_delta",
					"canary_load_p95ms", "load_success_rate", "load_p95ms", "webhook_failure_rate")},
			},
			"threshold": schema.Float64Attribute{Required: true, MarkdownDescription: "Trigger value."},
			"action": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "`webhook` (send `alert.triggered` / `alert.resolved`) or `auto_rollback`.",
				Validators:          []validator.String{stringvalidator.OneOf("webhook", "auto_rollback")},
			},
			"module_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Module id (`harmoniq_remote_module.x.id`); required for module conditions.",
				PlanModifiers:       replace,
			},
			"environment": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Environment slug in the module's host app; required for module conditions.",
				PlanModifiers:       replace,
			},
			"window_minutes": schema.Int64Attribute{
				Optional: true, Computed: true, Default: int64default.StaticInt64(5),
				MarkdownDescription: "Evaluation window in minutes (1–60, default 5).",
				Validators:          []validator.Int64{int64validator.Between(1, 60)},
			},
			"min_samples": schema.Int64Attribute{
				Optional: true, Computed: true, Default: int64default.StaticInt64(20),
				MarkdownDescription: "Samples needed before the rule can trigger (default 20).",
				Validators:          []validator.Int64{int64validator.Between(1, 100000)},
			},
			"cooldown_minutes": schema.Int64Attribute{
				Optional: true, Computed: true, Default: int64default.StaticInt64(15),
				MarkdownDescription: "Minutes before the rule can trigger again (0–1440, default 15).",
				Validators:          []validator.Int64{int64validator.Between(0, 1440)},
			},
			"enabled": schema.BoolAttribute{
				Optional: true, Computed: true, Default: booldefault.StaticBool(true),
				MarkdownDescription: "Whether the rule is evaluated (default `true`).",
			},
		},
	}
}

func (r *alertRuleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *alertRuleResource) settings(m alertRuleModel) map[string]any {
	return map[string]any{
		"name":            m.Name.ValueString(),
		"threshold":       m.Threshold.ValueFloat64(),
		"action":          m.Action.ValueString(),
		"windowMinutes":   m.WindowMinutes.ValueInt64(),
		"minSamples":      m.MinSamples.ValueInt64(),
		"cooldownMinutes": m.CooldownMinutes.ValueInt64(),
		"enabled":         m.Enabled.ValueBool(),
	}
}

func (r *alertRuleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan alertRuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := r.settings(plan)
	body["condition"] = plan.Condition.ValueString()
	if !plan.ModuleID.IsNull() {
		body["module"] = plan.ModuleID.ValueString()
	}
	if !plan.Environment.IsNull() {
		body["environment"] = plan.Environment.ValueString()
	}
	created, err := r.client.CreateAlertRule(ctx, plan.Workspace.ValueString(), body)
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("creating alert rule", err))
		return
	}
	plan.ID = types.StringValue(created.ID)
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *alertRuleResource) read(ctx context.Context, m *alertRuleModel, diags *diag.Diagnostics) bool {
	rule, err := r.client.GetAlertRule(ctx, m.Workspace.ValueString(), m.ID.ValueString())
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading alert rule", err))
		return true
	}
	m.Name = types.StringValue(rule.Name)
	m.Condition = types.StringValue(rule.Condition)
	m.Threshold = types.Float64Value(rule.Threshold)
	m.Action = types.StringValue(rule.Action)
	m.ModuleID = types.StringNull()
	if rule.Module != nil {
		m.ModuleID = types.StringValue(rule.Module.ID)
	}
	m.Environment = optionalString(rule.Environment)
	m.WindowMinutes = types.Int64Value(rule.WindowMinutes)
	m.MinSamples = types.Int64Value(rule.MinSamples)
	m.CooldownMinutes = types.Int64Value(rule.CooldownMinutes)
	m.Enabled = types.BoolValue(rule.Enabled)
	return true
}

func (r *alertRuleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state alertRuleModel
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

func (r *alertRuleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan alertRuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.UpdateAlertRule(ctx, plan.Workspace.ValueString(), plan.ID.ValueString(), r.settings(plan)); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("updating alert rule", err))
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *alertRuleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state alertRuleModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteAlertRule(ctx, state.Workspace.ValueString(), state.ID.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("deleting alert rule", err))
	}
}

// ImportState takes "workspace/rule-id".
func (r *alertRuleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := splitID(req.ID, 2, "workspace/rule-id", &resp.Diagnostics)
	if parts == nil {
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workspace"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[1])...)
}
