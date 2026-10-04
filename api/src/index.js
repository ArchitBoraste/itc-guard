import { createApp } from './app.js';
import { config } from './config.js';
import { ping, closePool } from './db/pool.js';
import { startDemoTenancy } from './services/demoTenancy.js';
import { startMailPoller } from './services/mailInbox.js';

const app = createApp({ pingDb: ping });

// Fills the pre-seeded org pool and deletes orgs nobody has touched. Started here
// rather than in app.js so importing the app in a test never starts a timer.
// No-op unless DEMO_TENANCY=on.
const stopDemoTenancy = startDemoTenancy();

// Supplier replies from the trader's mailbox. No-op unless SMTP and IMAP are set.
const stopMailPoller = startMailPoller();

const server = app.listen(config.port, () => {
  console.log(`itc-guard api listening on :${config.port} (${config.env})`);
  console.log(`db ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopDemoTenancy();
    stopMailPoller();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
