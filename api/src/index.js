import { createApp } from './app.js';
import { config } from './config.js';
import { ping, closePool } from './db/pool.js';
import { startDemoTenancy } from './services/demoTenancy.js';

const app = createApp({ pingDb: ping });

// Fills the pre-seeded org pool and deletes orgs nobody has touched. Started here
// rather than in app.js so importing the app in a test never starts a timer.
// No-op unless DEMO_TENANCY=on.
const stopDemoTenancy = startDemoTenancy();

const server = app.listen(config.port, () => {
  console.log(`itc-guard api listening on :${config.port} (${config.env})`);
  console.log(`db ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopDemoTenancy();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
