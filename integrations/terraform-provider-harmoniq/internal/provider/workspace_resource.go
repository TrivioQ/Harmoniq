// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

var (
	_ resource.Resource                = &workspaceResource{}
	_ resource.ResourceWithImportState = &workspaceResource{}
)

// NewWorkspaceResource returns harmoniq_workspace.
func NewWorkspaceResource() resource.Resource { return &workspaceResource{} }

type workspaceResource struct{ client *client.Client }

type workspaceModel struct {
	ID                         types.String `tfsdk:"id"`
	Organization               types.String `tfsdk:"organization"`
	Slug                       types.String `tfsdk:"slug"`
	Name                       types.String `tfsdk:"name"`
	RetentionDays              types.Int64  `tfsdk:"retention_days"`
	AllowEphemeralEnvironments types.Bool   `tfsdk:"allow_ephemeral_environments"`
}

func (r *workspaceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace"
}

func (r *workspaceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A workspace in an organization. Needs an organization API key with the `admin` scope. " +
			"New workspaces come with a `default` host app (environments `staging` and `production`); " +
			"import it as `harmoniq_host_app` to manage it, or add your own host apps. " +
			"Destroying the workspace deletes everything in it.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The workspace slug.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"organization": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Slug of the organization that owns the workspace.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"slug": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Workspace slug: lowercase letters, digits and hyphens. Appears in manifest URLs.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name.",
			},
			"retention_days": schema.Int64Attribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "Days of version history and snapshots kept (1–3650).",
			},
			"allow_ephemeral_environments": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "Whether deploys may create preview environments (e.g. `pr-123`).",
			},
		},
	}
}

func (r *workspaceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *workspaceResource) settings(plan workspaceModel) map[string]any {
	body := map[string]any{"name": plan.Name.ValueString()}
	if !plan.RetentionDays.IsNull() && !plan.RetentionDays.IsUnknown() {
		body["retentionDays"] = plan.RetentionDays.ValueInt64()
	}
	if !plan.AllowEphemeralEnvironments.IsNull() && !plan.AllowEphemeralEnvironments.IsUnknown() {
		body["allowEphemeralEnvironments"] = plan.AllowEphemeralEnvironments.ValueBool()
	}
	return body
}

func (r *workspaceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan workspaceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	slug := plan.Slug.ValueString()
	if err := r.client.CreateWorkspace(ctx, plan.Organization.ValueString(), slug, plan.Name.ValueString()); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("creating workspace", err))
		return
	}
	if err := r.client.UpdateWorkspace(ctx, slug, r.settings(plan)); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("configuring workspace", err))
		return
	}
	plan.ID = types.StringValue(slug)
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *workspaceResource) read(ctx context.Context, m *workspaceModel, diags interface{ AddError(string, string) }) bool {
	w, err := r.client.GetWorkspace(ctx, m.ID.ValueString())
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading workspace", err))
		return true
	}
	m.Slug = types.StringValue(w.Slug)
	m.Name = types.StringValue(w.Name)
	m.RetentionDays = types.Int64Value(w.RetentionDays)
	m.AllowEphemeralEnvironments = types.BoolValue(w.AllowEphemeralEnvironments)
	return true
}

func (r *workspaceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state workspaceModel
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

func (r *workspaceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan workspaceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.UpdateWorkspace(ctx, plan.ID.ValueString(), r.settings(plan)); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("updating workspace", err))
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *workspaceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state workspaceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteWorkspace(ctx, state.Organization.ValueString(), state.ID.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("deleting workspace", err))
	}
}

// ImportState takes "organization/workspace".
func (r *workspaceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := splitID(req.ID, 2, "organization/workspace", &resp.Diagnostics)
	if parts == nil {
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("organization"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("slug"), parts[1])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), parts[1])...)
}
