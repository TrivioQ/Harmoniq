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
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
