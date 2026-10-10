// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package provider

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/client"
)

// clientFrom unwraps the configured client from ProviderData (nil before configuration).
func clientFrom(data any, diags *diag.Diagnostics) *client.Client {
	if data == nil {
		return nil
	}
	c, ok := data.(*client.Client)
	if !ok {
		diags.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", data))
		return nil
	}
	return c
}

// splitID splits an import id like "workspace/host-app/environment" into n parts.
func splitID(id string, n int, format string, diags *diag.Diagnostics) []string {
	parts := strings.Split(id, "/")
	if len(parts) != n {
		diags.AddError("Invalid import id", fmt.Sprintf("Expected %q, got %q.", format, id))
		return nil
	}
	for _, p := range parts {
		if p == "" {
			diags.AddError("Invalid import id", fmt.Sprintf("Expected %q, got %q.", format, id))
			return nil
		}
	}
	return parts
}

// optionalString maps a nullable API string to a Terraform string (null stays null).
func optionalString(v *string) types.String {
	if v == nil {
		return types.StringNull()
	}
	return types.StringValue(*v)
}

// nullableBody is the JSON value for an optional attribute: nil (JSON null) when unset.
func nullableBody(v types.String) any {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	return v.ValueString()
}

func stringSet(values []string) types.Set {
	sorted := append([]string(nil), values...)
	sort.Strings(sorted)
	elems := make([]attr.Value, len(sorted))
	for i, v := range sorted {
		elems[i] = types.StringValue(v)
	}
	return types.SetValueMust(types.StringType, elems)
}

func setStrings(ctx context.Context, s types.Set, diags *diag.Diagnostics) []string {
	if s.IsNull() || s.IsUnknown() {
		return []string{}
	}
	out := []string{}
	diags.Append(s.ElementsAs(ctx, &out, false)...)
	return out
}

func stringMap(values map[string]string) types.Map {
	if values == nil {
		return types.MapNull(types.StringType)
	}
	elems := make(map[string]attr.Value, len(values))
	for k, v := range values {
		elems[k] = types.StringValue(v)
	}
	return types.MapValueMust(types.StringType, elems)
}

func apiErrorDetail(action string, err error) (string, string) {
	return "Harmoniq: " + action + " failed", err.Error()
}

// ticketPattern: a ticket link template must contain the {id} placeholder.
var ticketPattern = regexp.MustCompile(`\{id\}`)
