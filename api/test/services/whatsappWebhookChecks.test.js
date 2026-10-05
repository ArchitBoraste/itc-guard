// The webhook's two gates (services/whatsappWebhook.js): the signature over the
// raw body, and Meta's subscription check. Pure: no database, no network.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { subscriptionChallenge, verifySignature } from '../../src/services/whatsappWebhook.js';

const SECRET = 'test-app-secret';
const BODY = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

afterEach(() => {
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

describe('the signature', () => {
  it('accepts the HMAC-SHA256 of the exact raw body under the app secret', () => {
    expect(verifySignature(BODY, sign(BODY), SECRET)).toBe(true);
    expect(verifySignature(BODY, sign(BODY).toUpperCase().replace('SHA256=', 'sha256='), SECRET)).toBe(true);
  });

  it('refuses another secret, a changed body, a re-serialised body, and anything malformed', () => {
    expect(verifySignature(BODY, sign(BODY, 'other-secret'), SECRET)).toBe(false);
    expect(verifySignature(Buffer.from(`${BODY} `), sign(BODY), SECRET)).toBe(false);
    // The same JSON with different whitespace is a different body.
    const pretty = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 2));
    expect(verifySignature(pretty, sign(BODY), SECRET)).toBe(false);
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignature(BODY, sign(BODY).replace('sha256=', 'sha1='), SECRET)).toBe(false);
    expect(verifySignature(BODY, sign(BODY).slice(0, -2), SECRET)).toBe(false);
    expect(verifySignature(BODY, sign(BODY), '')).toBe(false);
  });
});

describe("Meta's subscription check", () => {
  const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'my-verify-token', 'hub.challenge': '1158201444' };

  it('echoes the challenge only for the configured verify token', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'my-verify-token';
    expect(subscriptionChallenge(query)).toBe('1158201444');
    expect(subscriptionChallenge({ ...query, 'hub.verify_token': 'guess' })).toBeNull();
    expect(subscriptionChallenge({ ...query, 'hub.mode': 'unsubscribe' })).toBeNull();
    expect(subscriptionChallenge({ ...query, 'hub.challenge': undefined })).toBeNull();
  });

  it('refuses everything while no verify token is set', () => {
    expect(subscriptionChallenge({ ...query, 'hub.verify_token': '' })).toBeNull();
    expect(subscriptionChallenge(query)).toBeNull();
  });
});
