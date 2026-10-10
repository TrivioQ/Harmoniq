// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/harmoniq-dev/terraform-provider-harmoniq/internal/provider"
)

// Set by the release build (-ldflags "-X main.version=…").
var version = "dev"

// Docs in docs/ are generated from the schemas and examples/ (IaC-04).
//go:generate go tool tfplugindocs generate --provider-name harmoniq

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/harmoniq-dev/harmoniq",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
