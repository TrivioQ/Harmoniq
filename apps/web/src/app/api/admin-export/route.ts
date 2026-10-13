// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { getRegistryUrl } from '@/lib/env';
import { ACCESS_COOKIE } from '@/lib/session';

const KINDS = { workspaces: '/api/admin/workspaces', users: '/api/admin/users' } as const;
const FILTERS = ['query', 'status', 'plan', 'org', 'inactiveDays', 'sort', 'filter'];

/** INST-21: workspaces or users as CSV, with the list's filters and the admin's session. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const path = KINDS[params.get('kind') as keyof typeof KINDS];
  if (!path) return NextResponse.json({ error: 'Unknown export' }, { status: 400 });
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const query = new URLSearchParams([
    ['format', 'csv'],
    ...FILTERS.flatMap((name) => (params.get(name) ? [[name, params.get(name)!]] : [])),
  ]);
  const upstream = await fetch(`${getRegistryUrl()}${path}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    const error = await upstream.json().catch(() => null);
    return NextResponse.json(error ?? { error: 'Export failed' }, { status: upstream.status });
  }
  return new NextResponse(await upstream.text(), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      'Cache-Control': 'no-store',
    },
  });
}
