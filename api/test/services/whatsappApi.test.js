// The WhatsApp Cloud API client (services/whatsappApi.js) against a fake Graph
// API: what is posted, what comes back, and Meta's errors in plain words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GraphError,
  explainGraphError,
  fetchTemplate,
  graphFailure,
  renderTemplate,
  sendTemplate,
  sendText,
  setGraphFetch,
  templateParameters
} from '../../src/services/whatsappApi.js';
import { DEFAULT_GRAPH_VERSION } from '../../src/config.js';

const ENV = {
  WHATSAPP_TOKEN: 'test-token-abc123',
  WHATSAPP_PHONE_NUMBER_ID: '1110001',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '2220002',
  WHATSAPP_TEMPLATE_NAME: 'itc_guard_chase'
};

let calls;
const fake = (respond) => setGraphFetch(async (url, options) => {
  calls.push({ url, ...options, json: options.body ? JSON.parse(options.body) : null });
  const { status = 200, body } = await respond(url, options);
  return { ok: status < 400, status, json: async () => body };
});

beforeEach(() => {
  calls = [];
  Object.assign(process.env, ENV);
});

afterEach(() => {
  setGraphFetch(null);
  for (const name of [...Object.keys(ENV), 'WHATSAPP_GRAPH_VERSION', 'WHATSAPP_TEMPLATE_LANGUAGE']) delete process.env[name];
});

describe('sending', () => {
  it('posts the template with its five body values and returns the wamid', async () => {
    fake(() => ({ body: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.T1', message_status: 'accepted' }] } }));
    const values = ['Rakesh', 'Sharma Electronics', 'NS-612', '13 Aug 2026', 'Please correct it.'];
    expect(await sendTemplate('919800000001', values)).toBe('wamid.T1');

    const [call] = calls;
    expect(call.url).toBe(`https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/1110001/messages`);
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer test-token-abc123');
    expect(call.json).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919800000001',
      type: 'template',
      template: {
        name: 'itc_guard_chase',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }]
      }
    });
  });

  it('posts free text without a link preview', async () => {
    fake(() => ({ body: { messages: [{ id: 'wamid.X9' }] } }));
    process.env.WHATSAPP_GRAPH_VERSION = 'v25.0';
    expect(await sendText('919800000001', 'Hello\nagain')).toBe('wamid.X9');
    expect(calls[0].url).toBe('https://graph.facebook.com/v25.0/1110001/messages');
    expect(calls[0].json).toMatchObject({ type: 'text', to: '919800000001', text: { preview_url: false, body: 'Hello\nagain' } });
  });

  it("names a template's parameters when it was made with named ones", () => {
    const named = { parameterFormat: 'NAMED', parameterNames: ['who', 'from', 'invoice', 'date', 'ask'] };
    expect(templateParameters(['a', 'b'], named)).toEqual([
      { type: 'text', parameter_name: 'who', text: 'a' },
      { type: 'text', parameter_name: 'from', text: 'b' }
    ]);
    expect(templateParameters(['a'], null)).toEqual([{ type: 'text', text: 'a' }]);
  });

  it("turns Meta's error body into a GraphError with its code, and a dead network into one without", async () => {
    fake(() => ({ status: 400, body: { error: { message: '(#131030) Recipient phone number not in allowed list', code: 131030 } } }));
    const refused = await sendText('919800000001', 'x').catch((err) => err);
    expect(refused).toBeInstanceOf(GraphError);
    expect(refused).toMatchObject({ metaCode: 131030, httpStatus: 400 });

    setGraphFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const offline = await sendText('919800000001', 'x').catch((err) => err);
    expect(offline).toMatchObject({ metaCode: null, httpStatus: null, title: 'unreachable' });

    fake(() => ({ body: { messages: [] } }));
    const unconfirmed = await sendText('919800000001', 'x').catch((err) => err);
    expect(explainGraphError(unconfirmed.metaCode, unconfirmed).code).toBe('whatsapp_unconfirmed');
  });
});

describe("Meta's errors in plain words", () => {
  it('names each failure the trader can act on', () => {
    expect(explainGraphError(190)).toMatchObject({ status: 502, code: 'whatsapp_token' });
    expect(explainGraphError(null, { httpStatus: 401 }).code).toBe('whatsapp_token');
    expect(explainGraphError(131030)).toMatchObject({ status: 403, code: 'whatsapp_recipient_not_allowed' });
    expect(explainGraphError(131030).message).toContain('allowed recipients');
    expect(explainGraphError(131047)).toMatchObject({ status: 409, code: 'whatsapp_window_closed' });
    expect(explainGraphError(131047).message).toContain('24 hours');
    expect(explainGraphError(132001)).toMatchObject({ code: 'whatsapp_template_not_approved' });
    expect(explainGraphError(132001).message).toContain('"itc_guard_chase" in language "en"');
    expect(explainGraphError(132000).code).toBe('whatsapp_template_parameters');
    expect(explainGraphError(130429)).toMatchObject({ status: 429, code: 'whatsapp_rate_limited' });
    expect(explainGraphError(null).code).toBe('whatsapp_unreachable');
    expect(explainGraphError(999999)).toMatchObject({ status: 502, code: 'whatsapp_send_failed' });
    expect(explainGraphError(999999).message).toContain('Meta error 999999');
  });

  it('gives a short reason for a delivery that failed later', () => {
    expect(explainGraphError(131047).short).toBe('more than 24 hours since they last wrote');
    expect(explainGraphError(131026).short).toContain('could not deliver');
    expect(explainGraphError(888, { title: 'Something odd' }).short).toBe('Something odd (Meta error 888)');
  });

  it('logs the code only, never the token', () => {
    const lines = [];
    const original = console.error;
    console.error = (line) => lines.push(String(line));
    try {
      const error = graphFailure(new GraphError(190, { httpStatus: 401 }));
      expect(error).toMatchObject({ status: 502, code: 'whatsapp_token', expose: true });
    } finally {
      console.error = original;
    }
    expect(lines.join('\n')).toContain('Meta error 190');
    expect(lines.join('\n')).not.toContain(ENV.WHATSAPP_TOKEN);
  });
});

describe('the template', () => {
  const listing = {
    data: [
      { name: 'itc_guard_chase', language: 'en_US', status: 'APPROVED', components: [] },
      {
        name: 'itc_guard_chase',
        language: 'en',
        status: 'APPROVED',
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'GST invoice' },
          { type: 'BODY', text: 'Hello {{1}}, this is {{2}}. About invoice {{3}} dated {{4}}: {{5}}' }
        ]
      }
    ]
  };

  it('reads the one in the configured language, renders it, and caches it', async () => {
    fake(() => ({ body: listing }));
    const template = await fetchTemplate();
    expect(template).toMatchObject({ status: 'APPROVED', language: 'en', parameterFormat: 'POSITIONAL' });
    expect(calls[0].url).toContain(`/${DEFAULT_GRAPH_VERSION}/2220002/message_templates?name=itc_guard_chase`);
    expect(renderTemplate(template, ['Rakesh', 'Sharma Electronics', 'NS-612', '13 Aug 2026', 'Please fix it.'])).toBe(
      'Hello Rakesh, this is Sharma Electronics. About invoice NS-612 dated 13 Aug 2026: Please fix it.'
    );
    await fetchTemplate();
    expect(calls).toHaveLength(1);
  });

  it('says MISSING when there is no such name in that language, and knows named variables', async () => {
    process.env.WHATSAPP_TEMPLATE_LANGUAGE = 'hi';
    fake(() => ({ body: listing }));
    expect((await fetchTemplate()).status).toBe('MISSING');

    setGraphFetch(null);
    process.env.WHATSAPP_TEMPLATE_LANGUAGE = 'en';
    fake(() => ({
      body: {
        data: [{
          name: 'itc_guard_chase', language: 'en', status: 'PENDING', parameter_format: 'NAMED',
          components: [{ type: 'BODY', text: 'Hi {{who}}, {{from}} here about {{invoice}} ({{date}}). {{ask}} Thanks {{who}}' }]
        }]
      }
    }));
    const named = await fetchTemplate();
    expect(named).toMatchObject({ status: 'PENDING', parameterFormat: 'NAMED', parameterNames: ['who', 'from', 'invoice', 'date', 'ask'] });
    expect(renderTemplate(named, ['A', 'B', 'C', 'D', 'E.'])).toBe('Hi A, B here about C (D). E. Thanks A');
  });

  it('is not read without a business account id', async () => {
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    fake(() => ({ body: listing }));
    expect(await fetchTemplate()).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
