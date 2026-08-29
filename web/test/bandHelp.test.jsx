// Group headers on Before cut-off must describe the suppliers underneath them.
//
// The bug, exactly as reported: at as-of 16 May 2026 — past the 11 May cut-off —
// the "Normal for this point in the month" header read "Not reported yet, and
// that is normal — GSTR-1 is not due until their cut-off", while Mahavir Sales
// Corp inside that same group showed a red "Cut-off passed" chip and a GSTR-1A
// consequence. The header said nothing was wrong; the card said the credit had
// slipped a month.
//
// Membership itself is now decided against the as-of date in the API — see
// alertBandFor() and the grouping tests in api/test/services/preventive.test.js,
// which is where that fix lives and is asserted end to end.
//
// What THIS file covers is the sentence above each group: given whatever set of
// suppliers the API grouped together, the header must describe that set rather
// than recite a fixed string. Cut-offs differ per supplier (11th monthly, 13th
// QRMP), so a group holding both kinds at once is a real case and not a
// contrived one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { listAlerts: vi.fn() } };
});

import { api } from '../src/api.js';
import { AlertsScreen } from '../src/screens/Alerts.jsx';
import { bandHelp } from '../src/lib/vocab.js';

const RUN = { id: 7, taxPeriod: '2026-04', asOfDate: '2026-05-16' };

// A supplier past their own cut-off — the Mahavir case.
const past = (gstin, tradeName, scheme = 'MONTHLY') => ({
  gstin,
  tradeName,
  filingScheme: scheme,
  filingSchemeConfidence: 'MEDIUM',
  filingSchemeReason: 'filings appear monthly',
  cutOffDate: scheme === 'QRMP' ? '2026-05-13' : '2026-05-11',
  daysToCutOff: -5,
  preCutOff: false,
  urgency: 'PAST_CUTOFF',
  urgencyRank: 5,
  // Past their cut-off but already in this band on their record, so the calendar
  // did not move them.
  escalated: false,
  risk: { band: 'LOW', score: 0, reasons: ['filed on time in all of the last 6 months'], features: {} },
  invoiceCount: 1,
  itcAtStake: 120000,
  statusCounts: { NOT_REPORTED: 1, SAVED_NOT_FILED: 0, SAVED_VALUE_MISMATCH: 0 },
  invoices: [
    {
      expectedInvoiceId: 1,
      status: 'NOT_REPORTED',
      invoiceNo: 'INV/1',
      invoiceDate: '2026-04-18',
      taxableValue: 1000000,
      totalTax: 120000,
      itcAtStake: 120000,
      deltaTotalTax: null,
      note: 'Not in IMS at all.'
    }
  ],
  headline: `${tradeName} — cut-off passed.`,
  consequence: 'Their cut-off has passed. A correction now reaches the next period via GSTR-1A.',
  chaseMessage: `To: ${tradeName}`
});

// A QRMP supplier whose 13th has NOT passed on the same date a monthly filer's
// 11th has. This is why "mixed" cannot be derived from the run's single date.
const inside = (gstin, tradeName) => ({
  ...past(gstin, tradeName, 'QRMP'),
  daysToCutOff: 6,
  preCutOff: true,
  urgency: 'EARLY',
  urgencyRank: 1,
  escalated: false,
  consequence: 'Their return is still a draft until 13 May 2026.'
});

const group = (name, suppliers) => ({
  band: name,
  supplierCount: suppliers.length,
  invoiceCount: suppliers.reduce((sum, s) => sum + s.invoiceCount, 0),
  itcAtStake: suppliers.reduce((sum, s) => sum + s.itcAtStake, 0),
  suppliers
});

const alerts = (bands) => ({
  taxPeriod: '2026-04',
  asOfDate: '2026-05-16',
  window: 'REACTIVE',
  orgCutOffDate: '2026-05-11',
  nextTaxPeriod: '2026-05',
  historyPeriods: [],
  totals: {
    supplierCount: bands.reduce((sum, b) => sum + b.supplierCount, 0),
    invoiceCount: bands.reduce((sum, b) => sum + b.invoiceCount, 0),
    itcAtStake: bands.reduce((sum, b) => sum + b.itcAtStake, 0),
    expectedInvoices: 10,
    imsRecords: 8
  },
  bands,
  suppliers: bands.flatMap((b) => b.suppliers)
});

const helpFor = (band) => screen.getByTestId(`band-help-${band}`).textContent;

beforeEach(() => {
  api.listAlerts.mockReset();
});

describe('bandHelp, on its own', () => {
  const A = { preCutOff: false };
  const B = { preCutOff: true };

  it('says nothing about the calendar it cannot support', () => {
    // preCutOff null means "could not be worked out", NOT "not passed". Counting
    // it as inside the window would reintroduce exactly the false reassurance
    // this function exists to remove.
    const text = bandHelp('LOW', [{ preCutOff: null }, { preCutOff: undefined }]);
    expect(text).not.toMatch(/cut-off/i);
    expect(text).toContain('Nothing in their filing record suggests a problem');
  });

  it('excludes unknowns from the count rather than guessing', () => {
    expect(bandHelp('HIGH', [A, B, { preCutOff: null }])).toMatch(/1 of 2 are past/);
  });

  it.each(['HIGH', 'MEDIUM', 'LOW', 'UNPROVEN'])(
    'reports the cut-off state for %s, whatever the band says about the record',
    (band) => {
      expect(bandHelp(band, [B, B])).toMatch(/None of them are past their own cut-off/);
      expect(bandHelp(band, [A, A])).toMatch(/All of them are past their own cut-off/);
      expect(bandHelp(band, [A, A, A, B, B, B, B])).toMatch(
        /3 of 7 are past their supplier's cut-off/
      );
    }
  );

  it('never claims a free fix once every supplier is past their cut-off', () => {
    for (const band of ['HIGH', 'MEDIUM', 'LOW', 'UNPROVEN']) {
      const text = bandHelp(band, [A, A]);
      expect(text).not.toMatch(/not due until/i);
      expect(text).not.toMatch(/today is free/i);
      expect(text).not.toMatch(/still time/i);
    }
  });
});

describe('a group holding suppliers the calendar moved into it', () => {
  const nativePast = { preCutOff: false, escalated: false };
  const movedIn = { preCutOff: false, escalated: true };
  const inside = { preCutOff: true, escalated: false };

  it('drops the record-based claim when every member was moved in', () => {
    // Grouping is date-aware, so "Worth a look" on the 16th is entirely made of
    // reliable suppliers who ran out of time. Telling them they have "some
    // history of filing late or short" would be a fresh lie in place of the one
    // just removed.
    const text = bandHelp('MEDIUM', [movedIn, movedIn]);
    expect(text).not.toMatch(/history of filing late/i);
    expect(text).toMatch(/filing record is not what put them in this group/i);
    expect(text).toMatch(/past their own cut-off/i);
  });

  it('says how many were moved in when a group holds both kinds', () => {
    const text = bandHelp('HIGH', [nativePast, nativePast, movedIn]);
    expect(text).toMatch(/filing record that says the invoice may not arrive/i);
    expect(text).toMatch(/1 of them moved up from a calmer group/i);
  });

  it('says nothing about escalation when nobody was moved', () => {
    expect(bandHelp('LOW', [inside, inside])).not.toMatch(/moved up/i);
  });
});

describe('the group headers on screen', () => {
  // Defence in depth. With date-aware grouping the API no longer puts a
  // past-cut-off supplier in LOW at all, so this arrangement should be
  // unreachable — but the header must not call it normal if it ever arrives,
  // because that is the exact sentence the bug was made of.
  it('does not call a past-cut-off group normal even if handed one', async () => {
    api.listAlerts.mockResolvedValue(
      alerts([group('LOW', [past('27AAAAA0001A1Z5', 'Mahavir Sales Corp')])])
    );
    render(<AlertsScreen run={RUN} taxPeriod="2026-04" asOf="2026-05-16" />);

    const low = await screen.findByTestId('band-LOW');
    const header = helpFor('LOW');

    // The exact sentence that used to sit above a red "Cut-off passed" chip.
    expect(header).not.toContain('GSTR-1 is not due until their cut-off');
    expect(header).toMatch(/All of them are past their own cut-off/);

    // And the card underneath still says what it always said, so the two now
    // agree instead of contradicting.
    expect(within(low).getByTestId('urgency-27AAAAA0001A1Z5')).toHaveTextContent('Cut-off passed');
  });

  it('drops the free-phone-call promise from Chase these once the cut-off is gone', async () => {
    api.listAlerts.mockResolvedValue(
      alerts([
        group('HIGH', [
          { ...past('27AAAAA0002A1Z4', 'Ghost Traders'), risk: { band: 'HIGH', score: 0.7, reasons: ['x'], features: {} } }
        ])
      ])
    );
    render(<AlertsScreen run={RUN} taxPeriod="2026-04" asOf="2026-05-16" />);
    await screen.findByTestId('band-HIGH');

    expect(helpFor('HIGH')).not.toMatch(/phone call today is free/i);
    expect(helpFor('HIGH')).toMatch(/All of them are past their own cut-off/);
  });

  it('counts a genuinely mixed group, where a QRMP 13th has not passed but a monthly 11th has', async () => {
    api.listAlerts.mockResolvedValue(
      alerts([
        group('MEDIUM', [
          past('27AAAAA0003A1Z3', 'Monthly Filer Ltd'),
          inside('27AAAAA0004A1Z2', 'Quarterly Filer Ltd')
        ])
      ])
    );
    render(<AlertsScreen run={RUN} taxPeriod="2026-04" asOf="2026-05-16" />);
    await screen.findByTestId('band-MEDIUM');

    expect(helpFor('MEDIUM')).toMatch(/1 of 2 are past their supplier's cut-off/);
  });

  it('still reads as reassurance when nothing is past its cut-off', async () => {
    api.listAlerts.mockResolvedValue(
      alerts([group('LOW', [inside('27AAAAA0005A1Z1', 'Early Bird Ltd')])])
    );
    render(<AlertsScreen run={RUN} taxPeriod="2026-04" asOf="2026-05-05" />);
    await screen.findByTestId('band-LOW');

    expect(helpFor('LOW')).toMatch(/None of them are past their own cut-off/);
    expect(helpFor('LOW')).toMatch(/still time for the invoice to land in this period/);
  });

  it('gives each group its own answer in the same render', async () => {
    api.listAlerts.mockResolvedValue(
      alerts([
        group('HIGH', [past('27AAAAA0006A1Z0', 'Past Ltd')]),
        group('LOW', [inside('27AAAAA0007A1Z9', 'Inside Ltd')])
      ])
    );
    render(<AlertsScreen run={RUN} taxPeriod="2026-04" asOf="2026-05-16" />);
    await screen.findByTestId('band-HIGH');

    // One header per group, each counted from its own suppliers — not one
    // sentence applied to the whole screen.
    expect(helpFor('HIGH')).toMatch(/All of them are past/);
    expect(helpFor('LOW')).toMatch(/None of them are past/);
  });
});
