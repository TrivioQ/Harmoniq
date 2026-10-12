// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"time"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/mapvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
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

var (
	plans        = []string{"hobby", "startup", "enterprise"}
	planFeatures = []string{"byob", "approvals", "saml", "scim"}
	planQuotas   = []string{
		"workspaces", "members", "modules", "environmentsPerHostApp", "storageGb", "deploysPerMonth", "webhooks",
	}
)

// unlimited stands for "no limit" in limit_overrides (the API's null).
const unlimited = -1

var (
	_ resource.Resource                = &tenantPlanResource{}
	_ resource.ResourceWithImportState = &tenantPlanResource{}
)

// NewWorkspacePlanResource returns harmoniq_workspace_plan.
func NewWorkspacePlanResource() resource.Resource {
	return &tenantPlanResource{scope: "workspaces", attribute: "workspace", noun: "workspace",
		newModel: func() planModel { return &workspacePlanModel{} }}
}

// NewOrganizationPlanResource returns harmoniq_organization_plan.
func NewOrganizationPlanResource() resource.Resource {
	return &tenantPlanResource{scope: "orgs", attribute: "organization", noun: "organization",
		newModel: func() planModel { return &organizationPlanModel{} }}
}

// tenantPlanResource is PLN-01/06 for a workspace or an organization.
type tenantPlanResource struct {
	client *client.Client
	// scope is the API path segment; attribute names the tenant's slug attribute.
	scope, attribute, noun string
	newModel               func() planModel
}

// planModel is a tenant's model: the shared fields and the slug attribute named for it.
type planModel interface {
	common() *tenantPlanModel
	slug() string
}

type workspacePlanModel struct {
	Workspace types.String `tfsdk:"workspace"`
	tenantPlanModel
}

func (m *workspacePlanModel) common() *tenantPlanModel { return &m.tenantPlanModel }
func (m *workspacePlanModel) slug() string             { return m.Workspace.ValueString() }

type organizationPlanModel struct {
	Organization types.String `tfsdk:"organization"`
	tenantPlanModel
}

func (m *organizationPlanModel) common() *tenantPlanModel { return &m.tenantPlanModel }
func (m *organizationPlanModel) slug() string             { return m.Organization.ValueString() }

type tenantPlanModel struct {
	ID               types.String `tfsdk:"id"`
	Plan             types.String `tfsdk:"plan"`
	ExpiresAt        types.String `tfsdk:"expires_at"`
	BasePlan         types.String `tfsdk:"base_plan"`
	FeatureOverrides types.Map    `tfsdk:"feature_overrides"`
	LimitOverrides   types.Map    `tfsdk:"limit_overrides"`
}

func (r *tenantPlanResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + r.attribute + "_plan"
}

func (r *tenantPlanResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The plan of a " + r.noun + ", with an optional trial and per-tenant overrides " +
			"(PLN-01, PLN-06). Needs an instance API key (`hq_inst_…`, scope `instance:admin`). " +
			"Destroying it puts the " + r.noun + " back on `hobby` without overrides.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The " + r.noun + " slug.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			r.attribute: schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "The " + r.noun + " slug.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"plan": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "`hobby`, `startup` or `enterprise`.",
				Validators:          []validator.String{stringvalidator.OneOf(plans...)},
			},
			"expires_at": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Makes `plan` a trial ending at this time (RFC 3339); the " + r.noun +
					" then falls back to `base_plan`.",
				Validators: []validator.String{rfc3339Validator{}},
			},
			"base_plan": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "With `expires_at`: the plan after the trial (default: the plan before " +
					"the trial).",
				Validators: []validator.String{stringvalidator.OneOf(plans...)},
			},
			"feature_overrides": schema.MapAttribute{
				ElementType:         types.BoolType,
				Optional:            true,
				MarkdownDescription: "Features turned on or off whatever the plan: `byob`, `approvals`, `saml`, `scim`.",
				Validators: []validator.Map{
					mapvalidator.KeysAre(stringvalidator.OneOf(planFeatures...)),
				},
			},
			"limit_overrides": schema.MapAttribute{
				ElementType: types.Int64Type,
				Optional:    true,
				MarkdownDescription: "Quotas that differ from the plan's, `-1` for unlimited: `workspaces`, " +
					"`members`, `modules`, `environmentsPerHostApp`, `storageGb`, `deploysPerMonth`, `webhooks`.",
				Validators: []validator.Map{
					mapvalidator.KeysAre(stringvalidator.OneOf(planQuotas...)),
					mapvalidator.ValueInt64sAre(int64validator.AtLeast(unlimited)),
				},
			},
		},
	}
}

func (r *tenantPlanResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *tenantPlanResource) input(ctx context.Context, m *tenantPlanModel, diags *diag.Diagnostics) client.SetPlanInput {
	in := client.SetPlanInput{Plan: m.Plan.ValueString()}
	if !m.ExpiresAt.IsNull() && !m.ExpiresAt.IsUnknown() {
		v := m.ExpiresAt.ValueString()
		in.ExpiresAt = &v
		if !m.BasePlan.IsNull() && !m.BasePlan.IsUnknown() {
			b := m.BasePlan.ValueString()
			in.BasePlan = &b
		}
	}
	overrides := client.PlanOverrides{}
	if !m.FeatureOverrides.IsNull() && !m.FeatureOverrides.IsUnknown() {
		diags.Append(m.FeatureOverrides.ElementsAs(ctx, &overrides.Features, false)...)
	}
	if !m.LimitOverrides.IsNull() && !m.LimitOverrides.IsUnknown() {
		limits := map[string]int64{}
		diags.Append(m.LimitOverrides.ElementsAs(ctx, &limits, false)...)
		overrides.Limits = map[string]*int64{}
		for k, v := range limits {
			if v == unlimited {
				overrides.Limits[k] = nil
			} else {
				n := v
				overrides.Limits[k] = &n
			}
		}
	}
	if len(overrides.Features) > 0 || len(overrides.Limits) > 0 {
		in.Overrides = &overrides
	}
	return in
}

// apply copies the API's plan into m, keeping the configured spelling of an equal time.
func (r *tenantPlanResource) apply(p *client.TenantPlan, m *tenantPlanModel) {
	m.ID = types.StringValue(p.Slug)
	m.Plan = types.StringValue(p.Plan)
	if p.ExpiresAt == nil {
		m.ExpiresAt = types.StringNull()
	} else if !sameTime(m.ExpiresAt, *p.ExpiresAt) {
		m.ExpiresAt = types.StringValue(*p.ExpiresAt)
	}
	m.BasePlan = optionalString(p.BasePlan)
	m.FeatureOverrides = types.MapNull(types.BoolType)
	m.LimitOverrides = types.MapNull(types.Int64Type)
	if p.Overrides == nil {
		return
	}
	if len(p.Overrides.Features) > 0 {
		elems := map[string]attr.Value{}
		for k, v := range p.Overrides.Features {
			elems[k] = types.BoolValue(v)
		}
		m.FeatureOverrides = types.MapValueMust(types.BoolType, elems)
	}
	if len(p.Overrides.Limits) > 0 {
		elems := map[string]attr.Value{}
		for k, v := range p.Overrides.Limits {
			if v == nil {
				elems[k] = types.Int64Value(unlimited)
			} else {
				elems[k] = types.Int64Value(*v)
			}
		}
		m.LimitOverrides = types.MapValueMust(types.Int64Type, elems)
	}
}

func sameTime(configured types.String, api string) bool {
	if configured.IsNull() || configured.IsUnknown() {
		return false
	}
	a, err1 := time.Parse(time.RFC3339, configured.ValueString())
	b, err2 := time.Parse(time.RFC3339, api)
	return err1 == nil && err2 == nil && a.Equal(b)
}

func (r *tenantPlanResource) save(ctx context.Context, slug string, m *tenantPlanModel, diags *diag.Diagnostics) {
	if err := r.client.SetTenantPlan(ctx, r.scope, slug, r.input(ctx, m, diags)); err != nil {
		diags.AddError(apiErrorDetail("setting the "+r.noun+" plan", err))
		return
	}
	p, err := r.client.GetTenantPlan(ctx, r.scope, slug)
	if err != nil {
		diags.AddError(apiErrorDetail("reading the "+r.noun+" plan", err))
		return
	}
	r.apply(p, m)
}

func (r *tenantPlanResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	m := r.newModel()
	resp.Diagnostics.Append(req.Plan.Get(ctx, m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.save(ctx, m.slug(), m.common(), &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, m)...)
	}
}

func (r *tenantPlanResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	m := r.newModel()
	resp.Diagnostics.Append(req.State.Get(ctx, m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	p, err := r.client.GetTenantPlan(ctx, r.scope, m.slug())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("reading the "+r.noun+" plan", err))
		return
	}
	r.apply(p, m.common())
	resp.Diagnostics.Append(resp.State.Set(ctx, m)...)
}

func (r *tenantPlanResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	m := r.newModel()
	resp.Diagnostics.Append(req.Plan.Get(ctx, m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.save(ctx, m.slug(), m.common(), &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, m)...)
	}
}

func (r *tenantPlanResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	m := r.newModel()
	resp.Diagnostics.Append(req.State.Get(ctx, m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.SetTenantPlan(ctx, r.scope, m.slug(), client.SetPlanInput{Plan: "hobby"})
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("resetting the "+r.noun+" plan", err))
	}
}

// ImportState takes the tenant's slug.
func (r *tenantPlanResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root(r.attribute), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

// rfc3339Validator accepts times like 2027-01-31T00:00:00Z.
type rfc3339Validator struct{}

func (rfc3339Validator) Description(context.Context) string { return "an RFC 3339 time" }
func (v rfc3339Validator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}
func (rfc3339Validator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	if _, err := time.Parse(time.RFC3339, req.ConfigValue.ValueString()); err != nil {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid time", "Expected an RFC 3339 time such as 2027-01-31T00:00:00Z.")
	}
}
