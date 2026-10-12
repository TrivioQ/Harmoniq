// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

// Must come first: instruments modules as they are loaded.
import './tracing';
import { buildApp } from './app';
import { ConfigError } from './config';
import { appRoleAcceptsPlaceholder } from './services/dbRoleCheck';

async function start() {
  let app;
  try {
    app = await buildApp();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Refusing to start: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // MT-11: a production database whose app role still has the placeholder password.
  if (
    app.config.isProduction &&
    (await appRoleAcceptsPlaceholder(process.env.DATABASE_URL ?? ''))
  ) {
    console.error(
      'Refusing to start: the database role in DATABASE_URL accepts the placeholder password. ' +
        'Set its password with `npx tsx scripts/bootstrap-db.ts` (see docs/self-hosting.md).'
    );
    process.exit(1);
  }

  try {
    await app.listen({ port: app.config.port, host: '0.0.0.0' });
    console.log(`Server listening on port ${app.config.port}`);

    // First boot: point the operator at the setup wizard (INST-01).
    if ((await app.container.systemDb.instanceAdmin.count()) === 0) {
      console.log(
        app.config.setupToken
          ? `No instance admin yet: open ${app.config.webOrigin}/admin/setup and enter HARMONIQ_SETUP_TOKEN.`
          : 'No instance admin yet: set HARMONIQ_SETUP_TOKEN and open /admin/setup in the dashboard.'
      );
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
