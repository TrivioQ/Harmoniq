'use client';

import React from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

export default function ApiDocsPage() {
  return (
    <div className="h-[calc(100vh-4rem)] w-full">
      <ApiReferenceReact
        configuration={{
          spec: {
            url: process.env.NEXT_PUBLIC_REGISTRY_URL
              ? `${process.env.NEXT_PUBLIC_REGISTRY_URL}/api-docs/json`
              : 'http://localhost:3002/api-docs/json',
          },
        }}
      />
    </div>
  );
}
