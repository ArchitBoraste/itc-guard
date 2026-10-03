// Supplier contacts, end to end.
//
//   * The register's contact columns are stored per supplier; the latest upload
//     wins, and a blank cell never erases what is known.
//   * A supplier the trader booked from is a supplier before they report
//     anything: listed, contactable, and their scheme can be set.
//   * The trader sets a contact for a portal-only supplier (PUT), and the
//     suppliers, results and alerts APIs carry it, with a WhatsApp link only for
//     a real mobile number.
//
// Driven over HTTP with the live demo's August files. Owns org 27.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool } from '../../src/db/pool.js';
import { ensureOrg } from '../../src/services/demo.js';
import { SUPPLIERS, placeholderContact } from '../../../tools/demo-timeline.js';
import { TEST_ORGS, requireDatabase, resetOrg } from '../helpers/db.js';
import { demoIms, demoRegister } from '../helpers/demoFiles.js';
import { startApi } from '../helpers/http.js';

const ORG_ID = TEST_ORGS.supplierContacts;
const AUGUST = '2026-08';
const supplierOf = (key) => SUPPLIERS.find((supplier) => supplier.key === key);
const ORBIT = supplierOf('orbit');
const KRISHNA = supplierOf('krishna');
const RELIABLE = supplierOf('reliable');

let api;

async function suppliers() {
  return (await api.call('GET', `/api/suppliers?taxPeriod=${AUGUST}`)).body.suppliers;
}
const supplierRow = async (gstin) => (await suppliers()).find((row) => row.gstin === gstin);

beforeAll(async () => {
  await requireDatabase();
  await ensureOrg(ORG_ID);
  await resetOrg(ORG_ID);
  api = await startApi(ORG_ID);
});

afterAll(async () => {
  await api?.close();
  await closePool();
});

describe('contacts from the register', () => {
  it("lets a supplier's scheme be set as soon as the register is in, before any run", async () => {
    await api.call('PUT', '/api/workspace/clock', { asOfDate: '2026-09-11' });
    const committed = await api.ingest('PURCHASE_REGISTER', demoRegister('aug'));
    expect(committed.status).toBe(200);
    expect(committed.body.contacts).toBe(11);

    const set = await api.call('PUT', `/api/suppliers/${KRISHNA.gstin}/filing-scheme`, { scheme: 'QRMP' });
    expect(set.status).toBe(200);
    expect(set.body.supplier).toMatchObject({ filingScheme: 'QRMP', filingSchemeSource: 'USER' });
  });

  it('lists every supplier booked from, with the contact the register carries', async () => {
    await api.ingest('IMS', demoIms('aug', '2026-09-11'));
    expect((await api.call('POST', '/api/runs', { taxPeriod: AUGUST })).status).toBe(201);

    // Krishna and Patel have reported nothing, and are on the list anyway.
    const all = await suppliers();
    expect(all.map((row) => row.gstin)).toEqual(expect.arrayContaining([KRISHNA.gstin, supplierOf('patel').gstin]));
    expect(all).toHaveLength(12);

    const orbit = all.find((row) => row.gstin === ORBIT.gstin);
    const placeholder = placeholderContact(ORBIT);
    expect(orbit.contact).toMatchObject({
      person: placeholder.person, phone: placeholder.phone, email: placeholder.email, source: 'REGISTER',
      // The placeholder is not a mobile number, so there is nothing to message.
      whatsapp: null
    });
    // Reliable is only on the portal: nobody has said who to call.
    expect(all.find((row) => row.gstin === RELIABLE.gstin).contact).toBeNull();
  });

  it('takes the latest upload, without a blank cell erasing anything', async () => {
    const dir = process.env.TMPDIR ?? process.env.TEMP ?? '/tmp';
    const path = join(dir, `register-contacts-${process.pid}.csv`);
    // September's register, so August's stays as it is.
    writeFileSync(path, [
      'GSTIN of Supplier,Invoice Number,Invoice date,Taxable Value,Supplier phone,Supplier email',
      `${ORBIT.gstin},INV-0902,2-Sep-26,40000,+91 98200 12345,`
    ].join('\n'));
    const committed = await api.ingest('PURCHASE_REGISTER', path, { taxPeriod: '2026-09' });
    expect(committed.status).toBe(200);

    const orbit = await supplierRow(ORBIT.gstin);
    expect(orbit.contact).toMatchObject({
      person: placeholderContact(ORBIT).person,
      phone: '+91 98200 12345',
      email: placeholderContact(ORBIT).email,
      whatsapp: '919820012345'
    });
  });
});

describe('a contact the trader sets', () => {
  it('reaches a portal-only supplier and every API that shows them', async () => {
    const put = await api.call('PUT', `/api/suppliers/${RELIABLE.gstin}/contact`, {
      contactPerson: 'Accounts desk',
      phone: '+91 70210 55555',
      email: 'accounts@reliable.example'
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      gstin: RELIABLE.gstin,
      contact: expect.objectContaining({ person: 'Accounts desk', source: 'USER', whatsapp: '917021055555' })
    });

    expect((await supplierRow(RELIABLE.gstin)).contact.phone).toBe('+91 70210 55555');
    const detail = (await api.call('GET', `/api/suppliers/${RELIABLE.gstin}`)).body.supplier;
    expect(detail.contact.email).toBe('accounts@reliable.example');

    const { body } = await api.call('GET', `/api/runs?taxPeriod=${AUGUST}`);
    const results = (await api.call('GET', `/api/runs/${body.run.id}/results?pageSize=500`)).body.results;
    const phantom = results.find((row) => row.portal?.supplierGstin === RELIABLE.gstin);
    expect(phantom.supplierContact).toMatchObject({ person: 'Accounts desk', whatsapp: '917021055555' });
  });

  it('puts a WhatsApp link carrying the chase message on the alert', async () => {
    await api.call('PUT', `/api/suppliers/${KRISHNA.gstin}/contact`, { phone: '9820012345' });
    const { body } = await api.call('GET', `/api/alerts?taxPeriod=${AUGUST}`);
    const krishna = body.alerts.suppliers.find((row) => row.gstin === KRISHNA.gstin);
    expect(krishna.contact.phone).toBe('9820012345');
    expect(krishna.whatsappUrl).toBe(`https://wa.me/919820012345?text=${encodeURIComponent(krishna.chaseMessage)}`);
    // Quarterly, so on the 11th they still have two days.
    expect(krishna.daysToCutOff).toBe(2);

    const patel = body.alerts.suppliers.find((row) => row.gstin === supplierOf('patel').gstin);
    expect(patel.whatsappUrl).toBeNull();
  });

  it('is cleared by sending it empty, and refused when it names nobody or a bad email', async () => {
    const cleared = await api.call('PUT', `/api/suppliers/${KRISHNA.gstin}/contact`, {});
    expect(cleared.body.contact).toBeNull();
    expect((await supplierRow(KRISHNA.gstin)).contact).toBeNull();

    const nobody = await api.call('PUT', '/api/suppliers/27AAAAA0000A1Z5/contact', { phone: '9820012345' });
    expect(nobody.status).toBe(404);
    const badEmail = await api.call('PUT', `/api/suppliers/${RELIABLE.gstin}/contact`, { email: 'not an email' });
    expect(badEmail.status).toBe(400);
  });
});
