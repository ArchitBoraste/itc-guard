// The real Express app for one reserved org, driven over HTTP.
//
// Route tests need the whole request path (multer, the error responder, the
// rerun after a commit) but must never touch org 1, so auth is injected the way
// apiRouter() allows. Nothing here manages cookies: tenancy has its own suite.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createApp } from '../../src/app.js';

export async function startApi(orgId) {
  const app = createApp({
    pingDb: async () => true,
    auth: (req, res, next) => {
      req.orgId = orgId;
      req.userId = null;
      req.sessionState = 'READY';
      next();
    }
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  // POST /api/uploads with a file from disk, as the Upload screen sends it.
  async function upload(kind, path, { taxPeriod = null } = {}) {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', new Blob([readFileSync(path)]), basename(path));
    if (taxPeriod) form.append('taxPeriod', taxPeriod);
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  }

  // Upload, then commit: what dropping a file on the Upload screen does.
  async function ingest(kind, path, options) {
    const created = await upload(kind, path, options);
    if (created.status !== 201) return created;
    return call('POST', `/api/uploads/${created.body.upload.id}/commit`, {});
  }

  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, call, upload, ingest, close };
}
