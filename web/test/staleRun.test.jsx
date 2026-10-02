// The reported bug, at the UI layer: a row showing Taxable 7,17,915 vs 7,12,915,
// both flagged different, under "Agrees with the portal", score 1.00, with Accept
// offered. Every figure is current; the verdict is a month old.
//
// Accepting there loses the disputed credit for good, so the controls must be
// unavailable — not merely accompanied by a warning.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      confirmResult: vi.fn(),
      confirmRecommendations: vi.fn(),
      createRun: vi.fn(),
      listChanges: vi.fn(),
      imsActionsSummary: vi.fn(),
      imsActionsUrl: (id) => `/api/runs/${id}/ims-actions.json`
    }
  };
});

import { api } from '../src/api.js';
import { ActionsScreen } from '../src/screens/Actions.jsx';

const RUN = {
  id: 291,
  taxPeriod: '2026-04',
  mode: 'REACTIVE',
  asOfDate: '2026-05-16',
  filingScheme: 'MONTHLY',
  bucketCounts: { MATCHED: 2 },
  totals: {},
  staleness: { staleResults: 1, withdrawnResults: 0, unseenRecords: 0, isStale: true }
};

// The Mahavir row from the report: the stored verdict says the two sides agree,
// the two sides visibly do not.
const STALE_ROW = {
  id: 1,
  bucket: 'MATCHED',
  score: 1,
  scoreBreakdown: null,
  flags: [],
  recommendedAction: 'ACCEPT',
  recommendationReason: 'Supplier, number, date and amounts all line up.',
  deltaTaxableValue: 0,
  deltaTotalTax: 0,
  signedItc: 12103345,
  confirmedAction: null,
  stale: true,
  staleReason: 'PORTAL_CHANGED',
  withdrawn: false,
  books: {
    invoiceNo: '06-17/AMD/3538',
    invoiceDate: '2026-04-09',
    supplierGstin: '24DTQKE6706M3ZT',
    supplierName: 'Mahavir Sales Corp',
    docType: 'INVOICE',
    taxableValue: 71791500,
    totalTax: 12103345
  },
  portal: {
    invoiceNo: '06-17/AMD/3538',
    invoiceDate: '2026-04-09',
    supplierGstin: '24DTQKE6706M3ZT',
    supplierName: 'Mahavir Sales Corp',
    docType: 'INVOICE',
    source: 'IMS',
    section: 'b2b',
    taxableValue: 71291500,
    totalTax: 12013345,
    filingStatus: 'FILED',
    imsAction: 'N',
    pendingBlocked: false,
    remarksBlocked: false,
    itcAvailable: true
  }
};

const FRESH_ROW = {
  ...STALE_ROW,
  id: 2,
  stale: false,
  staleReason: null,
  books: { ...STALE_ROW.books, invoiceNo: 'CLEAN/1' },
  portal: { ...STALE_ROW.portal, invoiceNo: 'CLEAN/1', taxableValue: 71791500, totalTax: 12103345 }
};

const WITHDRAWN_ROW = {
  ...FRESH_ROW,
  id: 3,
  withdrawn: true,
  books: { ...STALE_ROW.books, invoiceNo: 'GONE/1' },
  portal: { ...STALE_ROW.portal, invoiceNo: 'GONE/1' }
};

// The screen opens on "Needs a decision", which by design excludes rows the
// engine already recommends accepting — and an Accept on a stale row is exactly
// what this suite is about. Switch to the full list, which is what a trader
// reviewing a period does.
async function mount(run, results) {
  const rendered = render(
    <ActionsScreen run={run} results={results} onConfirmed={vi.fn()} onRefresh={vi.fn()} />
  );
  await userEvent.click(screen.getByTestId('scope-ALL'));
  return rendered;
}

beforeEach(() => {
  api.listChanges.mockResolvedValue({ total: 0, changes: [], counts: {}, invalidatedCount: 0 });
  api.imsActionsSummary.mockResolvedValue({ stats: { records: 2, confirmed: 0, recommended: 2 }, warnings: [] });
});

const rowFor = (invoiceNo) =>
  screen.getAllByTestId('result-row').find((row) => row.textContent.includes(invoiceNo));

describe('a run that is out of date', () => {
  it('will not let a stale row be accepted, however clean its verdict looks', async () => {
    await mount(RUN, [STALE_ROW, FRESH_ROW]);

    const row = rowFor('06-17/AMD/3538');
    expect(row).toHaveAttribute('data-stale', 'true');

    // Every IMS control on that row is unavailable. A warning beside a live
    // button is not a guard.
    for (const action of ['ACCEPT', 'REJECT', 'PENDING', 'NO_ACTION']) {
      expect(within(row).getByTestId(`action-${action}`)).toBeDisabled();
    }
    expect(within(row).getByTestId('stale-note')).toHaveTextContent('This run is out of date');
    expect(within(row).getByTestId('stale-chip')).toBeInTheDocument();

    // ...and the row next to it is untouched, so this is a targeted block rather
    // than the screen going read-only.
    const clean = rowFor('CLEAN/1');
    expect(clean).toHaveAttribute('data-stale', 'false');
    expect(within(clean).getByTestId('action-ACCEPT')).toBeEnabled();
  });

  it('says so at the top of the screen and offers the fix', async () => {
    await mount(RUN, [STALE_ROW, FRESH_ROW]);

    const banner = screen.getByTestId('stale-run-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('This run is out of date');
    expect(screen.getByTestId('stale-row-count')).toHaveTextContent('1');

    api.createRun.mockResolvedValue({ id: RUN.id });
    await userEvent.click(screen.getByTestId('rerun-reconciliation'));

    // The run keeps its own clock — as-of date decides whether a mismatch is a
    // free supplier fix or a reject.
    await waitFor(() =>
      expect(api.createRun).toHaveBeenCalledWith({
        taxPeriod: '2026-04',
        mode: 'REACTIVE',
        asOfDate: '2026-05-16',
        filingScheme: 'MONTHLY'
      })
    );
  });

  it('does not offer the IMS file while the verdicts are out of date', async () => {
    await mount(RUN, [STALE_ROW, FRESH_ROW]);
    await waitFor(() => expect(screen.getByTestId('ims-download')).toBeInTheDocument());

    expect(screen.getByTestId('download-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('download-ims-json')).toBeNull();
  });

  it('leaves everything alone when the run is current', async () => {
    const currentRun = {
      ...RUN,
      staleness: { staleResults: 0, withdrawnResults: 0, unseenRecords: 0, isStale: false }
    };
    await mount(currentRun, [FRESH_ROW]);

    expect(screen.queryByTestId('stale-run-banner')).toBeNull();
    expect(within(rowFor('CLEAN/1')).getByTestId('action-ACCEPT')).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('download-ims-json')).toBeInTheDocument());
  });

  it('blocks a withdrawn record without telling anyone to re-run', async () => {
    // Re-running cannot bring a withdrawn record back, so the row must not carry
    // advice that will never work.
    const run = {
      ...RUN,
      staleness: { staleResults: 0, withdrawnResults: 1, unseenRecords: 0, isStale: false }
    };
    await mount(run, [WITHDRAWN_ROW, FRESH_ROW]);

    const row = rowFor('GONE/1');
    expect(row).toHaveAttribute('data-withdrawn', 'true');
    expect(within(row).getByTestId('action-ACCEPT')).toBeDisabled();
    expect(within(row).getByTestId('withdrawn-note')).toHaveTextContent('withdrew this record');
    expect(within(row).queryByTestId('stale-note')).toBeNull();
    expect(screen.queryByTestId('stale-run-banner')).toBeNull();
  });

  it('never bulk-confirms a row the API would refuse', async () => {
    // "Confirm all" walking into a 409 on the first row would abandon the rest of
    // the group half-done. Open rows only — the API says which those are.
    await mount(RUN, [
      { ...STALE_ROW, needsDecision: true },
      { ...FRESH_ROW, needsDecision: true },
      { ...WITHDRAWN_ROW, needsDecision: false }
    ]);

    const group = screen.getByTestId('group-ACCEPT');
    // Two of the three are unavailable, so the button must offer exactly one.
    expect(within(group).getByTestId('group-confirm')).toHaveTextContent('Confirm all 1');

    api.confirmRecommendations.mockResolvedValue({ confirmed: [FRESH_ROW.id], skipped: [] });
    await userEvent.click(within(group).getByTestId('group-confirm'));

    await waitFor(() => expect(api.confirmRecommendations).toHaveBeenCalledTimes(1));
    expect(api.confirmRecommendations).toHaveBeenCalledWith(RUN.id, [FRESH_ROW.id]);
  });

  it('says it cannot verify an older run, without claiming anything changed', async () => {
    // A run written before the baseline column existed. Reporting "current" here
    // is the original bug; reporting "N records changed" would be inventing a fact.
    // The honest answer is that it does not know, and that one re-run settles it.
    const legacyRow = { ...FRESH_ROW, stale: true, staleReason: 'UNVERIFIABLE' };
    const legacyRun = {
      ...RUN,
      staleness: {
        staleResults: 0,
        unverifiedResults: 422,
        withdrawnResults: 0,
        unseenRecords: 0,
        inputCountsKnown: false,
        isStale: true
      }
    };
    await mount(legacyRun, [legacyRow]);

    const banner = screen.getByTestId('stale-run-banner');
    expect(banner).toHaveTextContent('This run cannot be verified');
    expect(banner).not.toHaveTextContent('changed on the portal');
    expect(screen.getByTestId('unverified-count')).toHaveTextContent('422');

    const row = rowFor('CLEAN/1');
    expect(within(row).getByTestId('action-ACCEPT')).toBeDisabled();
    expect(within(row).getByTestId('stale-note')).toHaveTextContent('cannot be verified');
  });
});
