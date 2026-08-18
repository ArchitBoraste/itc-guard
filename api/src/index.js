import { createApp } from './app.js';
import { config } from './config.js';
import { ping, closePool } from './db/pool.js';

const app = createApp({ pingDb: ping });

const server = app.listen(config.port, () => {
  console.log(`itc-guard api listening on :${config.port} (${config.env})`);
  console.log(`db ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
