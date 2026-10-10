// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

var (
	_ resource.Resource                = &hostAppResource{}
	_ resource.ResourceWithImportState = &hostAppResource{}
)

// NewHostAppResource returns harmoniq_host_app.
func NewHostAppResource() resource.Resource { return &hostAppResource{} }

type hostAppResource struct{ client *client.Client }

type hostAppModel struct {
	ID                 types.String `tfsdk:"id"`
	Workspace          types.String `tfsdk:"workspace"`
	Slug               types.String `tfsdk:"slug"`
	Name               types.String `tfsdk:"name"`
	Description        types.String `tfsdk:"description"`
	PreviewURLTemplate types.String `tfsdk:"preview_url_template"`
	SharedDependencies types.Map    `tfsdk:"shared_dependencies"`
	StrictExposes      types.Bool   `tfsdk:"strict_exposes"`
	IsDefault          types.Bool   `tfsdk:"is_default"`
}

func (r *hostAppResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_host_app"
}

func (r *hostAppResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A host app: the application that loads remote modules. Its environments are " +
			"`harmoniq_environment` resources. Deleting it is refused while any of its environments " +
			"serves module versions, and for the workspace's default host app while others remain.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "`workspace/slug`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"workspace": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Workspace slug.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"slug": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Host app slug; part of manifest URLs.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name":        schema.StringAttribute{Required: true, MarkdownDescription: "Display name."},
			"description": schema.StringAttribute{Optional: true, MarkdownDescription: "Description."},
			"preview_url_template": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Preview link for environments, containing `{environment}`, e.g. `https://staging.acme.dev/?harmoniq-env={environment}`.",
			},
			"shared_dependencies": schema.MapAttribute{
				ElementType:         types.StringType,
				Optional:            true,
				MarkdownDescription: "Packages the host shares with every module, as semver ranges (`{ react = \"^19.0.0\" }`). Deploys with conflicting ranges are refused.",
			},
			"strict_exposes": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "Refuse deploys that drop an exposed module the active version had.",
			},
			"is_default": schema.BoolAttribute{
				Computed:            true,
				MarkdownDescription: "Whether this is the workspace's default host app (the first one created).",
				PlanModifiers:       []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *hostAppResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *hostAppResource) patchBody(ctx context.Context, m hostAppModel, diags *diag.Diagnostics) map[string]any {
	body := map[string]any{
		"name":               m.Name.ValueString(),
		"description":        nullableBody(m.Description),
		"previewUrlTemplate": nullableBody(m.PreviewURLTemplate),
		"sharedDependencies": nil,
	}
	if !m.SharedDependencies.IsNull() && !m.SharedDependencies.IsUnknown() {
		deps := map[string]string{}
		diags.Append(m.SharedDependencies.ElementsAs(ctx, &deps, false)...)
		body["sharedDependencies"] = deps
	}
	if !m.StrictExposes.IsNull() && !m.StrictExposes.IsUnknown() {
		body["strictExposes"] = m.StrictExposes.ValueBool()
	}
	return body
}

func (r *hostAppResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan hostAppModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws, slug := plan.Workspace.ValueString(), plan.Slug.ValueString()
	create := map[string]any{"slug": slug, "name": plan.Name.ValueString()}
	if err := r.client.CreateHostApp(ctx, ws, create); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("creating host app", err))
		return
	}
	plan.ID = types.StringValue(ws + "/" + slug)
	body := r.patchBody(ctx, plan, &resp.Diagnostics)
	if err := r.client.UpdateHostApp(ctx, ws, slug, body); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("configuring host app", err))
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *hostAppResource) read(ctx context.Context, m *hostAppModel, diags *diag.Diagnostics) bool {
	h, err := r.client.FindHostApp(ctx, m.Workspace.ValueString(), m.Slug.ValueString())
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading host app", err))
		return true
	}
	m.Name = types.StringValue(h.Name)
	m.Description = optionalString(h.Description)
	m.PreviewURLTemplate = optionalString(h.PreviewURLTemplate)
	m.SharedDependencies = stringMap(h.SharedDependencies)
	m.StrictExposes = types.BoolValue(h.StrictExposes)
	m.IsDefault = types.BoolValue(h.IsDefault)
	return true
}

func (r *hostAppResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state hostAppModel
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

func (r *hostAppResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan hostAppModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := r.patchBody(ctx, plan, &resp.Diagnostics)
	if err := r.client.UpdateHostApp(ctx, plan.Workspace.ValueString(), plan.Slug.ValueString(), body); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("updating host app", err))
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *hostAppResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state hostAppModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteHostApp(ctx, state.Workspace.ValueString(), state.Slug.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("deleting host app", err))
	}
}

// ImportState takes "workspace/host-app".
func (r *hostAppResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := splitID(req.ID, 2, "workspace/host-app", &resp.Diagnostics)
	if parts == nil {
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workspace"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("slug"), parts[1])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
