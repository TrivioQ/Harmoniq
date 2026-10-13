// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getRegistryUrl } from '@/lib/env';
import { ACCESS_COOKIE } from '@/lib/session';

/** INST-35: the instance settings as YAML (secrets left out), with the admin's session. */
export async function GET() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const upstream = await fetch(`${getRegistryUrl()}/api/admin/settings/export`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    const error = await upstream.json().catch(() => null);
    return NextResponse.json(error ?? { error: 'Export failed' }, { status: upstream.status });
  }
  return new NextResponse(await upstream.text(), {
    headers: {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      'Cache-Control': 'no-store',
    },
  });
}
