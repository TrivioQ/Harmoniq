'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, authedFetch } from '@/lib/registry';

// SSO-03/09..24, ORG-05..07: single sign-on and SCIM settings of a workspace or an
// organization. The registry authorizes and audits every change.

/** Whose settings: a workspace's or an organization's. */
export interface SsoOwner {
  kind: 'workspace' | 'organization';
  slug: string;
}

const enc = encodeURIComponent;
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const base = (owner: SsoOwner) =>
  owner.kind === 'workspace'
    ? `/api/workspaces/${enc(owner.slug)}`
    : `/api/orgs/${enc(owner.slug)}`;
const list = (form: FormData, name: string) =>
  field(form, name)
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
/** Workspaces map groups to roles ("group = role" per line); organizations use rules. */
const roles = (owner: SsoOwner, form: FormData) =>
  owner.kind === 'workspace'
    ? {
        roleMapping: Object.fromEntries(
          field(form, 'roleMapping')
            .split('\n')
            .map((line) => line.split('=').map((part) => part.trim()))
            .filter(([group, role]) => group && role)
        ),
        defaultRole: field(form, 'defaultRole') || 'viewer',
      }
    : {};

async function run(
  call: () => Promise<unknown>,
  success: (t: Awaited<ReturnType<typeof getTranslations>>, result: unknown) => ActionResult
): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  try {
    const result = await call();
    revalidatePath('/', 'layout');
    return success(t, result);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : t('unexpectedError'),
    };
  }
}

// ─── OpenID Connect ─────────────────────────────────────────────────────────

export async function saveSsoAction(
  owner: SsoOwner,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const secret = field(form, 'clientSecret');
  return run(
    () =>
      authedFetch(`${base(owner)}/sso/oidc`, {
        method: 'PUT',
        body: {
          issuer: field(form, 'issuer'),
          clientId: field(form, 'clientId'),
          ...(secret && { clientSecret: secret }),
          scopes: list(form, 'scopes').length ? list(form, 'scopes') : undefined,
          groupsClaim: field(form, 'groupsClaim') || undefined,
          trustedDomains: list(form, 'trustedDomains'),
          forceSso: form.get('forceSso') === 'on',
          ...roles(owner, form),
        },
      }),
    (t) => ({ status: 'success', message: t('ssoSaved') })
  );
}

export async function deleteSsoAction(owner: SsoOwner, _prev: ActionResult) {
  return run(
    () => authedFetch(`${base(owner)}/sso/oidc`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('ssoRemoved') })
  );
}

// ─── SAML ───────────────────────────────────────────────────────────────────

/** Saves the SAML settings; pasted IdP metadata (SSO-17) fills whatever was left empty. */
export async function saveSamlAction(
  owner: SsoOwner,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const optional = (name: string) => field(form, name) || undefined;
  const path = `${base(owner)}/sso/saml`;
  return run(
    async () => {
      const metadataXml = field(form, 'metadataXml');
      const imported = metadataXml
        ? await authedFetch<Record<string, string | undefined>>(`${path}/import`, {
            body: { metadataXml },
          })
        : {};
      return authedFetch(path, {
        method: 'PUT',
        body: {
          idpEntityId: optional('idpEntityId') ?? imported.idpEntityId,
          idpSsoUrl: optional('idpSsoUrl') ?? imported.idpSsoUrl,
          idpSloUrl: optional('idpSloUrl') ?? imported.idpSloUrl,
          idpCert: optional('idpCert') ?? imported.idpCert,
          attributeMapping: {
            email: optional('emailAttribute'),
            name: optional('nameAttribute'),
            groups: optional('groupsAttribute'),
          },
          trustedDomains: list(form, 'trustedDomains'),
          forceSso: form.get('forceSso') === 'on',
          allowIdpInitiated: form.get('allowIdpInitiated') === 'on',
          ...roles(owner, form),
        },
      });
    },
    (t) => ({ status: 'success', message: t('ssoSaved') })
  );
}

export async function deleteSamlAction(owner: SsoOwner, _prev: ActionResult) {
  return run(
    () => authedFetch(`${base(owner)}/sso/saml`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('ssoRemoved') })
  );
}

/** SSO-20: sends the admin to the IdP; the result comes back on the settings page. */
export async function testSamlAction(owner: SsoOwner, _prev: ActionResult): Promise<ActionResult> {
  let url: string;
  try {
    ({ url } = await authedFetch<{ id: string; url: string }>(`${base(owner)}/sso/saml/test`, {
      method: 'POST',
    }));
  } catch (err) {
    const t = await getTranslations('Actions');
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : t('unexpectedError'),
    };
  }
  redirect(url);
}

// ─── SCIM ───────────────────────────────────────────────────────────────────

export async function rotateScimTokenAction(owner: SsoOwner, _prev: ActionResult) {
  return run(
    () => authedFetch(`${base(owner)}/scim/token`, { method: 'POST' }),
    (t, r) => ({
      status: 'success',
      message: t('scimToken'),
      secret: (r as { token: string }).token,
    })
  );
}

export async function disableScimAction(owner: SsoOwner, _prev: ActionResult) {
  return run(
    () => authedFetch(`${base(owner)}/scim`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('scimDisabled') })
  );
}
