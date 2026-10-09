import path from 'path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // Self-contained server for Docker (apps/web/Dockerfile). Tracing starts at the monorepo
  // root so workspace packages (@harmoniq/core) are included.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
};

export default withNextIntl(nextConfig);
