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
	_ resource.Resource                = &remoteModuleResource{}
	_ resource.ResourceWithImportState = &remoteModuleResource{}
)

// NewRemoteModuleResource returns harmoniq_remote_module.
func NewRemoteModuleResource() resource.Resource { return &remoteModuleResource{} }

type remoteModuleResource struct{ client *client.Client }

type remoteModuleModel struct {
	ID          types.String `tfsdk:"id"`
	Workspace   types.String `tfsdk:"workspace"`
	HostApp     types.String `tfsdk:"host_app"`
	Slug        types.String `tfsdk:"slug"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Specifier   types.String `tfsdk:"specifier"`
}

func (r *remoteModuleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_remote_module"
}

func (r *remoteModuleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A remote module (micro frontend) of a host app. Versions are deployed by CI, " +
			"not Terraform. Deleting is refused while the module has an active or canary version.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Module id (use it for API key `module_ids` and alert rules).",
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
				MarkdownDescription: "Module slug; its name in manifests.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name":        schema.StringAttribute{Required: true, MarkdownDescription: "Display name."},
			"description": schema.StringAttribute{Optional: true, MarkdownDescription: "Description."},
			"specifier": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Import-map specifier, e.g. `@acme/checkout` (defaults to the slug).",
			},
		},
	}
}

func (r *remoteModuleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *remoteModuleResource) patchBody(m remoteModuleModel) map[string]any {
	return map[string]any{
		"name":        m.Name.ValueString(),
		"description": nullableBody(m.Description),
		"specifier":   nullableBody(m.Specifier),
	}
}

func (r *remoteModuleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan remoteModuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := plan.Workspace.ValueString()
	created, err := r.client.CreateModule(ctx, ws, map[string]any{
		"hostApp": plan.HostApp.ValueString(),
		"slug":    plan.Slug.ValueString(),
		"name":    plan.Name.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("creating module", err))
		return
	}
	plan.ID = types.StringValue(created.ID)
	if err := r.client.UpdateModule(ctx, ws, created.ID, r.patchBody(plan)); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("configuring module", err))
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *remoteModuleResource) read(ctx context.Context, m *remoteModuleModel, diags *diag.Diagnostics) bool {
	mod, err := r.client.GetModule(ctx, m.Workspace.ValueString(), m.ID.ValueString())
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading module", err))
		return true
	}
	m.HostApp = types.StringValue(mod.HostApp.Slug)
	m.Slug = types.StringValue(mod.Slug)
	m.Name = types.StringValue(mod.Name)
	m.Description = optionalString(mod.Description)
	m.Specifier = optionalString(mod.Specifier)
	return true
}

func (r *remoteModuleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state remoteModuleModel
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

func (r *remoteModuleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan remoteModuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.UpdateModule(ctx, plan.Workspace.ValueString(), plan.ID.ValueString(), r.patchBody(plan)); err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("updating module", err))
		return
	}
	r.read(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *remoteModuleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state remoteModuleModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteModule(ctx, state.Workspace.ValueString(), state.ID.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("deleting module", err))
	}
}

// ImportState takes "workspace/module-id" (or "workspace/module-slug").
func (r *remoteModuleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := splitID(req.ID, 2, "workspace/module-id", &resp.Diagnostics)
	if parts == nil {
		return
	}
	mod, err := r.client.GetModule(ctx, parts[0], parts[1])
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("importing module", err))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workspace"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), mod.ID)...)
}
