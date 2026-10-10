// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package client

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoSendsKeyAndDecodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer hq_org_k_s" {
			t.Errorf("Authorization = %q", got)
		}
		if r.URL.EscapedPath() != "/api/workspaces/a%2Fb" {
			t.Errorf("path = %q, want escaped segment", r.URL.EscapedPath())
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "Shop" {
			t.Errorf("body = %v", body)
		}
		_, _ = w.Write([]byte(`{"slug":"shop","name":"Shop","retentionDays":30}`))
	}))
	defer srv.Close()

	c := New(srv.URL+"/", "hq_org_k_s", "test")
	var out Workspace
	if err := c.Do(context.Background(), http.MethodPatch, Path("api", "workspaces", "a/b"), map[string]any{"name": "Shop"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.RetentionDays != 30 || out.Slug != "shop" {
		t.Errorf("decoded %+v", out)
	}
}

func TestDoReturnsAPIErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"CONFLICT","message":"\"portal\" still serves module versions"}}`))
	}))
	defer srv.Close()

	err := New(srv.URL, "k", "").DeleteHostApp(context.Background(), "ws", "portal")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 409 || apiErr.Code != "CONFLICT" {
		t.Fatalf("err = %v", err)
	}
	if IsNotFound(err) {
		t.Error("409 reported as not found")
	}
	if want := `registry returned HTTP 409 (CONFLICT): "portal" still serves module versions`; err.Error() != want {
		t.Errorf("message = %q", err.Error())
	}
}

func TestFindersReportMissingAsNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workspaces/ws":
			_, _ = w.Write([]byte(`{"slug":"ws","hostApps":[{"slug":"portal","environments":[{"slug":"staging"}]}]}`))
		case "/api/workspaces/ws/api-keys":
			_, _ = w.Write([]byte(`{"keys":[{"id":"k1","name":"ci"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "k", "")
	ctx := context.Background()

	if env, err := c.FindEnvironment(ctx, "ws", "portal", "staging"); err != nil || env.Slug != "staging" {
		t.Fatalf("FindEnvironment = %v, %v", env, err)
	}
	for name, err := range map[string]error{
		"host app":    func() error { _, err := c.FindHostApp(ctx, "ws", "shop"); return err }(),
		"environment": func() error { _, err := c.FindEnvironment(ctx, "ws", "portal", "prod"); return err }(),
		"api key":     func() error { _, err := c.GetAPIKey(ctx, "ws", "k2"); return err }(),
		"workspace":   func() error { _, err := c.GetWorkspace(ctx, "gone"); return err }(),
	} {
		if !IsNotFound(err) {
			t.Errorf("%s: err = %v, want not found", name, err)
		}
	}
	if k, err := c.GetAPIKey(ctx, "ws", "k1"); err != nil || k.Name != "ci" {
		t.Errorf("GetAPIKey = %v, %v", k, err)
	}
}

func TestDeleteWorkspaceConfirmsTheSlug(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/orgs/acme/workspaces/shop" ||
			r.URL.Query().Get("delete") != "true" || r.URL.Query().Get("confirm") != "shop" {
			t.Errorf("unexpected %s %s", r.Method, r.URL)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := New(srv.URL, "k", "").DeleteWorkspace(context.Background(), "acme", "shop"); err != nil {
		t.Fatal(err)
	}
}
