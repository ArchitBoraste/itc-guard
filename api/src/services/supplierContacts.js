// Who to call at each supplier: the person, the phone and the email the chase
// message goes to.
//
// Two ways in, and the latest write wins either way:
//   REGISTER  the purchase register's optional contact columns, on every commit.
//             A blank cell never erases what is stored: a register that leaves
//             the columns out has said nothing about the contact.
//   USER      the trader typing it in (PUT /api/suppliers/:gstin/contact), the
//             only way for a supplier who is on the portal but not in the books.
//
// Stored per GSTIN (supplier_contacts), apart from the supplier master, which is
// rebuilt from the data on every run.
import { pool } from '../db/pool.js';
import { insertInChunks } from '../db/tx.js';
import { ServiceError } from './ingest.js';

// --- WhatsApp ----------------------------------------------------------------

// The digits wa.me wants for an Indian mobile number (91 + ten digits starting
// 6-9), or null. Accepts the ways a register writes one: +91 98765 43210,
// 098765-43210, 9876543210. Anything else, including the placeholder
// "+91 00000 000NN" the committed demo files carry, is null: a link to a number
// that cannot be a phone is worse than no link.
export function whatsappNumber(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length !== 12 || !digits.startsWith('91')) return null;
  return /^[6-9]\d{9}$/.test(digits.slice(2)) ? digits : null;
}

// https://wa.me/<digits>?text=<urlencoded>, or null when the number is missing or
// not a mobile number.
export function whatsappLink(phone, text = '') {
  const number = whatsappNumber(phone);
  if (!number) return null;
  return text ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : `https://wa.me/${number}`;
}

// --- reading -------------------------------------------------------------------

// A supplier_contacts row (columns as the queries alias them) -> the API shape,
// or null when there is no contact at all.
export function contactView(row) {
  if (!row || (!row.contact_person && !row.contact_phone && !row.contact_email)) return null;
  return {
    person: row.contact_person ?? null,
    phone: row.contact_phone ?? null,
    email: row.contact_email ?? null,
    source: row.contact_source ?? null,
    updatedAt: row.contact_updated_at ?? null,
    whatsapp: whatsappNumber(row.contact_phone)
  };
}

// The columns contactView() reads, from supplier_contacts aliased sc.
export const CONTACT_COLUMNS =
  'sc.contact_person, sc.phone AS contact_phone, sc.email AS contact_email, ' +
  'sc.source AS contact_source, sc.updated_at AS contact_updated_at';

// gstin -> contactView, for every supplier with one.
export async function contactsByGstin(orgId) {
  const [rows] = await pool.query(`SELECT sc.gstin, ${CONTACT_COLUMNS} FROM supplier_contacts sc WHERE sc.org_id = ?`, [orgId]);
  return new Map(rows.map((row) => [row.gstin, contactView(row)]));
}

// --- from the register -----------------------------------------------------------

// gstin -> { person, phone, email } from a register's documents: per field, the
// last non-blank value the file carries for that supplier.
export function contactsFromRegister(invoices) {
  const contacts = new Map();
  for (const invoice of invoices) {
    if (!invoice.supplierContact) continue;
    const current = contacts.get(invoice.supplierGstin) ?? { person: null, phone: null, email: null };
    for (const field of ['person', 'phone', 'email']) {
      current[field] = invoice.supplierContact[field] ?? current[field];
    }
    contacts.set(invoice.supplierGstin, current);
  }
  return contacts;
}

// Inside the register commit's transaction, so a register and the contacts it
// carries land together or not at all.
export async function saveRegisterContacts(connection, orgId, uploadId, invoices) {
  const contacts = contactsFromRegister(invoices);
  if (!contacts.size) return 0;
  await insertInChunks(
    connection,
    `INSERT INTO supplier_contacts (org_id, gstin, contact_person, phone, email, source, upload_id)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       contact_person = COALESCE(VALUES(contact_person), contact_person),
       phone = COALESCE(VALUES(phone), phone),
       email = COALESCE(VALUES(email), email),
       source = VALUES(source),
       upload_id = VALUES(upload_id)`,
    [...contacts].map(([gstin, contact]) => [
      orgId, gstin, contact.person?.slice(0, 255) ?? null, contact.phone?.slice(0, 32) ?? null,
      contact.email?.slice(0, 255) ?? null, 'REGISTER', uploadId
    ])
  );
  return contacts.size;
}

// --- typed in by the trader --------------------------------------------------------

const LIMITS = { contactPerson: 255, phone: 32, email: 255 };

function cleanField(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ServiceError(`${field} must be text`);
  const text = value.trim();
  if (text.length > LIMITS[field]) throw new ServiceError(`${field} is longer than ${LIMITS[field]} characters`);
  return text || null;
}

// The supplier a GSTIN names in this org: itself when the books or the portal carry
// it, the supplier it belongs to when it is a recorded typo, else 404.
async function knownSupplierGstin(orgId, gstin) {
  const [rows] = await pool.query(
    `SELECT COALESCE(
       (SELECT gstin FROM supplier_gstin_aliases WHERE org_id = ? AND alias_gstin = ?),
       (SELECT supplier_gstin FROM expected_invoices WHERE org_id = ? AND supplier_gstin = ? LIMIT 1),
       (SELECT supplier_gstin FROM portal_records WHERE org_id = ? AND supplier_gstin = ? LIMIT 1)
     ) AS gstin`,
    [orgId, gstin, orgId, gstin, orgId, gstin]
  );
  if (!rows[0].gstin) throw new ServiceError('supplier not found', 404, 'not_found');
  return rows[0].gstin;
}

// setSupplierContact(orgId, gstin, { contactPerson, phone, email }) -> { gstin, contact }
//
// The three fields as the trader wants them now: an omitted or empty one is
// cleared, and all three empty removes the contact.
export async function setSupplierContact(orgId, gstinValue, body) {
  const person = cleanField(body, 'contactPerson');
  const phone = cleanField(body, 'phone');
  const email = cleanField(body, 'email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ServiceError(`email does not look like an email address: ${JSON.stringify(email)}`);
  }
  const gstin = await knownSupplierGstin(orgId, gstinValue);

  if (!person && !phone && !email) {
    await pool.query('DELETE FROM supplier_contacts WHERE org_id = ? AND gstin = ?', [orgId, gstin]);
    return { gstin, contact: null };
  }
  await pool.query(
    `INSERT INTO supplier_contacts (org_id, gstin, contact_person, phone, email, source, upload_id)
     VALUES (?, ?, ?, ?, ?, 'USER', NULL)
     ON DUPLICATE KEY UPDATE contact_person = VALUES(contact_person), phone = VALUES(phone),
       email = VALUES(email), source = 'USER', upload_id = NULL`,
    [orgId, gstin, person, phone, email]
  );
  return { gstin, contact: (await contactsByGstin(orgId)).get(gstin) ?? null };
}
