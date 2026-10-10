// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from 'crypto';
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/** A minimal OIDC provider: discovery, JWKS, token endpoint with PKCE and refresh. */
export async function mockIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { challenge: string; nonce: string; user: Record<string, unknown>; clientId: string }
  >();
  const refreshTokens = new Set<string>();
  const server = Fastify();
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );
  let issuer = '';
  const state = { wrongNonce: false };

  server.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  }));
  server.get('/jwks', async () => ({ keys: [jwk] }));
  server.post('/token', async (request, reply) => {
    const body = request.body as Record<string, string>;
    if (body.grant_type === 'refresh_token') {
      if (!refreshTokens.has(body.refresh_token)) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      return { access_token: 'at', refresh_token: body.refresh_token };
    }
    const entry = codes.get(body.code);
    codes.delete(body.code);
    const challenge = createHash('sha256')
      .update(body.code_verifier ?? '')
      .digest('base64url');
    if (!entry || entry.challenge !== challenge) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE failed' });
    }
    const idToken = await new SignJWT({
      ...entry.user,
      nonce: state.wrongNonce ? 'not-the-nonce' : entry.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(entry.clientId)
      .setSubject(String(entry.user.sub))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const refresh = randomBytes(8).toString('hex');
    refreshTokens.add(refresh);
    return { access_token: 'at', id_token: idToken, refresh_token: refresh, token_type: 'Bearer' };
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address() as { port: number };
  issuer = `http://127.0.0.1:${address.port}`;

  /** What the IdP does when the user logs in at `authorizationUrl`: returns a code. */
  const authorize = (authorizationUrl: string, user: Record<string, unknown>) => {
    const url = new URL(authorizationUrl);
    const code = randomBytes(8).toString('hex');
    codes.set(code, {
      challenge: url.searchParams.get('code_challenge')!,
      nonce: url.searchParams.get('nonce')!,
      clientId: url.searchParams.get('client_id')!,
      user,
    });
    return code;
  };
  return { issuer, authorize, refreshTokens, state, close: () => server.close() };
}

export type MockIdp = Awaited<ReturnType<typeof mockIdp>>;
