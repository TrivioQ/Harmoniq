// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package client

import (
	"context"
	"net/http"
	"net/url"
)

// Workspace as returned by GET /api/workspaces/:ws.
type Workspace struct {
	Slug                       string    `json:"slug"`
	Name                       string    `json:"name"`
	RetentionDays              int64     `json:"retentionDays"`
	AllowEphemeralEnvironments bool      `json:"allowEphemeralEnvironments"`
	HostApps                   []HostApp `json:"hostApps"`
}

// HostApp as listed in a workspace.
type HostApp struct {
	Slug               string            `json:"slug"`
	Name               string            `json:"name"`
	Description        *string           `json:"description"`
	IsDefault          bool              `json:"isDefault"`
	PreviewURLTemplate *string           `json:"previewUrlTemplate"`
	SharedDependencies map[string]string `json:"sharedDependencies"`
	StrictExposes      bool              `json:"strictExposes"`
	Environments       []Environment     `json:"environments"`
}

// Environment as listed in a host app.
type Environment struct {
	Slug         string  `json:"slug"`
	Name         string  `json:"name"`
	IsDefault    bool    `json:"isDefault"`
	Frozen       bool    `json:"frozen"`
	FreezeReason *string `json:"freezeReason"`
}

// Module as returned by GET /api/workspaces/:ws/modules/:id.
type Module struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	Description *string `json:"description"`
	Specifier   *string `json:"specifier"`
	HostApp     struct {
		Slug string `json:"slug"`
	} `json:"hostApp"`
}

// APIKey as returned by the API key routes. Key is only set on creation.
type APIKey struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Prefix    string   `json:"prefix"`
	Scopes    []string `json:"scopes"`
	ModuleIDs []string `json:"moduleIds"`
	ExpiresAt *string  `json:"expiresAt"`
	RevokedAt *string  `json:"revokedAt"`
	Key       string   `json:"key,omitempty"`
}

// WebhookEndpoint as returned by the webhook routes. Secret is only set on creation.
type WebhookEndpoint struct {
	ID               string   `json:"id"`
	URL              string   `json:"url"`
	Events           []string `json:"events"`
	Active           bool     `json:"active"`
	MaxRetries       int64    `json:"maxRetries"`
	BackoffCeilingMs int64    `json:"backoffCeilingMs"`
	Secret           string   `json:"secret,omitempty"`
}

// AlertRule as returned by the alert routes.
type AlertRule struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Condition string  `json:"condition"`
	Threshold float64 `json:"threshold"`
	Action    string  `json:"action"`
	Module    *struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
	} `json:"module"`
	Environment     *string `json:"environment"`
	WindowMinutes   int64   `json:"windowMinutes"`
	MinSamples      int64   `json:"minSamples"`
	CooldownMinutes int64   `json:"cooldownMinutes"`
	Enabled         bool    `json:"enabled"`
}

// ApprovalPolicy as returned by the approval policy routes.
type ApprovalPolicy struct {
	ID                  string   `json:"id"`
	HostApp             string   `json:"hostApp"`
	Environment         string   `json:"environment"`
	RequiredApprovers   int64    `json:"requiredApprovers"`
	EligibleRoles       []string `json:"eligibleRoles"`
	RequireChangeTicket bool     `json:"requireChangeTicket"`
	TicketURLPattern    *string  `json:"ticketUrlPattern"`
	ExpiryHours         int64    `json:"expiryHours"`
}

// ApprovalPolicyInput is the body of PUT …/approval-policy.
type ApprovalPolicyInput struct {
	RequiredApprovers   int64    `json:"requiredApprovers"`
	EligibleRoles       []string `json:"eligibleRoles"`
	RequireChangeTicket bool     `json:"requireChangeTicket"`
	TicketURLPattern    *string  `json:"ticketUrlPattern,omitempty"`
	ExpiryHours         int64    `json:"expiryHours"`
}

// Manifest is the public manifest of an environment.
type Manifest struct {
	ETag        string `json:"etag"`
	GeneratedAt string `json:"generatedAt"`
	Modules     []struct {
		Name      string `json:"name"`
		Version   string `json:"version"`
		URL       string `json:"url"`
		Integrity string `json:"integrity"`
		Disabled  bool   `json:"disabled"`
	} `json:"modules"`
}

func ws(slug string, rest ...string) string {
	return Path(append([]string{"api", "workspaces", slug}, rest...)...)
}

// GetWorkspace reads a workspace with its host apps and environments.
func (c *Client) GetWorkspace(ctx context.Context, slug string) (*Workspace, error) {
	var out Workspace
	return &out, c.Do(ctx, http.MethodGet, ws(slug), nil, &out)
}

// FindHostApp returns the host app, or a 404 APIError.
func (c *Client) FindHostApp(ctx context.Context, workspace, slug string) (*HostApp, error) {
	w, err := c.GetWorkspace(ctx, workspace)
	if err != nil {
		return nil, err
	}
	for i := range w.HostApps {
		if w.HostApps[i].Slug == slug {
			return &w.HostApps[i], nil
		}
	}
	return nil, &APIError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "host app not found"}
}

// FindEnvironment returns the environment, or a 404 APIError.
func (c *Client) FindEnvironment(ctx context.Context, workspace, hostApp, slug string) (*Environment, error) {
	h, err := c.FindHostApp(ctx, workspace, hostApp)
	if err != nil {
		return nil, err
	}
	for i := range h.Environments {
		if h.Environments[i].Slug == slug {
			return &h.Environments[i], nil
		}
	}
	return nil, &APIError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "environment not found"}
}

// CreateWorkspace creates a workspace in an organization (needs an org key with the admin scope).
func (c *Client) CreateWorkspace(ctx context.Context, org, slug, name string) error {
	return c.Do(ctx, http.MethodPost, Path("api", "orgs", org, "workspaces"),
		map[string]any{"slug": slug, "name": name}, nil)
}

// UpdateWorkspace patches a workspace.
func (c *Client) UpdateWorkspace(ctx context.Context, slug string, body map[string]any) error {
	return c.Do(ctx, http.MethodPatch, ws(slug), body, nil)
}

// DeleteWorkspace deletes a workspace of an organization and everything in it.
func (c *Client) DeleteWorkspace(ctx context.Context, org, slug string) error {
	q := url.Values{"delete": {"true"}, "confirm": {slug}}
	return c.Do(ctx, http.MethodDelete, Path("api", "orgs", org, "workspaces", slug)+"?"+q.Encode(), nil, nil)
}

// CreateHostApp creates a host app without environments.
func (c *Client) CreateHostApp(ctx context.Context, workspace string, body map[string]any) error {
	body["environments"] = []string{}
	return c.Do(ctx, http.MethodPost, ws(workspace, "host-apps"), body, nil)
}

// UpdateHostApp patches a host app.
func (c *Client) UpdateHostApp(ctx context.Context, workspace, slug string, body map[string]any) error {
	return c.Do(ctx, http.MethodPatch, ws(workspace, "host-apps", slug), body, nil)
}

// DeleteHostApp deletes a host app (refused while it serves module versions).
func (c *Client) DeleteHostApp(ctx context.Context, workspace, slug string) error {
	return c.Do(ctx, http.MethodDelete, ws(workspace, "host-apps", slug), nil, nil)
}

func envPath(workspace, hostApp, env string, rest ...string) string {
	return ws(workspace, append([]string{"host-apps", hostApp, "environments", env}, rest...)...)
}

// CreateEnvironment adds an environment to a host app.
func (c *Client) CreateEnvironment(ctx context.Context, workspace, hostApp, slug, name string) error {
	return c.Do(ctx, http.MethodPost, ws(workspace, "host-apps", hostApp, "environments"),
		map[string]any{"slug": slug, "name": name}, nil)
}

// UpdateEnvironment patches an environment.
func (c *Client) UpdateEnvironment(ctx context.Context, workspace, hostApp, slug string, body map[string]any) error {
	return c.Do(ctx, http.MethodPatch, envPath(workspace, hostApp, slug), body, nil)
}

// DeleteEnvironment deletes an environment (refused while it serves module versions).
func (c *Client) DeleteEnvironment(ctx context.Context, workspace, hostApp, slug string) error {
	return c.Do(ctx, http.MethodDelete, envPath(workspace, hostApp, slug), nil, nil)
}

// GetApprovalPolicy returns the environment's policy, or a 404 APIError.
func (c *Client) GetApprovalPolicy(ctx context.Context, workspace, hostApp, env string) (*ApprovalPolicy, error) {
	var out struct {
		Policies []ApprovalPolicy `json:"policies"`
	}
	if err := c.Do(ctx, http.MethodGet, ws(workspace, "approval-policies"), nil, &out); err != nil {
		return nil, err
	}
	for i := range out.Policies {
		if out.Policies[i].HostApp == hostApp && out.Policies[i].Environment == env {
			return &out.Policies[i], nil
		}
	}
	return nil, &APIError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "approval policy not found"}
}

// PutApprovalPolicy creates or replaces an environment's approval policy.
func (c *Client) PutApprovalPolicy(ctx context.Context, workspace, hostApp, env string, in ApprovalPolicyInput) error {
	return c.Do(ctx, http.MethodPut, envPath(workspace, hostApp, env, "approval-policy"), in, nil)
}

// DeleteApprovalPolicy removes an environment's approval policy.
func (c *Client) DeleteApprovalPolicy(ctx context.Context, workspace, hostApp, env string) error {
	return c.Do(ctx, http.MethodDelete, envPath(workspace, hostApp, env, "approval-policy"), nil, nil)
}

// CreateModule creates a module and returns it (with its id).
func (c *Client) CreateModule(ctx context.Context, workspace string, body map[string]any) (*Module, error) {
	var out Module
	return &out, c.Do(ctx, http.MethodPost, ws(workspace, "modules"), body, &out)
}

// GetModule reads a module by id or slug.
func (c *Client) GetModule(ctx context.Context, workspace, ref string) (*Module, error) {
	var out Module
	return &out, c.Do(ctx, http.MethodGet, ws(workspace, "modules", ref), nil, &out)
}

// UpdateModule patches a module.
func (c *Client) UpdateModule(ctx context.Context, workspace, id string, body map[string]any) error {
	return c.Do(ctx, http.MethodPatch, ws(workspace, "modules", id), body, nil)
}

// DeleteModule deletes a module (refused while it serves versions).
func (c *Client) DeleteModule(ctx context.Context, workspace, id string) error {
	return c.Do(ctx, http.MethodDelete, ws(workspace, "modules", id), nil, nil)
}

// CreateAPIKey issues a workspace API key; Key holds the secret, shown only now.
func (c *Client) CreateAPIKey(ctx context.Context, workspace string, body map[string]any) (*APIKey, error) {
	var out APIKey
	return &out, c.Do(ctx, http.MethodPost, ws(workspace, "api-keys"), body, &out)
}

// GetAPIKey returns the key, or a 404 APIError when it doesn't exist.
func (c *Client) GetAPIKey(ctx context.Context, workspace, id string) (*APIKey, error) {
	var out struct {
		Keys []APIKey `json:"keys"`
	}
	if err := c.Do(ctx, http.MethodGet, ws(workspace, "api-keys"), nil, &out); err != nil {
		return nil, err
	}
	for i := range out.Keys {
		if out.Keys[i].ID == id {
			return &out.Keys[i], nil
		}
	}
	return nil, &APIError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "API key not found"}
}

// RevokeAPIKey revokes a key.
func (c *Client) RevokeAPIKey(ctx context.Context, workspace, id string) error {
	return c.Do(ctx, http.MethodDelete, ws(workspace, "api-keys", id), nil, nil)
}

// CreateWebhook registers an endpoint; Secret holds the signing secret, shown only now.
func (c *Client) CreateWebhook(ctx context.Context, workspace string, body map[string]any) (*WebhookEndpoint, error) {
	var out WebhookEndpoint
	return &out, c.Do(ctx, http.MethodPost, ws(workspace, "webhooks"), body, &out)
}

// GetWebhook returns the endpoint, or a 404 APIError.
func (c *Client) GetWebhook(ctx context.Context, workspace, id string) (*WebhookEndpoint, error) {
	var out struct {
		Endpoints []WebhookEndpoint `json:"endpoints"`
	}
	if err := c.Do(ctx, http.MethodGet, ws(workspace, "webhooks"), nil, &out); err != nil {
		return nil, err
	}
	for i := range out.Endpoints {
		if out.Endpoints[i].ID == id {
			return &out.Endpoints[i], nil
		}
	}
	return nil, &APIError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "webhook endpoint not found"}
}

// UpdateWebhook patches an endpoint.
func (c *Client) UpdateWebhook(ctx context.Context, workspace, id string, body map[string]any) error {
	return c.Do(ctx, http.MethodPatch, ws(workspace, "webhooks", id), body, nil)
}

// DeleteWebhook removes an endpoint.
func (c *Client) DeleteWebhook(ctx context.Context, workspace, id string) error {
	return c.Do(ctx, http.MethodDelete, ws(workspace, "webhooks", id), nil, nil)
}

// CreateAlertRule creates an alert rule.
func (c *Client) CreateAlertRule(ctx context.Context, workspace string, body map[string]any) (*AlertRule, error) {
	var out AlertRule
	return &out, c.Do(ctx, http.MethodPost, ws(workspace, "alerts"), body, &out)
}

// GetAlertRule returns the rule, or a 404 APIError.
func (c *Client) GetAlertRule(ctx context.Context, workspace, id string) (*AlertRule, error) {
	var out struct {
		Rules []AlertRule `json:"rules"`
	}
	if err := c.Do(ctx, http.MethodGet, ws(workspace, "alerts"), nil, &out); err != nil {
		return nil, err
	}
	for i := range out.Rules {
		if out.Rules[i].ID == id {
			return &out.Rules[i], nil
		}
	}
	return nil, &APIError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "alert rule not found"}
}

// UpdateAlertRule patches a rule.
func (c *Client) UpdateAlertRule(ctx context.Context, workspace, id string, body map[string]any) error {
	return c.Do(ctx, http.MethodPatch, ws(workspace, "alerts", id), body, nil)
}

// DeleteAlertRule removes a rule.
func (c *Client) DeleteAlertRule(ctx context.Context, workspace, id string) error {
	return c.Do(ctx, http.MethodDelete, ws(workspace, "alerts", id), nil, nil)
}

// GetManifest reads an environment's public manifest.
func (c *Client) GetManifest(ctx context.Context, workspace, hostApp, env string) (*Manifest, error) {
	var out Manifest
	return &out, c.Do(ctx, http.MethodGet, Path("api", "manifest", workspace, hostApp, env), nil, &out)
}
