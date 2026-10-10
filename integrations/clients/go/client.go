// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

// Package harmoniq is a thin client for the Harmoniq registry REST API (OAS-03).
//
// Every operation of the API is a method (operations_gen.go, generated from the
// OpenAPI document). Responses are JSON; decode them with Response.JSON.
//
//	c := harmoniq.New("https://registry.acme.dev", os.Getenv("HARMONIQ_API_KEY"))
//	res, err := c.PostWorkspacesModulesDeploy(ctx, "acme", "checkout", map[string]any{
//		"environment": "staging",
//		"version":     "1.4.0",
//		"url":         "https://cdn.acme.dev/checkout/1.4.0/remoteEntry.js",
//		"integrity":   "sha384-…",
//	}, nil)
package harmoniq

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client calls a Harmoniq registry with an API key.
type Client struct {
	BaseURL    string
	APIKey     string
	UserAgent  string
	HTTPClient *http.Client
}

// New returns a client for the registry at baseURL.
func New(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		APIKey:     apiKey,
		UserAgent:  "harmoniq-go",
		HTTPClient: &http.Client{Timeout: 60 * time.Second},
	}
}

// Response is a successful (2xx) response.
type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// JSON decodes the body into v.
func (r *Response) JSON(v any) error { return json.Unmarshal(r.Body, v) }

// Error is a non-2xx response with the registry's error envelope, e.g. 423 LOCKED for
// a frozen environment or 202-pending approvals (which are successes, not errors).
type Error struct {
	StatusCode int
	Code       string
	Message    string
	Details    json.RawMessage
}

func (e *Error) Error() string {
	return fmt.Sprintf("harmoniq: HTTP %d %s: %s", e.StatusCode, e.Code, e.Message)
}

// IsStatus reports whether err is an *Error with this status code.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.StatusCode == status
}

// Do sends a request; body is encoded as JSON when not nil.
func (c *Client) Do(ctx context.Context, method, path string, body any, query url.Values) (*Response, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("harmoniq: encoding request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	target := c.BaseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		e := &Error{StatusCode: res.StatusCode}
		var envelope struct {
			Error struct {
				Code    string          `json:"code"`
				Message string          `json:"message"`
				Details json.RawMessage `json:"details"`
			} `json:"error"`
		}
		if json.Unmarshal(payload, &envelope) == nil {
			e.Code, e.Message, e.Details = envelope.Error.Code, envelope.Error.Message, envelope.Error.Details
		}
		return nil, e
	}
	return &Response{StatusCode: res.StatusCode, Header: res.Header, Body: payload}, nil
}
