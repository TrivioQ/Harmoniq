#!/usr/bin/env node
/**
 * DX-02: the registry and the dashboard with nothing installed but Node.js: an embedded
 * Postgres (downloaded as an npm package, data in .harmoniq/dev-local), in-memory cache,
 * local storage and "sign in as any email". No Docker, no Postgres server, no Redis.
 *
 *   pnpm run dev:local          then open http://localhost:3000
 *   pnpm run dev:local --reset  start from an empty database
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.harmoniq', 'dev-local', 'postgres');
const port = Number(process.env.HARMONIQ_DEV_PG_PORT ?? 54329);
const password = 'password';
const log = (message) => console.log(`[dev:local] ${message}`);

if (process.argv.includes('--reset')) {
  rmSync(dataDir, { recursive: true, force: true });
  log('Database reset');
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password,
  port,
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
if (fresh) {
  log('Creating the database (first run)…');
  await pg.initialise();
}
await pg.start();
log(`Postgres on 127.0.0.1:${port}`);

// The same two roles as docker/init.sql: the schema owner and the RLS-bound runtime role.
const admin = pg.getPgClient();
await admin.connect();
for (const [role, extra] of [
  ['harmoniq', 'CREATEDB'],
  ['harmoniq_app', ''],
]) {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!rowCount) await admin.query(`CREATE USER ${role} WITH PASSWORD '${password}' ${extra}`);
}
const { rowCount: hasDb } = await admin.query(
  "SELECT 1 FROM pg_database WHERE datname = 'harmoniq'"
);
if (!hasDb) await admin.query('CREATE DATABASE harmoniq OWNER harmoniq');
await admin.end();

const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: `postgresql://harmoniq_app:${password}@127.0.0.1:${port}/harmoniq`,
  SYSTEM_DATABASE_URL: `postgresql://harmoniq:${password}@127.0.0.1:${port}/harmoniq`,
  CACHE_ADAPTER: 'memory',
  STORAGE_ADAPTER: 'local',
  HARMONIQ_DEV_LOGIN: '1',
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-local-only-jwt-secret-0123456789abcdef',
  REGISTRY_URL: 'http://localhost:4000',
  WEB_ORIGIN: 'http://localhost:3000',
};
// Each app keeps its own port (4000, 3000); no Redis.
delete env.PORT;
delete env.REDIS_URL;

const run = (args, opts = {}) => {
  const result = spawnSync('pnpm', args, { cwd: root, env, stdio: 'inherit', ...opts });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
};

let dev;
const stop = async (code = 0) => {
  dev?.kill('SIGINT');
  await pg.stop().catch(() => {});
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  // The apps import the built shared packages (cached by Turborepo after the first run).
  log('Building shared packages…');
  run(['turbo', 'run', 'build', '--filter=@harmoniq/registry^...', '--filter=@harmoniq/web^...'], {
    stdio: 'ignore',
  });
  log('Applying migrations…');
  run(['--filter', '@harmoniq/db', 'exec', 'prisma', 'migrate', 'deploy'], { stdio: 'ignore' });
  if (fresh) {
    log('Adding demo data…');
    run(['--filter', '@harmoniq/db', 'exec', 'prisma', 'db', 'seed'], { stdio: 'ignore' });
  }
} catch (err) {
  console.error(`[dev:local] ${err.message}`);
  await stop(1);
}

log('Starting the registry (:4000) and the dashboard (http://localhost:3000)…');
log('Sign in with "Development login" and any email. Ctrl+C stops everything.');
dev = spawn(
  'pnpm',
  [
    'turbo',
    'run',
    'dev',
    '--filter=@harmoniq/registry',
    '--filter=@harmoniq/web',
    '--env-mode=loose',
  ],
  {
    cwd: root,
    env,
    stdio: 'inherit',
  }
);
dev.on('exit', (code) => stop(code ?? 0));
