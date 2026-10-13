// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package client

import (
	"context"
	"encoding/json"
	"net/http"
)

// Instance administration (INST-33/34): these calls need an instance API key (hq_inst_…).

// SettingVersion is one saved version of an instance setting; secrets are left out.
type SettingVersion struct {
	Version int64           `json:"version"`
	Source  string          `json:"source"`
	Value   json.RawMessage `json:"value"`
}

// PutInstanceSetting saves a setting (a JSON object) in the database.
func (c *Client) PutInstanceSetting(ctx context.Context, key string, value json.RawMessage) error {
	return c.Do(ctx, http.MethodPut, Path("api", "admin", "settings", key), value, nil)
}

// LatestInstanceSetting returns the newest saved version, or nil when there is none.
func (c *Client) LatestInstanceSetting(ctx context.Context, key string) (*SettingVersion, error) {
	var out struct {
		Versions []SettingVersion `json:"versions"`
	}
	if err := c.Do(ctx, http.MethodGet, Path("api", "admin", "settings", key, "history"), nil, &out); err != nil {
		return nil, err
	}
	if len(out.Versions) == 0 {
		return nil, nil
	}
	return &out.Versions[0], nil
}

// DeleteInstanceSetting resets a setting to the environment's defaults.
func (c *Client) DeleteInstanceSetting(ctx context.Context, key string) error {
	return c.Do(ctx, http.MethodDelete, Path("api", "admin", "settings", key), nil, nil)
}

// TenantPlan is a workspace's or organization's plan (PLN-01, PLN-06).
type TenantPlan struct {
	Slug      string         `json:"slug"`
	Plan      string         `json:"plan"`
	ExpiresAt *string        `json:"expiresAt"`
	BasePlan  *string        `json:"basePlan"`
	Overrides *PlanOverrides `json:"overrides"`
}

// PlanOverrides are per-tenant exceptions to its plan. A nil limit is unlimited.
type PlanOverrides struct {
	Features map[string]bool   `json:"features,omitempty"`
	Limits   map[string]*int64 `json:"limits,omitempty"`
}

// SetPlanInput is the body of PUT …/plan. Overrides nil clears them.
type SetPlanInput struct {
	Plan      string         `json:"plan"`
	ExpiresAt *string        `json:"expiresAt"`
	BasePlan  *string        `json:"basePlan,omitempty"`
	Overrides *PlanOverrides `json:"overrides"`
}

// GetTenantPlan reads a plan; scope is "workspaces" or "orgs".
func (c *Client) GetTenantPlan(ctx context.Context, scope, slug string) (*TenantPlan, error) {
	var out TenantPlan
	return &out, c.Do(ctx, http.MethodGet, Path("api", "admin", scope, slug, "plan"), nil, &out)
}

// SetTenantPlan sets a plan; scope is "workspaces" or "orgs".
func (c *Client) SetTenantPlan(ctx context.Context, scope, slug string, in SetPlanInput) error {
	return c.Do(ctx, http.MethodPut, Path("api", "admin", scope, slug, "plan"), in, nil)
}
