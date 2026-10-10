// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

export default function ApiDocsPage() {
  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <ApiReferenceReact
        configuration={{
          // Same-origin proxy of the registry's /docs/json (CSP: connect-src 'self').
          spec: { url: '/api/openapi' },
          // The default fonts come from a CDN, which the CSP doesn't allow.
          withDefaultFonts: false,
          // No calls home. Its agent search (api.scalar.com) has no switch; the CSP blocks it.
          telemetry: false,
        }}
      />
    </div>
  );
}
