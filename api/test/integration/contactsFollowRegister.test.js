// A supplier's contact follows the latest register, everywhere it is shown.
//
// The trader uploads August's register again with Mahavir's phone and email
// changed. Suppliers, the IMS decision's message (and its WhatsApp link), Not
// filed yet and the supplier detail all carry the new contact at once: contacts
// are stored per GSTIN and read live, never copied into a run.
//
// Driven over HTTP with the live demo's August files. Owns org 34.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { SUPPLIERS, placeholderContact } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';
import { registerWithContacts } from '../helpers/registerCopy.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.contactsFollowRegister;
const AUGUST = '2026-08';
const MAHAVIR = SUPPLIERS.find((supplier) => supplier.key === 'mahavir');
const NEW_CONTACT = { person: 'Rakesh Shah', phone: '+91 98201 44556', email: 'accounts@mahavir.example' };

let api;

async function mahavirResult() {
  const { body } = await api.call('GET', `/api/runs?taxPeriod=${AUGUST}`);
  const results = (await api.call('GET', `/api/runs/${body.run.id}/results?pageSize=500`)).body.results;
  return results.find((row) => row.books?.invoiceNo === 'MS-878');
}

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);
  await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-11' });
  expect((await api.ingest('PURCHASE_REGISTER', demoRegister('aug'))).status).toBe(200);
  expect((await api.ingest('IMS', demoIms('aug', '2026-09-11'))).status).toBe(200);
  expect((await api.call('POST', '/api/runs', { taxPeriod: AUGUST })).status).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await closePool();
});

describe('a re-uploaded register with a changed contact', () => {
  it('starts from the contact the first register carried', async () => {
    const result = await mahavirResult();
    expect(result.supplierContact).toMatchObject({ email: placeholderContact(MAHAVIR).email, whatsapp: null });
    expect(result.message.whatsappUrl).toBeNull();
  });

  it('replaces the phone and email on every screen that shows them', async () => {
    const copy = registerWithContacts(demoRegister('aug'), { [MAHAVIR.gstin]: NEW_CONTACT }, 'mahavir-contact');
    expect((await api.ingest('PURCHASE_REGISTER', copy)).status).toBe(200);

    const supplier = (await api.call('GET', `/api/suppliers?taxPeriod=${AUGUST}`)).body.suppliers
      .find((row) => row.gstin === MAHAVIR.gstin);
    expect(supplier.contact).toMatchObject({
      person: NEW_CONTACT.person, phone: NEW_CONTACT.phone, email: NEW_CONTACT.email,
      source: 'REGISTER', whatsapp: '919820144556'
    });

    const detail = (await api.call('GET', `/api/suppliers/${MAHAVIR.gstin}`)).body.supplier;
    expect(detail.contact.email).toBe(NEW_CONTACT.email);

    // The IMS decision's message: greeting, and the WhatsApp link to the new number.
    const result = await mahavirResult();
    expect(result.supplierContact).toMatchObject({ phone: NEW_CONTACT.phone, email: NEW_CONTACT.email });
    expect(result.message.text.startsWith('Hello Rakesh ji,')).toBe(true);
    expect(result.message.whatsappUrl).toBe(
      `https://wa.me/919820144556?text=${encodeURIComponent(result.message.text)}`
    );
  });

  it('is the contact a later register leaves alone when its cells are blank', async () => {
    const blank = registerWithContacts(demoRegister('aug'), {
      [MAHAVIR.gstin]: { person: '', phone: '', email: '' }
    }, 'mahavir-blank');
    expect((await api.ingest('PURCHASE_REGISTER', blank)).status).toBe(200);
    const result = await mahavirResult();
    expect(result.supplierContact).toMatchObject({ phone: NEW_CONTACT.phone, email: NEW_CONTACT.email });
  });
});
