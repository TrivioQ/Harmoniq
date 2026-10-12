// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { getRegistryUrl } from '@/lib/env';
import { ACCESS_COOKIE } from '@/lib/session';

/** USG-03: usage as CSV, fetched with the signed-in user's session, which authorizes it. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const slug = encodeURIComponent(params.get('slug') ?? '');
  const days = Math.min(400, Math.max(1, Number(params.get('days')) || 30));
  const scope = params.get('scope');
  const path =
    scope === 'workspace' && slug
      ? `/api/workspaces/${slug}/usage`
      : scope === 'org' && slug
        ? `/api/orgs/${slug}/usage`
        : scope === 'instance'
          ? '/api/admin/usage'
          : null;
  if (!path) return NextResponse.json({ error: 'Unknown scope' }, { status: 400 });
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const upstream = await fetch(`${getRegistryUrl()}${path}?format=csv&days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    const error = await upstream.json().catch(() => null);
    return NextResponse.json(error ?? { error: 'Export failed' }, { status: upstream.status });
  }
  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      'Cache-Control': 'no-store',
    },
  });
}
