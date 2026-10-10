// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
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

// approvalPolicyBlock is APR-01/13: who approves changes to an environment.
type approvalPolicyBlock struct {
	RequiredApprovers   types.Int64  `tfsdk:"required_approvers"`
	EligibleRoles       types.Set    `tfsdk:"eligible_roles"`
	RequireChangeTicket types.Bool   `tfsdk:"require_change_ticket"`
	TicketURLPattern    types.String `tfsdk:"ticket_url_pattern"`
	ExpiryHours         types.Int64  `tfsdk:"expiry_hours"`
}

func policyAttributes() map[string]schema.Attribute {
	return map[string]schema.Attribute{
		"required_approvers": schema.Int64Attribute{
			Optional:            true,
			Computed:            true,
			Default:             int64default.StaticInt64(1),
			MarkdownDescription: "Approvals needed (1–10, default 1). Requesters never approve their own changes.",
			Validators:          []validator.Int64{int64validator.Between(1, 10)},
		},
		"eligible_roles": schema.SetAttribute{
			ElementType:         types.StringType,
			Required:            true,
			MarkdownDescription: "Roles that may approve: `developer`, `admin`, `owner`.",
			Validators: []validator.Set{
				setvalidator.SizeAtLeast(1),
				setvalidator.ValueStringsAre(stringvalidator.OneOf("developer", "admin", "owner")),
			},
		},
		"require_change_ticket": schema.BoolAttribute{
			Optional:            true,
			Computed:            true,
			Default:             booldefault.StaticBool(false),
			MarkdownDescription: "Changes must carry a change ticket id.",
		},
		"ticket_url_pattern": schema.StringAttribute{
			Optional:            true,
			MarkdownDescription: "Link built from the ticket id, containing `{id}`, e.g. `https://acme.atlassian.net/browse/{id}`.",
			Validators:          []validator.String{stringvalidator.RegexMatches(ticketPattern, "must contain {id}")},
		},
		"expiry_hours": schema.Int64Attribute{
			Optional:            true,
			Computed:            true,
			Default:             int64default.StaticInt64(24),
			MarkdownDescription: "Hours before a pending request expires (1–720, default 24).",
			Validators:          []validator.Int64{int64validator.Between(1, 720)},
		},
	}
}

func approvalPolicyAttribute() schema.SingleNestedAttribute {
	return schema.SingleNestedAttribute{
		Optional:            true,
		MarkdownDescription: "Changes to this environment need approval. Remove the block to drop the policy.",
		Attributes:          policyAttributes(),
	}
}

func (b *approvalPolicyBlock) input(ctx context.Context, diags *diag.Diagnostics) client.ApprovalPolicyInput {
	in := client.ApprovalPolicyInput{
		RequiredApprovers:   b.RequiredApprovers.ValueInt64(),
		EligibleRoles:       setStrings(ctx, b.EligibleRoles, diags),
		RequireChangeTicket: b.RequireChangeTicket.ValueBool(),
		ExpiryHours:         b.ExpiryHours.ValueInt64(),
	}
	if !b.TicketURLPattern.IsNull() && !b.TicketURLPattern.IsUnknown() {
		v := b.TicketURLPattern.ValueString()
		in.TicketURLPattern = &v
	}
	return in
}

func policyBlockFrom(p *client.ApprovalPolicy) *approvalPolicyBlock {
	return &approvalPolicyBlock{
		RequiredApprovers:   types.Int64Value(p.RequiredApprovers),
		EligibleRoles:       stringSet(p.EligibleRoles),
		RequireChangeTicket: types.BoolValue(p.RequireChangeTicket),
		TicketURLPattern:    optionalString(p.TicketURLPattern),
		ExpiryHours:         types.Int64Value(p.ExpiryHours),
	}
}

var (
	_ resource.Resource                = &approvalPolicyResource{}
	_ resource.ResourceWithImportState = &approvalPolicyResource{}
)

// NewApprovalPolicyResource returns harmoniq_approval_policy.
func NewApprovalPolicyResource() resource.Resource { return &approvalPolicyResource{} }

type approvalPolicyResource struct{ client *client.Client }

type approvalPolicyModel struct {
	ID          types.String `tfsdk:"id"`
	Workspace   types.String `tfsdk:"workspace"`
	HostApp     types.String `tfsdk:"host_app"`
	Environment types.String `tfsdk:"environment"`
	approvalPolicyBlock
}

func (r *approvalPolicyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_approval_policy"
}

func (r *approvalPolicyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	attrs := policyAttributes()
	attrs["id"] = schema.StringAttribute{
		Computed:            true,
		MarkdownDescription: "`workspace/host-app/environment`.",
		PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
	}
	for name, desc := range map[string]string{
		"workspace":   "Workspace slug.",
		"host_app":    "Host app slug.",
		"environment": "Environment slug.",
	} {
		attrs[name] = schema.StringAttribute{
			Required:            true,
			MarkdownDescription: desc,
			PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
		}
	}
	resp.Schema = schema.Schema{
		MarkdownDescription: "The approval policy of an environment: deploys, promotions, rollbacks and canary " +
			"changes wait for approval. Don't combine with the `approval_policy` attribute of the same " +
			"`harmoniq_environment`.",
		Attributes: attrs,
	}
}

func (r *approvalPolicyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *approvalPolicyResource) put(ctx context.Context, m *approvalPolicyModel, diags *diag.Diagnostics) {
	ws, host, env := m.Workspace.ValueString(), m.HostApp.ValueString(), m.Environment.ValueString()
	if err := r.client.PutApprovalPolicy(ctx, ws, host, env, m.input(ctx, diags)); err != nil {
		diags.AddError(apiErrorDetail("setting approval policy", err))
		return
	}
	m.ID = types.StringValue(ws + "/" + host + "/" + env)
	r.read(ctx, m, diags)
}

func (r *approvalPolicyResource) read(ctx context.Context, m *approvalPolicyModel, diags *diag.Diagnostics) bool {
	p, err := r.client.GetApprovalPolicy(ctx, m.Workspace.ValueString(), m.HostApp.ValueString(), m.Environment.ValueString())
	if client.IsNotFound(err) {
		return false
	}
	if err != nil {
		diags.AddError(apiErrorDetail("reading approval policy", err))
		return true
	}
	m.approvalPolicyBlock = *policyBlockFrom(p)
	return true
}

func (r *approvalPolicyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan approvalPolicyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
	}
}

func (r *approvalPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state approvalPolicyModel
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

func (r *approvalPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan approvalPolicyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
	}
}

func (r *approvalPolicyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state approvalPolicyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.DeleteApprovalPolicy(ctx, state.Workspace.ValueString(), state.HostApp.ValueString(), state.Environment.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(apiErrorDetail("removing approval policy", err))
	}
}

// ImportState takes "workspace/host-app/environment".
func (r *approvalPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts := splitID(req.ID, 3, "workspace/host-app/environment", &resp.Diagnostics)
	if parts == nil {
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workspace"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("host_app"), parts[1])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("environment"), parts[2])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
