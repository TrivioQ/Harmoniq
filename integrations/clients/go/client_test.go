// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package harmoniq

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestGeneratedOperation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.EscapedPath() != "/api/workspaces/acme/modules/check%2Fout/deploy" {
			t.Errorf("got %s %s", r.Method, r.URL.EscapedPath())
		}
		if r.Header.Get("Authorization") != "Bearer hq_k_s" || r.URL.Query().Get("dryRun") != "1" {
			t.Errorf("headers %v query %v", r.Header, r.URL.Query())
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["environment"] != "staging" {
			t.Errorf("body %v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"v1","manifestEtag":"sha256-x"}`))
	}))
	defer srv.Close()

	res, err := New(srv.URL, "hq_k_s").PostWorkspacesModulesDeploy(context.Background(), "acme", "check/out",
		map[string]any{"environment": "staging"}, url.Values{"dryRun": {"1"}})
	if err != nil {
		t.Fatal(err)
	}
	var out struct{ ID string }
	if res.StatusCode != 201 || res.JSON(&out) != nil || out.ID != "v1" {
		t.Errorf("response %d %s", res.StatusCode, res.Body)
	}
}

func TestErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusLocked)
		_, _ = w.Write([]byte(`{"error":{"code":"LOCKED","message":"production is frozen"}}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "k").GetManifestByWorkspaceSlugAndHostAppSlugAndEnv(context.Background(), "acme", "portal", "production", nil)
	if !IsStatus(err, http.StatusLocked) || err.Error() != "harmoniq: HTTP 423 LOCKED: production is frozen" {
		t.Fatalf("err = %v", err)
	}
}
