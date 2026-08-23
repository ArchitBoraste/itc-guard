// The "Changed since your review" panel has one job that outranks the rest: when
// a decision the trader made has been invalidated, they must not be able to miss
// it. A change on a record nobody reviewed is background and must not compete
// with it.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { listChanges: vi.fn() } };
});

import { api } from '../src/api.js';
import { ChangeFeed } from '../src/components/ChangeFeed.jsx';

const RUN = { id: 4, taxPeriod: '2026-03' };

// An amendment that cost the trader a decision they had already made.
const INVALIDATED = {
  id: 91,
  changeType: 'AMENDED',
  detectedAt: '2026-04-16 09:00:00',
  record: {
    id: 700,
    source: 'IMS',
    supplierGstin: '24DTQKE6706M3ZT',
    supplierName: 'Verma Cables',
    invoiceNo: 'C/1465',
    invoiceDate: '2026-03-11',
    docType: 'INVOICE'
  },
  fields: [
    { field: 'taxableValue', oldValue: 4270000, newValue: 4720000, delta: 450000 },
    { field: 'totalTax', oldValue: 768600, newValue: 849600, delta: 81000 }
  ],
  deltaTaxableValue: 450000,
  deltaTotalTax: 81000,
  review: {
    resultId: 12,
    bucket: 'MATCHED',
    confirmedAction: null,
    confirmationReset: true,
    reviewed: true,
    invalidatedDecision: true,
    signedItc: 849600
  }
};

// A supplier filing a record the trader never looked at. Real, but not urgent.
const INFORMATIONAL = {
  id: 90,
  changeType: 'STATUS_CHANGE',
  detectedAt: '2026-04-16 09:00:00',
  record: {
    id: 701,
    source: 'IMS',
    supplierGstin: '36FVNAL5553D3ZD',
    supplierName: 'Krishna Traders',
    invoiceNo: 'C/3360',
    invoiceDate: '2026-03-04',
    docType: 'INVOICE'
  },
  fields: [{ field: 'filingStatus', oldValue: 'SAVED', newValue: 'FILED', delta: null }],
  deltaTaxableValue: null,
  deltaTotalTax: null,
  review: {
    resultId: 13,
    bucket: 'VALUE_MISMATCH',
    confirmedAction: null,
    confirmationReset: false,
    reviewed: false,
    invalidatedDecision: false,
    signedItc: 12000
  }
};

const feedOf = (changes) => ({
  runId: RUN.id,
  taxPeriod: RUN.taxPeriod,
  total: changes.length,
  counts: {},
  invalidatedCount: changes.filter((c) => c.review.invalidatedDecision).length,
  invalidatedItc: changes
    .filter((c) => c.review.invalidatedDecision)
    .reduce((sum, c) => sum + (c.review.signedItc ?? 0), 0),
  changes
});

describe('the changed-since-your-review panel', () => {
  it('shouts about an invalidated decision and keeps the rest quiet', async () => {
    api.listChanges.mockResolvedValue(feedOf([INVALIDATED, INFORMATIONAL]));
    render(<ChangeFeed run={RUN} />);

    const alert = await screen.findByTestId('changes-invalidated');
    // Announced, not merely present: a screen reader must interrupt for this.
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('A decision you made no longer applies');
    expect(alert).toHaveTextContent('Verma Cables');
    expect(alert).toHaveTextContent('Your decision on this record was dropped');
    // The old and new figures both, so the trader can see what actually moved.
    expect(alert).toHaveTextContent('₹42,700');
    expect(alert).toHaveTextContent('₹47,200');
    expect(alert).toHaveTextContent('₹8,496');

    // The quiet one is NOT inside the alert — the whole point of two panels.
    expect(alert).not.toHaveTextContent('Krishna Traders');

    const quiet = screen.getByTestId('changes-informational');
    expect(quiet).not.toHaveAttribute('role', 'alert');
    expect(quiet).toHaveTextContent('1 other change');
    // Collapsed until asked for.
    expect(quiet).not.toHaveTextContent('Krishna Traders');

    await userEvent.click(screen.getByTestId('toggle-quiet-changes'));
    expect(screen.getByTestId('changes-informational')).toHaveTextContent('Krishna Traders');
    expect(screen.getByTestId(`change-${INFORMATIONAL.id}`)).toHaveTextContent('Saved');
  });

  it('renders no alert at all when nothing a trader decided has moved', async () => {
    api.listChanges.mockResolvedValue(feedOf([INFORMATIONAL]));
    render(<ChangeFeed run={RUN} />);

    await screen.findByTestId('changes-informational');
    expect(screen.queryByTestId('changes-invalidated')).toBeNull();
  });

  it('renders nothing when the portal has not moved', async () => {
    api.listChanges.mockResolvedValue(feedOf([]));
    const { container } = render(<ChangeFeed run={RUN} />);

    await waitFor(() => expect(api.listChanges).toHaveBeenCalledWith(RUN.id));
    expect(container).toBeEmptyDOMElement();
  });

  it('does not take the action list down with it when the feed fails', async () => {
    api.listChanges.mockRejectedValue(new Error('502 Bad Gateway'));
    render(<ChangeFeed run={RUN} />);

    const note = await screen.findByTestId('change-feed-error');
    expect(note).toHaveTextContent('502 Bad Gateway');
    expect(screen.queryByTestId('changes-invalidated')).toBeNull();
  });
});
