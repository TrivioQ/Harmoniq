import { getRegistryUrl } from '@/lib/env';

/**
 * The registry's OpenAPI document, same-origin for the API reference page (the dashboard's
 * Content-Security-Policy only allows `connect-src 'self'`).
 */
export async function GET() {
  try {
    const res = await fetch(`${getRegistryUrl()}/docs/json`, { cache: 'no-store' });
    if (!res.ok) return Response.json({ error: 'Registry unavailable' }, { status: 502 });
    return Response.json(await res.json());
  } catch {
    return Response.json({ error: 'Registry unavailable' }, { status: 502 });
  }
}
