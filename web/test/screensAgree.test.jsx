// Two screens count the same-sounding thing and disagree, and both of them are
// right. Summary reads IMS and GSTR-2B together; Still fixable reads IMS alone,
// because IMS is the only list that exists before the cut-off. So an invoice the
// supplier has filed is settled on one screen and gone from the other, and
// reverse-charge and blocked-credit purchases never reach IMS at all.
//
// Nothing here is a bug in either calculation. What was a bug was neither screen
// saying so — and then, once they did say so, saying it in three paragraphs of
// our own vocabulary that nobody running a shop would read.
//
// So these tests hold two things: that the explanations are still there and still
// accurate, and that the copy a judge meets first is still in ordinary words. The
// jargon guard at the bottom is the one that will annoy a future author, and it is
// the one most worth keeping.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      listAlerts: vi.fn(),
      listUploads: vi.fn(),
      listPeriods: vi.fn(),
      // Summary renders the IMS download panel, which reaches for both of these
      // on mount.
      imsActionsUrl: (runId) => `/api/runs/${runId}/ims-actions.json`,
      imsActionsSummary: vi.fn().mockResolvedValue({ counts: {}, total: 0 })
    }
  };
});

import { api } from '../src/api.js';
import { AlertsScreen } from '../src/screens/Alerts.jsx';
import { SummaryScreen } from '../src/screens/Summary.jsx';
import { UploadScreen } from '../src/screens/Upload.jsx';
import { HowToUseScreen } from '../src/screens/HowToUse.jsx';

// --- Still fixable ----------------------------------------------------------

const invoice = (over = {}) => ({
  expectedInvoiceId: 11,
  status: 'NOT_REPORTED',
  docType: 'INVOICE',
  invoiceNo: 'L-KNP/2786/06-17',
  invoiceDate: '2026-07-12',
  taxableValue: 52146800,
  totalTax: 7422591,
  itcAtStake: 7422591,
  deltaTotalTax: null,
  inGstr2b: false,
  gstr2bFiledOn: null,
  excludedReason: null,
  note: 'Not in IMS at all — the supplier has not even saved it yet.',
  ...over
});

function breakdownOf(invoices) {
  const out = {
    otherDocuments: { count: 0, itc: 0 },
    creditNotes: { count: 0, itc: 0 }
  };
  for (const entry of invoices) {
    const side = entry.itcAtStake < 0 ? out.creditNotes : out.otherDocuments;
    side.count += 1;
    side.itc += entry.itcAtStake;
  }
  return out;
}

const supplier = (invoices) => ({
  gstin: '32VYZTH4876U7ZL',
  tradeName: 'Anand Systems',
  filingScheme: 'MONTHLY',
  filingSchemeConfidence: 'MEDIUM',
  filingSchemeReason: 'filings appear monthly',
  cutOffDate: '2026-08-11',
  daysToCutOff: -5,
  preCutOff: false,
  urgency: 'PAST_CUTOFF',
  urgencyRank: 5,
  risk: { band: 'HIGH', score: 0.7, reasons: ['reported nothing in 5 of the last 6 months'], features: {} },
  invoiceCount: invoices.length,
  // GROSS, matching the API: magnitudes added, never cancelled.
  itcAtStake: invoices.reduce((sum, entry) => sum + Math.abs(entry.itcAtStake), 0),
  netItc: invoices.reduce((sum, entry) => sum + entry.itcAtStake, 0),
  breakdown: breakdownOf(invoices),
  statusCounts: { NOT_REPORTED: invoices.length, SAVED_NOT_FILED: 0, SAVED_VALUE_MISMATCH: 0 },
  invoices,
  headline: 'Anand Systems — 2 documents still not safe.',
  consequence: 'Their cut-off (11 Aug 2026) has passed.',
  chaseMessage: 'To: Anand Systems'
});

function alertsBody(invoices, totalsOver = {}) {
  const entry = supplier(invoices);
  return {
    taxPeriod: '2026-07',
    asOfDate: '2026-08-16',
    window: 'REACTIVE',
    orgCutOffDate: '2026-08-11',
    nextTaxPeriod: '2026-08',
    totals: {
      supplierCount: 1,
      invoiceCount: invoices.length,
      itcAtStake: entry.itcAtStake,
      netItc: entry.netItc,
      breakdown: entry.breakdown,
      expectedInvoices: 400,
      imsRecords: 380,
      inGstr2bCount: invoices.filter((one) => one.inGstr2b).length,
      ...totalsOver
    },
    excluded: {
      invoiceCount: 0,
      supplierCount: 0,
      itcAtStake: 0,
      byReason: {
        REVERSE_CHARGE: { count: 0, itcAtStake: 0 },
        ITC_INELIGIBLE: { count: 0, itcAtStake: 0 },
        NON_IMS_SECTION: { count: 0, itcAtStake: 0 }
      }
    },
    bands: [
      {
        band: 'HIGH',
        supplierCount: 1,
        invoiceCount: invoices.length,
        itcAtStake: entry.itcAtStake,
        escalatedCount: 0,
        pastCutOffCount: 1,
        netItc: entry.netItc,
        breakdown: entry.breakdown,
        suppliers: [entry]
      },
      { band: 'MEDIUM', supplierCount: 0, invoiceCount: 0, itcAtStake: 0, suppliers: [] },
      { band: 'LOW', supplierCount: 0, invoiceCount: 0, itcAtStake: 0, suppliers: [] }
    ],
    suppliers: [entry]
  };
}

const RUN = {
  id: 7,
  taxPeriod: '2026-07',
  asOfDate: '2026-08-16',
  cutOffDate: '2026-08-11',
  filingScheme: 'MONTHLY',
  finishedAt: '2026-08-28',
  mode: 'REACTIVE',
  engineVersion: '1',
  totals: {
    expectedTotalItc: 1000000,
    claimableItc: 900000,
    atRiskItc: 100000,
    deferredItc: 0,
    ineligibleItc: 0,
    nonImsItc: 50000,
    grandTotalItc: 1050000
  },
  totalsBreakdown: {},
  bucketCounts: {},
  bucketItc: {}
};

beforeEach(() => {
  api.listUploads.mockResolvedValue([]);
  api.listPeriods.mockResolvedValue([]);
});

describe('Still fixable explains itself against Summary', () => {
  it('folds the schema-level detail into a disclosure, closed to begin with', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([invoice()]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const details = await screen.findByTestId('why-totals-differ');
    // Closed by default. It is worth being exact about and it is not what anybody
    // needs in the first ten seconds.
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toMatch(
      /Why these numbers differ from Summary/
    );

    // Still accurate once opened - all three claims survived the rewrite.
    const body = details.textContent;
    expect(body).toMatch(/IMS/);
    expect(body).toMatch(/GSTR-2B/);
    expect(body).toMatch(/reverse charge/);
    expect(body).toMatch(/neither one is part of the other/);
  });

  // Everything that can never enter IMS is off this screen now, so a "Yes" here
  // means exactly one thing: filed, in 2B, and missing from a stale IMS download.
  it('says on the row when GSTR-2B already has the invoice', async () => {
    api.listAlerts.mockResolvedValue(
      alertsBody([
        invoice({
          inGstr2b: true,
          gstr2bFiledOn: '2026-08-09',
          note:
            'Already in your GSTR-2B — the supplier filed it on 9 Aug 2026 — but ' +
            'missing from this IMS download. re-download IMS before chasing.'
        })
      ])
    );
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const cell = await screen.findByTestId('in2b-11');
    expect(cell.textContent).toMatch(/Yes/);
    expect(cell.textContent).toMatch(/filed 9 Aug 2026/);
    // The action is a fresh download, not a phone call, and the card says so.
    const count = await screen.findByTestId('alerts-in2b-count');
    expect(count.parentElement.textContent).toMatch(/Download IMS again before phoning/);
  });

  it('marks a document that is genuinely nowhere as not in 2B either', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([invoice()]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const cell = await screen.findByTestId('in2b-11');
    expect(cell.textContent).toMatch(/No/);
    expect(cell.textContent).not.toMatch(/never enters IMS/);
  });

  // The set-aside line is informational and must stay that way: no band, no
  // chase message, and not inside any figure above it.
  it('reports what it kept off the screen, without making it a concern group', async () => {
    const body = alertsBody([invoice()]);
    body.excluded = {
      invoiceCount: 32,
      supplierCount: 21,
      itcAtStake: 125027897,
      byReason: {
        REVERSE_CHARGE: { count: 21, itcAtStake: 88088389 },
        ITC_INELIGIBLE: { count: 11, itcAtStake: 36939508 },
        NON_IMS_SECTION: { count: 0, itcAtStake: 0 }
      }
    };
    api.listAlerts.mockResolvedValue(body);
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const note = await screen.findByTestId('excluded-note');
    expect(note.textContent).toMatch(/Left out: 32 documents from 21 suppliers/);
    expect(note.textContent).toMatch(/21 on reverse charge/);
    expect(note.textContent).toMatch(/cannot claim the credit/);
    expect(note.textContent).toMatch(/nothing above counts them/i);
    // Not a card, not a band, and carrying no tone that would read as a warning.
    expect(note.className).not.toMatch(/total-card|tone-|band-/);
    expect(note.querySelector('button')).toBeNull();
  });

  it('says nothing when there was nothing to set aside', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([invoice()]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);
    await screen.findByTestId('alert-summary');
    expect(screen.queryByTestId('excluded-note')).toBeNull();
  });

  it('does not claim everything was filed when the list is empty only by exclusion', async () => {
    const body = alertsBody([]);
    body.totals.supplierCount = 0;
    body.suppliers = [];
    body.bands = body.bands.map((band) => ({ ...band, supplierCount: 0, suppliers: [] }));
    body.excluded = {
      invoiceCount: 5,
      supplierCount: 4,
      itcAtStake: 900000,
      byReason: {
        REVERSE_CHARGE: { count: 5, itcAtStake: 900000 },
        ITC_INELIGIBLE: { count: 0, itcAtStake: 0 },
        NON_IMS_SECTION: { count: 0, itcAtStake: 0 }
      }
    };
    api.listAlerts.mockResolvedValue(body);
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const empty = await screen.findByTestId('empty-alerts');
    expect(empty.textContent).toMatch(/your supplier could still change/);
    expect(empty.textContent).toMatch(/need nothing from anybody/);
  });
});

describe('Still fixable shows exposure, not a net', () => {
  const CREDIT_NOTE = {
    expectedInvoiceId: 12,
    status: 'NOT_REPORTED',
    docType: 'CREDIT_NOTE',
    invoiceNo: '1-02687',
    invoiceDate: '2026-07-04',
    taxableValue: 18080800,
    totalTax: 2842765,
    // Signed on the document, because a credit note really does pull the other
    // way. What must not happen is the SCREEN adding it to an invoice.
    itcAtStake: -2842765,
    deltaTotalTax: null,
    inGstr2b: false,
    gstr2bFiledOn: null,
    excludedReason: null,
    note: 'Not in the IMS file you uploaded.'
  };
  const INVOICE = {
    ...CREDIT_NOTE,
    expectedInvoiceId: 13,
    docType: 'INVOICE',
    invoiceNo: '1-02678',
    totalTax: 2285028,
    itcAtStake: 2285028
  };

  // The reported case: Rs 22,850.28 and Rs 28,427.65 netted to MINUS Rs 5,577.37
  // on a card headed "ITC at stake", a figure matching neither document.
  it('headlines the gross, not the net, when a credit note is in the pile', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([INVOICE, CREDIT_NOTE]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const stake = await screen.findByTestId('stake-32VYZTH4876U7ZL');
    // 22,850.28 + 28,427.65 = 51,277.93, rendered to whole rupees.
    expect(stake.textContent).toMatch(/51,278/);
    expect(stake.textContent).not.toMatch(/5,577/);
    expect(stake.textContent).not.toMatch(/−|-\s*₹/);
  });

  it('splits the two directions, because nobody can act on a total', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([INVOICE, CREDIT_NOTE]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const split = await screen.findByTestId('split-32VYZTH4876U7ZL');
    expect(split.textContent).toMatch(/22,850/);
    expect(split.textContent).toMatch(/owed to you/);
    expect(split.textContent).toMatch(/28,428/);
    expect(split.textContent).toMatch(/still claiming/);
    // The net is named as the thing it is NOT, so the two figures reconcile.
    expect(split.textContent).toMatch(/5,577/);
  });

  it('shows a credit-note-only supplier as positive exposure', async () => {
    // Fortune Hardware, June 2026: one credit note, and the card headlined
    // MINUS Rs 17,128.92 under "ITC at stake".
    api.listAlerts.mockResolvedValue(alertsBody([CREDIT_NOTE]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const stake = await screen.findByTestId('stake-32VYZTH4876U7ZL');
    expect(stake.textContent).toMatch(/28,428/);
    expect(stake.textContent).not.toMatch(/−/);
  });

  it('leaves an all-invoice supplier with no split to explain', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([INVOICE]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);
    await screen.findByTestId('stake-32VYZTH4876U7ZL');
    expect(screen.queryByTestId('split-32VYZTH4876U7ZL')).toBeNull();
  });
});

describe('each screen says what is on it', () => {
  it('Still fixable opens with what is here and why it matters', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([invoice()]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    expect((await screen.findByTestId('alerts-lede')).textContent).toMatch(
      /has not filed yet/
    );
    // The point of the whole screen: nothing here is final, so a call still works.
    expect(screen.getByTestId('alerts-why').textContent).toMatch(/phone call/);
    expect(screen.getByTestId('alerts-why').textContent).toMatch(/Actions/);
  });

  it('says the date changes the time left, not the list', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([invoice()]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);
    expect((await screen.findByTestId('alerts-date-help')).textContent).toMatch(
      /does not change what is listed/
    );
  });

  it('Summary points at Actions as the same list seen differently', () => {
    render(<SummaryScreen run={RUN} results={[]} />);
    expect(screen.getByTestId('summary-population').textContent).toMatch(
      /Actions tab is the same list/
    );
    expect(screen.getByTestId('summary-cross-screen').textContent).toMatch(
      /Still fixable tab/
    );
  });
});

// The constraint that is easiest to lose and hardest to notice losing: this app is
// for somebody who runs a shop, not for whoever wrote the schema docs. Every word
// below is ours, and none of them belong in the copy a judge meets first.
describe('the copy a judge meets first stays in ordinary words', () => {
  const OURS = [
    'population',
    'subset',
    'reconcile',
    'books rows',
    'ims position',
    'portal record',
    'netted'
  ];

  it('keeps our vocabulary out of what Still fixable opens with', async () => {
    api.listAlerts.mockResolvedValue(alertsBody([invoice()]));
    render(<AlertsScreen run={RUN} taxPeriod="2026-07" />);

    const heading = (await screen.findByRole('heading', { level: 2 })).textContent;
    expect(heading).toMatch(/Still fixable/);
    expect(heading).not.toMatch(/Before cut-off/);

    const opening = [
      screen.getByTestId('alerts-lede'),
      screen.getByTestId('alerts-why'),
      screen.getByTestId('alerts-date-help')
    ]
      .map((node) => node.textContent)
      .join(' ')
      .toLowerCase();

    for (const word of OURS) expect(opening).not.toContain(word);
  });

  it('keeps it out of the one-liners on Summary too', () => {
    render(<SummaryScreen run={RUN} results={[]} />);
    const lines = [
      screen.getByTestId('summary-population').textContent,
      screen.getByTestId('summary-cross-screen').textContent
    ]
      .join(' ')
      .toLowerCase();
    for (const word of OURS) expect(lines).not.toContain(word);
  });
});

describe('Summary explains itself against Still fixable', () => {
  it('claims the purchases the other screen leaves out, and says so plainly', () => {
    render(<SummaryScreen run={RUN} results={[]} />);
    const note = screen.getByTestId('summary-cross-screen');
    // The kinds Still fixable drops have to be claimed by somebody.
    expect(note.textContent).toMatch(/reverse charge, imports and credit you cannot claim/);
    expect(note.textContent).toMatch(/Still fixable tab/);
    expect(note.textContent).toMatch(/not a part of these/);
  });

  it('says which sample period is loaded and where the files are', () => {
    render(<SummaryScreen run={RUN} results={[]} seededPeriods={['2026-07']} />);
    const note = screen.getByTestId('sample-note');
    expect(note.textContent).toMatch(/July 2026/);
    expect(note.textContent).toMatch(/Upload tab/);
    expect(note.querySelector('a').getAttribute('href')).toMatch(/samples/);
  });

  it('claims nothing about sample data for a period the visitor uploaded themselves', () => {
    render(<SummaryScreen run={RUN} results={[]} seededPeriods={['2026-04']} />);
    expect(screen.queryByTestId('sample-note')).toBeNull();
  });
});

describe('the sample-period picker agrees with the loaded period', () => {
  const org = {
    org: { gstin: '27AABCS1429F1Z8', legalName: 'Sharma Electronics Private Limited' },
    demoPeriods: ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'],
    defaultDemoPeriod: '2026-04'
  };

  // The reported contradiction: the dropdown read April while the header read
  // July, so whichever one the judge believed, the other made the app look wrong.
  it('defaults to whatever period is actually loaded, not to the demo default', async () => {
    render(
      <UploadScreen
        org={org}
        runs={[{ taxPeriod: '2026-07' }]}
        activePeriod="2026-07"
        onIngested={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByTestId('sample-period').value).toBe('2026-07'));
  });

  it('offers every generated period, not just the default one', async () => {
    render(
      <UploadScreen
        org={org}
        runs={[{ taxPeriod: '2026-07' }]}
        activePeriod="2026-07"
        onIngested={vi.fn()}
      />
    );
    const options = [...screen.getByTestId('sample-period').options].map((one) => one.value);
    expect(options).toEqual(org.demoPeriods);
  });

  it('says which as-of date loading that period will land on', async () => {
    render(
      <UploadScreen
        org={org}
        runs={[{ taxPeriod: '2026-07' }]}
        activePeriod="2026-07"
        onIngested={vi.fn()}
      />
    );
    // 16 Aug for July: after 2B generates on the 14th, before GSTR-3B on the 20th.
    await waitFor(() =>
      expect(screen.getByTestId('seed-inline-help').textContent).toMatch(/16 Aug 2026/)
    );
  });

  it('scopes the upload history to the period in view', async () => {
    api.listUploads.mockResolvedValue([
      { id: 3, kind: 'IMS', original_filename: 'ims.json', detected_format: 'IMS_JSON', row_count: 10, tax_period: '2026-07', status: 'PARSED' },
      { id: 2, kind: 'IMS', original_filename: 'ims.json', detected_format: 'IMS_JSON', row_count: 10, tax_period: '2026-04', status: 'PARSED' },
      { id: 1, kind: 'IMS', original_filename: 'ims.json', detected_format: 'IMS_JSON', row_count: 10, tax_period: '2026-03', status: 'PARSED' }
    ]);
    render(
      <UploadScreen
        org={org}
        runs={[{ taxPeriod: '2026-07' }]}
        activePeriod="2026-07"
        onIngested={vi.fn()}
      />
    );

    const table = await screen.findByTestId('upload-history');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(screen.getByTestId('history-scope').textContent).toMatch(/July 2026/);
    expect(screen.getByTestId('history-scope').textContent).toMatch(/2 more hidden/);
  });
});

describe('How to use', () => {
  it('walks through loading a period and what each screen is for', () => {
    render(<HowToUseScreen hasData />);
    const steps = screen.getByTestId('howto-steps').textContent;
    expect(steps).toMatch(/sample period/i);
    expect(steps).toMatch(/Load sample period/);

    const screens = screen.getByTestId('howto-screens').textContent;
    for (const name of ['Summary', 'Still fixable', 'Actions', 'Suppliers']) {
      expect(screens).toContain(name);
    }
  });

  it('says that Reset my data puts everything back', () => {
    render(<HowToUseScreen hasData />);
    expect(document.body.textContent).toMatch(/Reset my data/);
  });
});
