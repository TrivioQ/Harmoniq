// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

// ─── harmoniq_workspace ─────────────────────────────────────────────────────

// NewWorkspaceDataSource returns the harmoniq_workspace data source.
func NewWorkspaceDataSource() datasource.DataSource { return &workspaceDataSource{} }

type workspaceDataSource struct{ client *client.Client }

type workspaceDataModel struct {
	Slug                       types.String       `tfsdk:"slug"`
	Name                       types.String       `tfsdk:"name"`
	RetentionDays              types.Int64        `tfsdk:"retention_days"`
	AllowEphemeralEnvironments types.Bool         `tfsdk:"allow_ephemeral_environments"`
	HostApps                   []hostAppDataModel `tfsdk:"host_apps"`
}

type hostAppDataModel struct {
	Slug         types.String `tfsdk:"slug"`
	Name         types.String `tfsdk:"name"`
	IsDefault    types.Bool   `tfsdk:"is_default"`
	Environments types.List   `tfsdk:"environments"`
}

func (d *workspaceDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace"
}

func (d *workspaceDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A workspace with its host apps and their environments.",
		Attributes: map[string]schema.Attribute{
			"slug":                         schema.StringAttribute{Required: true, MarkdownDescription: "Workspace slug."},
			"name":                         schema.StringAttribute{Computed: true, MarkdownDescription: "Display name."},
			"retention_days":               schema.Int64Attribute{Computed: true, MarkdownDescription: "History retention in days."},
			"allow_ephemeral_environments": schema.BoolAttribute{Computed: true, MarkdownDescription: "Whether deploys may create preview environments."},
			"host_apps": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Host apps, the default first.",
				NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
					"slug":         schema.StringAttribute{Computed: true, MarkdownDescription: "Host app slug."},
					"name":         schema.StringAttribute{Computed: true, MarkdownDescription: "Display name."},
					"is_default":   schema.BoolAttribute{Computed: true, MarkdownDescription: "The workspace's default host app."},
					"environments": schema.ListAttribute{Computed: true, ElementType: types.StringType, MarkdownDescription: "Environment slugs."},
				}},
			},
		},
	}
}

func (d *workspaceDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (d *workspaceDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m workspaceDataModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	w, err := d.client.GetWorkspace(ctx, m.Slug.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("reading workspace", err))
		return
	}
	m.Name = types.StringValue(w.Name)
	m.RetentionDays = types.Int64Value(w.RetentionDays)
	m.AllowEphemeralEnvironments = types.BoolValue(w.AllowEphemeralEnvironments)
	m.HostApps = make([]hostAppDataModel, 0, len(w.HostApps))
	for _, h := range w.HostApps {
		envs := make([]string, 0, len(h.Environments))
		for _, e := range h.Environments {
			envs = append(envs, e.Slug)
		}
		list, diags := types.ListValueFrom(ctx, types.StringType, envs)
		resp.Diagnostics.Append(diags...)
		m.HostApps = append(m.HostApps, hostAppDataModel{
			Slug:         types.StringValue(h.Slug),
			Name:         types.StringValue(h.Name),
			IsDefault:    types.BoolValue(h.IsDefault),
			Environments: list,
		})
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, m)...)
}

// ─── harmoniq_environment ───────────────────────────────────────────────────

// NewEnvironmentDataSource returns the harmoniq_environment data source.
func NewEnvironmentDataSource() datasource.DataSource { return &environmentDataSource{} }

type environmentDataSource struct{ client *client.Client }

type environmentDataModel struct {
	Workspace    types.String `tfsdk:"workspace"`
	HostApp      types.String `tfsdk:"host_app"`
	Slug         types.String `tfsdk:"slug"`
	Name         types.String `tfsdk:"name"`
	IsDefault    types.Bool   `tfsdk:"is_default"`
	Frozen       types.Bool   `tfsdk:"frozen"`
	FreezeReason types.String `tfsdk:"freeze_reason"`
}

func (d *environmentDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_environment"
}

func (d *environmentDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An environment of a host app, with its freeze state.",
		Attributes: map[string]schema.Attribute{
			"workspace":     schema.StringAttribute{Required: true, MarkdownDescription: "Workspace slug."},
			"host_app":      schema.StringAttribute{Required: true, MarkdownDescription: "Host app slug."},
			"slug":          schema.StringAttribute{Required: true, MarkdownDescription: "Environment slug."},
			"name":          schema.StringAttribute{Computed: true, MarkdownDescription: "Display name."},
			"is_default":    schema.BoolAttribute{Computed: true, MarkdownDescription: "The host app's default environment."},
			"frozen":        schema.BoolAttribute{Computed: true, MarkdownDescription: "Whether changes are frozen now."},
			"freeze_reason": schema.StringAttribute{Computed: true, MarkdownDescription: "Why, when frozen."},
		},
	}
}

func (d *environmentDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (d *environmentDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m environmentDataModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	env, err := d.client.FindEnvironment(ctx, m.Workspace.ValueString(), m.HostApp.ValueString(), m.Slug.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("reading environment", err))
		return
	}
	m.Name = types.StringValue(env.Name)
	m.IsDefault = types.BoolValue(env.IsDefault)
	m.Frozen = types.BoolValue(env.Frozen)
	m.FreezeReason = optionalString(env.FreezeReason)
	resp.Diagnostics.Append(resp.State.Set(ctx, m)...)
}

// ─── harmoniq_manifest ──────────────────────────────────────────────────────

// NewManifestDataSource returns the harmoniq_manifest data source.
func NewManifestDataSource() datasource.DataSource { return &manifestDataSource{} }

type manifestDataSource struct{ client *client.Client }

type manifestDataModel struct {
	Workspace   types.String          `tfsdk:"workspace"`
	HostApp     types.String          `tfsdk:"host_app"`
	Environment types.String          `tfsdk:"environment"`
	ETag        types.String          `tfsdk:"etag"`
	GeneratedAt types.String          `tfsdk:"generated_at"`
	Modules     []manifestModuleModel `tfsdk:"modules"`
}

type manifestModuleModel struct {
	Name      types.String `tfsdk:"name"`
	Version   types.String `tfsdk:"version"`
	URL       types.String `tfsdk:"url"`
	Integrity types.String `tfsdk:"integrity"`
	Disabled  types.Bool   `tfsdk:"disabled"`
}

func (d *manifestDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_manifest"
}

func (d *manifestDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The current (stable) manifest of an environment: which version of each module runs.",
		Attributes: map[string]schema.Attribute{
			"workspace":    schema.StringAttribute{Required: true, MarkdownDescription: "Workspace slug."},
			"host_app":     schema.StringAttribute{Required: true, MarkdownDescription: "Host app slug."},
			"environment":  schema.StringAttribute{Required: true, MarkdownDescription: "Environment slug."},
			"etag":         schema.StringAttribute{Computed: true, MarkdownDescription: "Manifest ETag; changes with every change."},
			"generated_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Time of the last change."},
			"modules": schema.ListNestedAttribute{
				Computed:            true,
				MarkdownDescription: "Modules in the manifest.",
				NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
					"name":      schema.StringAttribute{Computed: true, MarkdownDescription: "Module name."},
					"version":   schema.StringAttribute{Computed: true, MarkdownDescription: "Active version."},
					"url":       schema.StringAttribute{Computed: true, MarkdownDescription: "Remote entry URL."},
					"integrity": schema.StringAttribute{Computed: true, MarkdownDescription: "SRI hash."},
					"disabled":  schema.BoolAttribute{Computed: true, MarkdownDescription: "Switched off by the kill switch."},
				}},
			},
		},
	}
}

func (d *manifestDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (d *manifestDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m manifestDataModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	manifest, err := d.client.GetManifest(ctx, m.Workspace.ValueString(), m.HostApp.ValueString(), m.Environment.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(apiErrorDetail("reading manifest", err))
		return
	}
	m.ETag = types.StringValue(manifest.ETag)
	m.GeneratedAt = types.StringValue(manifest.GeneratedAt)
	m.Modules = make([]manifestModuleModel, 0, len(manifest.Modules))
	for _, mod := range manifest.Modules {
		m.Modules = append(m.Modules, manifestModuleModel{
			Name:      types.StringValue(mod.Name),
			Version:   types.StringValue(mod.Version),
			URL:       types.StringValue(mod.URL),
			Integrity: types.StringValue(mod.Integrity),
			Disabled:  types.BoolValue(mod.Disabled),
		})
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, m)...)
}
