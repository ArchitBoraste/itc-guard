// N is never a decision, in the screens (audit P1, P24).
//
// The API refuses a bulk confirm on Verify rows, any action on a books-only row,
// and the IMS file while records would go out as N. The screens must not offer
// what the API refuses, and must say what the download is about to do.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      ...actual.api,
      confirmResult: vi.fn(),
      confirmRecommendations: vi.fn(),
      listChanges: vi.fn(),
      imsActionsSummary: vi.fn()
    }
  };
});

import { api } from '../src/api.js';
import { ActionsScreen } from '../src/screens/Actions.jsx';
import { ImsDownload, openDecisionWarning } from '../src/components/ImsDownload.jsx';

const RUN = {
  id: 404,
  taxPeriod: '2026-04',
  mode: 'REACTIVE',
  asOfDate: '2026-05-16',
  filingScheme: 'MONTHLY',
  bucketCounts: {},
  totals: {},
  staleness: { staleResults: 0, withdrawnResults: 0, unseenRecords: 0, isStale: false }
};

const OPEN = {
  count: 22,
  itc: 0,
  byCategory: { phantom: { count: 6, itc: 0 }, verify: { count: 14, itc: 0 }, other: { count: 2, itc: 0 } }
};

const portal = (invoiceNo) => ({
  invoiceNo,
  supplierName: 'Reliable Sales Corp',
  supplierGstin: '29ABCDE1234F1Z5',
  docType: 'INVOICE',
  source: 'IMS',
  section: 'b2b',
  imsAction: 'N',
  pendingBlocked: false,
  remarksBlocked: false,
  itcAvailable: true,
  taxableValue: 100,
  totalTax: 18
});

const row = (id, over = {}) => ({
  id,
  bucket: 'SUGGESTED',
  flags: [],
  score: 0.8,
  scoreBreakdown: null,
  recommendedAction: 'VERIFY',
  recommendationReason: 'Likely the same invoice.',
  confirmedAction: null,
  needsDecision: true,
  stale: false,
  withdrawn: false,
  signedItc: 1800,
  books: { invoiceNo: `B/${id}`, supplierName: 'Reliable Sales Corp', supplierGstin: '29ABCDE1234F1Z5', docType: 'INVOICE', taxableValue: 100, totalTax: 18 },
  portal: portal(`P/${id}`),
  ...over
});

const VERIFY_ROWS = [row(1), row(2)];
const REJECT_ROW = row(3, { bucket: 'VALUE_MISMATCH', recommendedAction: 'REJECT' });
const BOOKS_ONLY = row(4, {
  bucket: 'MISSING_IN_PORTAL',
  recommendedAction: 'DEFERRED',
  needsDecision: false,
  portal: null
});

beforeEach(() => {
  vi.restoreAllMocks();
  api.listChanges.mockResolvedValue({ total: 0, changes: [], counts: {}, invalidatedCount: 0 });
  api.imsActionsSummary.mockResolvedValue({ stats: { records: 4, confirmed: 0, recommended: 4, byAction: {} }, warnings: [] });
});

const mountActions = (results) =>
  render(<ActionsScreen run={RUN} results={results} onConfirmed={vi.fn()} onRefresh={vi.fn()} />);

describe('Actions', () => {
  it('will not confirm a Verify group in bulk', () => {
    mountActions([...VERIFY_ROWS, REJECT_ROW]);
    const button = within(screen.getByTestId('group-VERIFY')).getByTestId('group-confirm');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Confirm all 2');
  });

  it('confirms a decidable group in one request, with only its open rows', async () => {
    api.confirmRecommendations.mockResolvedValue({ confirmed: [3], skipped: [] });
    mountActions([...VERIFY_ROWS, REJECT_ROW]);

    const group = screen.getByTestId('group-REJECT');
    await userEvent.click(within(group).getByTestId('group-confirm-arm'));
    await userEvent.click(within(group).getByTestId('group-confirm'));

    await waitFor(() => expect(api.confirmRecommendations).toHaveBeenCalledWith(RUN.id, [3]));
    expect(api.confirmResult).not.toHaveBeenCalled();
  });

  it('offers no IMS action at all on a books-only row', async () => {
    mountActions([BOOKS_ONLY]);
    await userEvent.click(screen.getByTestId('scope-ALL'));

    const bookOnly = screen.getByTestId('result-row');
    expect(within(bookOnly).getByTestId('no-ims-note')).toBeInTheDocument();
    expect(within(bookOnly).queryByTestId('action-NO_ACTION')).toBeNull();
    expect(screen.queryByTestId('group-confirm')).toBeNull();
  });

  it('reads a confirmed N as not decided, and never recommends N', () => {
    mountActions([row(5, { confirmedAction: 'NO_ACTION' })]);
    const verify = screen.getByTestId('result-row');
    expect(within(verify).getByTestId('open-badge')).toHaveTextContent('not decided');
    expect(within(verify).queryByTestId('agreed-badge')).toBeNull();
    expect(within(verify).getByTestId('action-NO_ACTION')).not.toHaveClass('is-recommended');
  });
});

describe('the IMS download', () => {
  it('asks before handing over a file with records still carrying N, naming them by kind', async () => {
    api.imsActionsSummary.mockResolvedValue({ stats: { records: 384, byAction: { N: 22 } }, warnings: [], openDecisions: OPEN });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ImsDownload run={RUN} />);

    const link = await screen.findByTestId('download-ims-json');
    expect(link).toHaveAttribute('href', `/api/runs/${RUN.id}/ims-actions.json?acknowledgeOpenDecisions=true`);

    const clicked = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(clicked);
    expect(confirm).toHaveBeenCalledWith(openDecisionWarning(OPEN));
    // Cancelled: nothing is downloaded.
    expect(clicked.defaultPrevented).toBe(true);
  });

  it('says what each count is', () => {
    const text = openDecisionWarning(OPEN);
    expect(text).toContain('22 records will go to the portal as N (no action)');
    expect(text).toContain('6 on the portal but not in your books');
    expect(text).toContain('14 probably the same invoice');
    expect(text).toContain('2 other records with no decision');
  });

  it('downloads without asking once nothing is open', async () => {
    api.imsActionsSummary.mockResolvedValue({ stats: { records: 384, byAction: { A: 384 } }, warnings: [], openDecisions: { ...OPEN, count: 0 } });
    const confirm = vi.spyOn(window, 'confirm');
    render(<ImsDownload run={RUN} />);

    const link = await screen.findByTestId('download-ims-json');
    expect(link).toHaveAttribute('href', `/api/runs/${RUN.id}/ims-actions.json`);
    // jsdom cannot follow the link; stop it trying once the screen has had its say.
    link.addEventListener('click', (event) => event.preventDefault());
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(confirm).not.toHaveBeenCalled();
  });
});
