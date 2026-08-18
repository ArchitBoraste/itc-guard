import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

// Boot the app on an ephemeral port with a fake db ping — no MySQL needed.
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

describe('GET /health', () => {
  let okServer;
  let downServer;

  beforeAll(async () => {
    okServer = await listen(createApp({ pingDb: async () => true }));
    downServer = await listen(
      createApp({
        pingDb: async () => {
          throw new Error('ECONNREFUSED');
        }
      })
    );
  });

  afterAll(async () => {
    for (const server of [okServer, downServer]) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports ok when the db answers', async () => {
    const res = await fetch(`http://127.0.0.1:${okServer.address().port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
  });

  it('reports 503 when the db is unreachable', async () => {
    const res = await fetch(`http://127.0.0.1:${downServer.address().port}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
  });

  it('404s an unknown route', async () => {
    const res = await fetch(`http://127.0.0.1:${okServer.address().port}/nope`);
    expect(res.status).toBe(404);
  });
});
