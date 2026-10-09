import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { computeIntegrity } from '@harmoniq/core/dist/validation/bundle';
import { run } from '../index';

const REGISTRY = 'http://registry.test';
const KEY = 'hq_key1_secret';
const BUNDLE = 'export const mount = () => {};';

// The last request the fake registry received, per path.
let received: Record<string, { body: unknown; auth: string | null }> = {};
let nextStatus: number | null = null;

const server = setupServer(
  http.post(
    `${REGISTRY}/api/workspaces/acme/modules/:module/:action`,
    async ({ request, params }) => {
      const key = `${params.module}/${params.action}`;
      const body = (await request.json()) as Record<string, unknown>;
      received[key] = { body, auth: request.headers.get('authorization') };
      if (nextStatus) {
        return HttpResponse.json(
          { error: { code: 'X', message: `failed with ${nextStatus}` } },
          { status: nextStatus }
        );
      }
      if (body.dryRun) {
        return HttpResponse.json({
          dryRun: true,
          validation: { errors: [], warnings: [] },
          frozen: false,
        });
      }
      return HttpResponse.json(
        { version: body.version ?? '1.0.0', status: 'active', manifestEtag: 'sha256-abc' },
        { status: params.action === 'rollback' ? 200 : 201 }
      );
    }
  ),
  http.get(`${REGISTRY}/api/workspaces/acme`, ({ request }) =>
    request.headers.get('authorization') === `Bearer ${KEY}`
      ? HttpResponse.json({ name: 'Acme', hostApps: [{ slug: 'portal' }] })
      : HttpResponse.json({ error: { message: 'Invalid credentials' } }, { status: 401 })
  ),
  http.get(`${REGISTRY}/api/manifest/acme/production`, () =>
    HttpResponse.json({ schemaVersion: 2, etag: 'sha256-m', modules: [] })
  ),
  http.get(
    'https://cdn.test/bundle.js',
    () =>
      new HttpResponse(BUNDLE, {
        headers: {
          'content-type': 'application/javascript',
          'access-control-allow-origin': '*',
        },
      })
  )
);

describe('harmoniq CLI', () => {
  let configDir: string;
  let stdout: string[];
  let stderr: string[];
  const cli = (...args: string[]) => run(['node', 'harmoniq', ...args]);
  const withKey = ['--registry-url', REGISTRY, '--api-key', KEY, '--workspace', 'acme'];
  const deployArgs = (...extra: string[]) => [
    ...withKey,
    'deploy',
    '--module',
    'checkout',
    '--env',
    'production',
    '--url',
    'https://cdn.test/bundle.js',
    '--release',
    '2.0.0',
    ...extra,
  ];

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'harmoniq-cli-'));
    process.env.HARMONIQ_CONFIG_DIR = configDir;
    received = {};
    nextStatus = null;
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((m) => void stdout.push(String(m)));
    vi.spyOn(console, 'error').mockImplementation((m) => void stderr.push(String(m)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.HARMONIQ_CONFIG_DIR;
    delete process.env.HARMONIQ_API_KEY;
    await rm(configDir, { recursive: true, force: true });
  });

  describe('deploy', () => {
    it('sends the environment, version and an integrity computed from --file', async () => {
      const file = join(configDir, 'remoteEntry.js');
      await writeFile(file, BUNDLE);

      const code = await cli(
        ...withKey,
        '--json',
        'deploy',
        '--module',
        'checkout',
        '--env',
        'staging',
        '--url',
        'https://cdn.test/bundle.js',
        '--release',
        '1.2.3',
        '--file',
        file,
        '--commit',
        'abc123',
        '--meta',
        'pr=42'
      );

      expect(code).toBe(0);
      const sent = received['checkout/deploy'];
      expect(sent.auth).toBe(`Bearer ${KEY}`);
      expect(sent.body).toEqual({
        environment: 'staging',
        url: 'https://cdn.test/bundle.js',
        version: '1.2.3',
        integrity: await computeIntegrity(new TextEncoder().encode(BUNDLE).buffer as ArrayBuffer),
        commitSha: 'abc123',
        metadata: { pr: '42' },
        dryRun: false,
      });
      expect(JSON.parse(stdout[0])).toMatchObject({ manifestEtag: 'sha256-abc' });
    });

    it.each([
      [401, 3],
      [403, 3],
      [400, 2],
      [409, 5],
      [423, 4],
      [500, 1],
    ])('maps HTTP %i to exit code %i and never claims success', async (status, exitCode) => {
      nextStatus = status;
      expect(await cli(...deployArgs('--integrity', 'sha384-x'))).toBe(exitCode);
      expect(stderr.join('\n')).toContain(`failed with ${status}`);
      expect(stdout).toEqual([]);
    });

    it('fails with exit 3 and sends nothing when there is no API key', async () => {
      const code = await cli(
        '--registry-url',
        REGISTRY,
        '--workspace',
        'acme',
        'deploy',
        '--module',
        'm',
        '--env',
        'e',
        '--url',
        'https://x',
        '--release',
        '1',
        '--integrity',
        'sha384-x'
      );
      expect(code).toBe(3);
      expect(received).toEqual({});
    });

    it('validates locally with --validate and refuses a mismatching bundle', async () => {
      expect(await cli(...deployArgs('--integrity', 'sha384-wrong', '--validate'))).toBe(2);
      expect(received['checkout/deploy']).toBeUndefined();
    });
  });

  it('rolls back to the previous version by default, or to --to', async () => {
    expect(await cli(...withKey, 'rollback', '--module', 'checkout', '--env', 'production')).toBe(
      0
    );
    expect(received['checkout/rollback'].body).toEqual({
      environment: 'production',
      previous: true,
    });

    expect(
      await cli(
        ...withKey,
        'rollback',
        '--module',
        'checkout',
        '--env',
        'production',
        '--to',
        '1.2.2'
      )
    ).toBe(0);
    expect(received['checkout/rollback'].body).toEqual({
      environment: 'production',
      version: '1.2.2',
    });
  });

  it('promotes between environments', async () => {
    expect(
      await cli(
        ...withKey,
        'promote',
        '--module',
        'checkout',
        '--from',
        'staging',
        '--to',
        'production'
      )
    ).toBe(0);
    expect(received['checkout/promote'].body).toEqual({
      fromEnvironment: 'staging',
      toEnvironment: 'production',
    });
  });

  describe('validate', () => {
    it('passes for a matching local build', async () => {
      const file = join(configDir, 'b.js');
      await writeFile(file, BUNDLE);
      expect(await cli('validate', '--url', 'https://cdn.test/bundle.js', '--file', file)).toBe(0);
      expect(stdout[0]).toContain('is valid');
    });

    it('fails with exit 2 on an integrity mismatch', async () => {
      expect(
        await cli('validate', '--url', 'https://cdn.test/bundle.js', '--integrity', 'sha384-AAAA')
      ).toBe(2);
      expect(stdout[0]).toContain('Integrity mismatch');
    });
  });

  describe('login and profiles', () => {
    it('verifies the key, saves it with owner-only permissions and reuses it', async () => {
      expect(await cli(...withKey, 'login')).toBe(0);

      const path = join(configDir, 'config.json');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8')).profiles.default).toEqual({
        registryUrl: REGISTRY,
        apiKey: KEY,
        workspace: 'acme',
      });

      // No flags needed afterwards.
      expect(await cli('--json', 'whoami')).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        workspace: 'acme',
        workspaceName: 'Acme',
      });
    });

    it('refuses to save a key the registry rejects', async () => {
      const code = await cli(
        '--registry-url',
        REGISTRY,
        '--api-key',
        'hq_bad_key',
        '--workspace',
        'acme',
        'login'
      );
      expect(code).toBe(3);
      await expect(stat(join(configDir, 'config.json'))).rejects.toThrow();
    });

    it('prefers environment variables over the saved profile', async () => {
      await cli(...withKey, 'login');
      process.env.HARMONIQ_API_KEY = 'hq_from_env_x';
      expect(await cli('whoami')).toBe(3); // the env key wins and is rejected
    });
  });

  it('pulls the manifest to a file without an API key', async () => {
    const out = join(configDir, 'fallback.json');
    const code = await cli(
      '--registry-url',
      REGISTRY,
      '--workspace',
      'acme',
      'manifest',
      'pull',
      '--env',
      'production',
      '--out',
      out
    );
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ etag: 'sha256-m' });
  });
});
