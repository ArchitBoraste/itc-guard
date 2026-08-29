// What a client is allowed to be told when something breaks.
//
// The failure this pins is specific and easy to reintroduce: the responder used
// to send `err.message` for every error at every status. A mysql2 error's message
// contains the failing statement, so a malformed query anywhere in the app
// answered a public HTTP request with the schema and the SQL. Reproduced exactly:
//
//   ER_PARSE_ERROR ... near 'rows FROM information_schema.tables WHERE
//   table_schema='itc_guard' ORDER BY (dat' at line 1
//
// The rule now is not "redact 5xx". It is "redact what we did not write", because
// the capacity refusal is a 503 whose message is the only thing a turned-away
// visitor has to go on, and the 4xx validation messages are the UI's error copy.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';

import { createApp } from '../src/app.js';
import { ServiceError } from '../src/services/ingest.js';

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

// A mysql2 error, shaped like the real thing.
function databaseError() {
  const err = new Error(
    "You have an error in your SQL syntax; check the manual ... near 'rows FROM " +
      "information_schema.tables WHERE table_schema='itc_guard'' at line 1"
  );
  err.code = 'ER_PARSE_ERROR';
  err.errno = 1064;
  err.sqlState = '42000';
  err.sql = "SELECT table_name, table_rows AS rows FROM information_schema.tables";
  return err;
}

// A capacity refusal, shaped like claimSession()'s.
function capacityError() {
  const err = new Error('the demo is at capacity right now — a few sessions are already open.');
  err.status = 503;
  err.code = 'demo_at_capacity';
  err.expose = true;
  return err;
}

// The REAL app, with its real error responder, plus four routes that throw the
// four shapes of error on demand. mountApi is off so none of this needs a
// database — the responder is what is under test, not the endpoints.
function harness() {
  const boom = express.Router();
  boom.get('/boom/db', () => {
    throw databaseError();
  });
  boom.get('/boom/capacity', () => {
    throw capacityError();
  });
  boom.get('/boom/validation', () => {
    throw new ServiceError('taxPeriod must be YYYY-MM');
  });
  boom.get('/boom/bare', () => {
    throw new Error('an unlabelled crash with internals: /app/api/src/secret.js');
  });

  return createApp({ pingDb: async () => true, mountApi: false, extraRoutes: boom });
}

let server;
let base;
const originalEnv = process.env.NODE_ENV;

beforeAll(async () => {
  server = await listen(harness());
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

afterAll(async () => {
  process.env.NODE_ENV = originalEnv;
  if (server) await new Promise((resolve) => server.close(resolve));
});

const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

describe('in production', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'production';
  });

  it('tells a client nothing about a database failure', async () => {
    process.env.NODE_ENV = 'production';
    const { status, body } = await get('/boom/db');

    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'internal_error',
      message: 'something went wrong on our side — this has been logged'
    });

    // The specific leaks, named so a regression says which one came back.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/SELECT|FROM|information_schema|table_schema/i);
    expect(serialised).not.toMatch(/ER_PARSE_ERROR/);
    expect(serialised).not.toMatch(/itc_guard/);
  });

  it('redacts an unlabelled throw, including any path in it', async () => {
    process.env.NODE_ENV = 'production';
    const { status, body } = await get('/boom/bare');
    expect(status).toBe(500);
    expect(body.error).toBe('internal_error');
    expect(JSON.stringify(body)).not.toMatch(/src|secret\.js|\/app/);
  });

  it('still says why a request was refused', async () => {
    process.env.NODE_ENV = 'production';
    const { status, body } = await get('/boom/validation');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad_request', message: 'taxPeriod must be YYYY-MM' });
  });

  it('still says the demo is full, even though that is a 503', async () => {
    process.env.NODE_ENV = 'production';
    const { status, body } = await get('/boom/capacity');
    expect(status).toBe(503);
    expect(body.error).toBe('demo_at_capacity');
    expect(body.message).toMatch(/capacity/i);
  });

  it('does not advertise the framework', async () => {
    process.env.NODE_ENV = 'production';
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('outside production', () => {
  it('shows the real cause, so a failing test is debuggable', async () => {
    process.env.NODE_ENV = 'test';
    const { status, body } = await get('/boom/db');
    expect(status).toBe(500);
    expect(body.error).toBe('ER_PARSE_ERROR');
    expect(body.message).toMatch(/SQL syntax/);
  });
});
