// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

var (
	_ resource.Resource                = &environmentResource{}
	_ resource.ResourceWithImportState = &environmentResource{}
)

// NewEnvironmentResource returns harmoniq_environment.
func NewEnvironmentResource() resource.Resource { return &environmentResource{} }

type environmentResource struct{ client *client.Client }

type environmentModel struct {
	ID             types.String         `tfsdk:"id"`
	Workspace      types.String         `tfsdk:"workspace"`
	HostApp        types.String         `tfsdk:"host_app"`
	Slug           types.String         `tfsdk:"slug"`
	Name           types.String         `tfsdk:"name"`
	IsDefault      types.Bool           `tfsdk:"is_default"`
	ApprovalPolicy *approvalPolicyBlock `tfsdk:"approval_policy"`
}

func (r *environmentResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_environment"
}

func (r *environmentResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An environment of a host app (e.g. `staging`, `production`), with an optional " +
			"approval policy. Use either the `approval_policy` attribute here or a `harmoniq_approval_policy` " +
			"resource for an environment, not both. Deleting is refused while it serves module versions.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "`workspace/host-app/slug`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"workspace": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Workspace slug.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"host_app": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Host app slug.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"slug": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Environment slug; part of manifest URLs.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{Required: true, MarkdownDescription: "Display name."},
			"is_default": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "Make this the host app's default environment (the others stop being it). " +
					"Can't be set to `false`: make another environment the default instead.",
			},
			"approval_policy": approvalPolicyAttribute(),
		},
	}
}

func (r *environmentResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *environmentResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan environmentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws, host, slug := plan.Workspace.ValueString(), plan.HostApp.ValueString(), plan.Slug.ValueString()
	if err := r.client.CreateEnvironment(ctx, ws, host, slug, plan.Name.ValueString()); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("creating environment", err))
		return
	}
	plan.ID = types.StringValue(ws + "/" + host + "/" + slug)
	r.apply(ctx, plan, nil, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

// apply sends what differs from the current state (nil: just created).
func (r *environmentResource) apply(ctx context.Context, plan environmentModel, state *environmentModel, diags *diag.Diagnostics) {
	ws, host, slug := plan.Workspace.ValueString(), plan.HostApp.ValueString(), plan.Slug.ValueString()
	body := map[string]any{"name": plan.Name.ValueString()}
	wantDefault := !plan.IsDefault.IsNull() && !plan.IsDefault.IsUnknown() && plan.IsDefault.ValueBool()
	if wantDefault {
		body["isDefault"] = true
	} else if state != nil && !plan.IsDefault.IsNull() && !plan.IsDefault.IsUnknown() &&
		!plan.IsDefault.ValueBool() && state.IsDefault.ValueBool() {
		diags.AddAttributeError(path.Root("is_default"), "Can't unset the default environment",
			"Set is_default = true on another environment of the host app instead.")
		return
	}
	if err := r.client.UpdateEnvironment(ctx, ws, host, slug, body); err != nil {
		diags.AddError(apiErrorDetail("updating environment", err))
		return
	}
	switch {
	case plan.ApprovalPolicy != nil:
		if err := r.client.PutApprovalPolicy(ctx, ws, host, slug, plan.ApprovalPolicy.input(ctx, diags)); err != nil {
			diags.AddError(apiErrorDetail("setting approval policy", err))
		}
	case state != nil && state.ApprovalPolicy != nil:
		if err := r.client.DeleteApprovalPolicy(ctx, ws, host, slug); err != nil && !client.IsNotFound(err) {
			diags.AddError(apiErrorDetail("removing approval policy", err))
		}
	}
}

func (r *environmentResource) read(ctx context.Context, m *environmentModel, diags *diag.Diagnostics) bool {
	ws, host, slug := m.Workspace.ValueString(), m.HostApp.ValueString(), m.Slug.ValueString()
	env, err := r.client.FindEnvironment(ctx, ws, host, slug)
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading environment", err))
		return true
	}
	m.Name = types.StringValue(env.Name)
	m.IsDefault = types.BoolValue(env.IsDefault)
	// Only tracked when managed here; a harmoniq_approval_policy resource may own it.
	if m.ApprovalPolicy != nil {
		policy, err := r.client.GetApprovalPolicy(ctx, ws, host, slug)
		switch {
		case client.IsNotFound(err):
			m.ApprovalPolicy = nil
		case err != nil:
			diags.AddError(apiErrorDetail("reading approval policy", err))
		default:
			m.ApprovalPolicy = policyBlockFrom(policy)
		}
	}
	return true
}

func (r *environmentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state environmentModel
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

func (r *environmentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state environmentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.apply(ctx, plan, &state, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *environmentResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state environmentModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteEnvironment(ctx, state.Workspace.ValueString(), state.HostApp.ValueString(), state.Slug.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("deleting environment", err))
	}
}

// ImportState takes "workspace/host-app/environment". The approval policy is imported
// only if the configuration declares it (run plan after importing).
func (r *environmentResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := splitID(req.ID, 3, "workspace/host-app/environment", &resp.Diagnostics)
	if parts == nil {
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workspace"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("host_app"), parts[1])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("slug"), parts[2])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
