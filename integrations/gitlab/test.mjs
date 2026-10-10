// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the component's job script (inputs interpolated as GitLab would) with a stub CLI
 * and checks the dotenv outputs, the log card and exit codes.
 *
 *   node integrations/gitlab/test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The CLI's YAML parser; no dependency of its own here.
const YAML = createRequire(join(here, '../../packages/cli/package.json'))('yaml');

const [specDoc, jobDoc] = readFileSync(join(here, 'templates/deploy.yml'), 'utf8').split('\n---\n');
const spec = YAML.parse(specDoc).spec.inputs;

function job(inputs) {
  const values = Object.fromEntries(
    Object.entries(spec).map(([name, def]) => [name, inputs[name] ?? def.default])
  );
  for (const [name, def] of Object.entries(spec)) {
    if (values[name] === undefined) throw new Error(`input ${name} is required`);
    if (def.options && !def.options.includes(values[name])) throw new Error(`bad ${name}`);
  }
  const text = jobDoc.replace(/\$\[\[ inputs\.([\w-]+) \]\]/g, (_, name) => String(values[name]));
  return Object.values(YAML.parse(text))[0];
}

const stub = `#!/bin/sh
case "$FAKE" in
  deployed) echo '{"id":"v1","version":"1.2.3","deployedAt":"2026-10-10T09:00:00.000Z","manifestUrl":"https://reg/m","changeUrl":"https://app/c"}' ;;
  pending) echo '{"status":"pending_approval","requestId":"req1","requiredApprovers":2,"expiresAt":"2026-10-11T09:00:00.000Z","approvalUrl":"https://app/a"}'; exit 6 ;;
  approved) echo 'Waiting for approval of request req9…' >&2; echo '{"id":"v2","version":"1.2.3","manifestUrl":"https://reg/m","changeUrl":"https://app/c"}' ;;
  frozen) echo 'production is frozen' >&2; exit 4 ;;
esac
echo "$@" > args.txt
`;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) {
    failures++;
    console.error(`✗ ${name}: ${detail}`);
  }
};

function run(fake, inputs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'harmoniq-gitlab-'));
  writeFileSync(join(dir, 'cli'), stub);
  chmodSync(join(dir, 'cli'), 0o755);
  const j = job({
    'registry-url': 'https://reg',
    workspace: 'acme',
    module: 'checkout',
    environment: 'production',
    version: '1.2.3',
    url: 'https://cdn/x.js',
    ...inputs,
  });
  // GitLab expands variables that reference others (the api-key default).
  const base = { ...process.env, HARMONIQ_API_KEY: 'hq_key_secret', FAKE: fake };
  const vars = Object.fromEntries(
    Object.entries(j.variables).map(([k, v]) => [
      k,
      String(v).replace(/\$(\w+)/g, (_, n) => base[n] ?? ''),
    ])
  );
  vars.HQ_CLI = join(dir, 'cli');
  const res = spawnSync('sh', ['-e', '-c', j.script.join('\n')], {
    cwd: dir,
    env: { ...base, ...vars },
    encoding: 'utf8',
  });
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const out = {
    code: res.status,
    log: res.stdout,
    env: read('harmoniq.env'),
    args: read('args.txt'),
    job: j,
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const deployed = run('deployed');
check('deployed exit', deployed.code === 0, deployed.code);
check(
  'deployed outputs',
  deployed.env.includes('HARMONIQ_MANIFEST_URL=https://reg/m'),
  deployed.env
);
check(
  'deployed at',
  deployed.env.includes('HARMONIQ_DEPLOYED_AT=2026-10-10T09:00:00.000Z'),
  deployed.env
);
check('deployed status', deployed.env.includes('HARMONIQ_STATUS=deployed'), deployed.env);
check('deployed card', /Diff\s+https:\/\/app\/c/.test(deployed.log), deployed.log);
check(
  'deployed args',
  deployed.args.includes(
    '--json deploy --module checkout --env production --release 1.2.3 --url https://cdn/x.js'
  ),
  deployed.args
);
check(
  'api key from variable',
  deployed.job.variables.HQ_API_KEY === '$HARMONIQ_API_KEY',
  deployed.job.variables.HQ_API_KEY
);
check(
  'environment url',
  deployed.job.environment.url === '$HARMONIQ_CHANGE_URL',
  deployed.job.environment
);

const pending = run('pending', { 'change-ticket': 'OPS-1' });
check('pending exit', pending.code === 6, pending.code);
check(
  'pending outputs',
  pending.env.includes('HARMONIQ_APPROVAL_REQUEST_ID=req1') &&
    pending.env.includes('HARMONIQ_STATUS=pending-approval'),
  pending.env
);
check('pending card', pending.log.includes('waiting for 2 approval(s)'), pending.log);
check(
  'change ticket',
  pending.job.variables.HARMONIQ_CHANGE_TICKET === 'OPS-1',
  pending.job.variables
);

const approved = run('approved', { 'wait-for-approval': true });
check('approved exit', approved.code === 0, approved.code);
check('approved request', approved.env.includes('HARMONIQ_APPROVAL_REQUEST_ID=req9'), approved.env);
check('wait flag', approved.args.startsWith('--json --wait deploy'), approved.args);

const frozen = run('frozen');
check('frozen exit', frozen.code === 4, frozen.code);
check('frozen no outputs', frozen.env === '', frozen.env);
check('frozen card', frozen.log.includes('production is frozen'), frozen.log);

const promote = run('deployed', {
  'promote-from': 'staging',
  'dry-run': true,
  'environment-action': 'verify',
});
check(
  'promote args',
  promote.args.includes('promote --module checkout --from staging --to production'),
  promote.args
);
check('environment action', promote.job.environment.action === 'verify', promote.job.environment);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('GitLab component: all checks passed');
