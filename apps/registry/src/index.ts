// Must come first: instruments modules as they are loaded.
import './tracing';
import { buildApp } from './app';
import { ConfigError } from './config';

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
