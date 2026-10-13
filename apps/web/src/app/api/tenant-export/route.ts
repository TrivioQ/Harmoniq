// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { getRegistryUrl } from '@/lib/env';
import { ACCESS_COOKIE } from '@/lib/session';

/**
 * TLC-07: a workspace's or organization's data export (JSON Lines), streamed from the
 * registry with the signed-in user's session, which authorizes it.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const slug = encodeURIComponent(params.get('slug') ?? '');
  const scope = params.get('scope');
  const path =
    scope === 'workspace'
      ? `/api/workspaces/${slug}/export`
      : scope === 'org'
        ? `/api/orgs/${slug}/export`
        : null;
  if (!path || !slug) return NextResponse.json({ error: 'Unknown scope' }, { status: 400 });
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const upstream = await fetch(`${getRegistryUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok || !upstream.body) {
    const error = await upstream.json().catch(() => null);
    return NextResponse.json(error ?? { error: 'Export failed' }, { status: upstream.status });
  }
  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/x-ndjson',
      'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      'Cache-Control': 'no-store',
    },
  });
}
