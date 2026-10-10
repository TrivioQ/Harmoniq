import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { getRegistryUrl } from '@/lib/env';
import { ACCESS_COOKIE } from '@/lib/session';

const FILTERS = ['format', 'action', 'actor', 'from', 'to', 'workspace'];

/**
 * Audit export downloads (workspace, organization, instance): streamed from the registry
 * with the signed-in user's session, which authorizes them.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const scope = params.get('scope');
  const slug = encodeURIComponent(params.get('slug') ?? '');
  const path =
    scope === 'workspace'
      ? `/api/workspaces/${slug}/audit/export`
      : scope === 'org'
        ? `/api/orgs/${slug}/audit/export`
        : scope === 'instance'
          ? '/api/admin/audit/export'
          : null;
  if (!path) return NextResponse.json({ error: 'Unknown scope' }, { status: 400 });
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const query = new URLSearchParams(
    FILTERS.flatMap((name) => (params.get(name) ? [[name, params.get(name)!]] : []))
  );
  const upstream = await fetch(`${getRegistryUrl()}${path}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok || !upstream.body) {
    const error = await upstream.json().catch(() => null);
    return NextResponse.json(error ?? { error: 'Export failed' }, { status: upstream.status });
  }
  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/csv',
      'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
      'Cache-Control': 'no-store',
    },
  });
}
