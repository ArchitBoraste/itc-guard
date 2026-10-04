// Contacts without a database: the WhatsApp link, and how a register's rows
// become one contact per supplier.
import { describe, expect, it } from 'vitest';
import {
  contactView,
  contactsFromRegister,
  whatsappLink,
  whatsappNumber
} from '../../src/services/supplierContacts.js';

describe('whatsappNumber', () => {
  it.each([
    ['+91 98200 12345', '919820012345'],
    ['098200-12345', '919820012345'],
    ['9820012345', '919820012345'],
    ['917021012345', '917021012345']
  ])('reads %j as %s', (phone, digits) => {
    expect(whatsappNumber(phone)).toBe(digits);
  });

  it.each([
    ['the demo placeholder', '+91 00000 00001'],
    ['a landline-shaped number', '+91 22 2345 6789'],
    ['too short', '98200'],
    ['another country', '+44 7700 900123'],
    ['nothing', null],
    ['blank', '']
  ])('is null for %s', (_label, phone) => {
    expect(whatsappNumber(phone)).toBeNull();
  });
});

describe('whatsappLink', () => {
  it('builds a wa.me link with the text encoded', () => {
    expect(whatsappLink('+91 98200 12345', 'Hello,\nINV-0801 & GT/0145')).toBe(
      'https://wa.me/919820012345?text=Hello%2C%0AINV-0801%20%26%20GT%2F0145'
    );
    expect(whatsappLink('9820012345')).toBe('https://wa.me/919820012345');
  });

  it('is null for a missing or placeholder number', () => {
    expect(whatsappLink(null, 'hello')).toBeNull();
    expect(whatsappLink('+91 00000 00007', 'hello')).toBeNull();
  });
});

describe('contactsFromRegister', () => {
  it('keeps, per field, the last value the file gives each supplier', () => {
    const contacts = contactsFromRegister([
      { supplierGstin: 'A', supplierContact: { person: 'Ravi', phone: '9820012345', email: null } },
      { supplierGstin: 'A', supplierContact: { person: null, phone: '9820099999', email: 'a@example.org' } },
      { supplierGstin: 'B', supplierContact: null },
      { supplierGstin: 'C', supplierContact: { person: 'Meena', phone: null, email: null } }
    ]);
    expect([...contacts]).toEqual([
      ['A', { person: 'Ravi', phone: '9820099999', email: 'a@example.org' }],
      ['C', { person: 'Meena', phone: null, email: null }]
    ]);
  });
});

describe('contactView', () => {
  it('is null when nothing is known, and carries the WhatsApp number when it is a mobile', () => {
    expect(contactView({ contact_person: null, contact_phone: null, contact_email: null })).toBeNull();
    expect(contactView({ contact_person: 'Ravi', contact_phone: '9820012345', contact_email: null, contact_source: 'USER' }))
      .toMatchObject({ person: 'Ravi', phone: '9820012345', source: 'USER', whatsapp: '919820012345' });
  });
});
