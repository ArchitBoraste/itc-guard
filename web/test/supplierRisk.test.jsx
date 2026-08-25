// Two claims about the suppliers screen, both of them about honesty rather than
// about layout:
//
//   * the model's probability NEVER reaches the screen as a number. A trader
//     cannot check "0.61", and a decimal implies a precision that a model fitted
//     on 200 synthetic rows has not earned. What they can check is "filed late in
//     4 of the last 6 months" — they were there when it happened.
//
//   * where the bands come from is stated ON the screen that shows them, with
//     the sample size and the held-out comparison, not just an accuracy figure.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { listSuppliers: vi.fn(), getSupplier: vi.fn() } };
});

import { api } from '../src/api.js';
import { RISK_BAND_LABEL } from '../src/lib/vocab.js';
import { SuppliersScreen } from '../src/screens/Suppliers.jsx';

const RUN = { id: 3, taxPeriod: '2026-07' };

const supplier = (overrides = {}) => ({
  gstin: '27BBBBB0001B1Z5',
  tradeName: 'Steady Supplies',
  legalName: 'Steady Supplies Pvt Ltd',
  stateCode: '27',
  filingScheme: 'MONTHLY',
  filingSchemeConfidence: 'MEDIUM',
  filingSchemeReason: 'filings appear monthly',
  stats: {
    periodsObserved: 6, lateCount: 0, missedCount: 0, invoiceCount: 12,
    mismatchCount: 0, avgDaysLate: -3, observedTotalTax: 100000,
    expectedTotalTax: 100000, trend: []
  },
  risk: {
    asOfPeriod: '2026-07',
    band: 'LOW',
    periodsObserved: 6,
    source: 'MODEL',
    guard: null,
    reasons: ['filed on time in all of the last 6 months, by their 11th'],
    topFactors: [{ feature: 'mean_days_late', direction: 'LOWERS', contribution: -0.61 }],
    features: {
      periodsObserved: 6, lateCount: 0, missedCount: 0, mismatches: 0,
      documents: 12, meanDaysLate: -3, maxDaysLate: -2, cutOffDay: 11
    }
  },
  ...overrides
});

const LATE = supplier({
  gstin: '27BBBBB0002B1Z4',
  tradeName: 'Tardy Traders',
  stats: { ...supplier().stats, lateCount: 4, avgDaysLate: 2 },
  risk: {
    asOfPeriod: '2026-07',
    band: 'HIGH',
    periodsObserved: 6,
    source: 'MODEL',
    guard: null,
    // The probability that produced this band was 0.6139. It must not appear.
    reasons: ['filed late in 4 of the last 6 months', 'worst month was 4 days past their 11th'],
    topFactors: [{ feature: 'mean_days_late', direction: 'RAISES', contribution: 1.2 }],
    features: {
      periodsObserved: 6, lateCount: 4, missedCount: 0, mismatches: 2,
      documents: 12, meanDaysLate: 2, maxDaysLate: 4, cutOffDay: 11
    }
  }
});

const COLD_START = {
  asOfPeriod: '2026-07',
  band: 'MEDIUM',
  periodsObserved: 0,
  source: 'HEURISTIC',
  guard: 'NO_HISTORY',
  reasons: ['no filing history yet - this is the first period we have seen them'],
  topFactors: null,
  features: { periodsObserved: 0, lateCount: 0, missedCount: 0, mismatches: 0, documents: 0, meanDaysLate: null, cutOffDay: 11 }
};

const MODEL = {
  source: 'MODEL',
  synthetic: true,
  features: ['mean_days_late', 'max_days_late', 'mismatch_rate', 'periods_observed'],
  droppedFeatures: {
    filed_ratio_6m: { reason: 'identical (1) on every row - no signal to learn from', constantValue: 1 }
  },
  rows: 200,
  positives: 43,
  suppliers: 40,
  holdoutPeriod: '2026-07',
  metrics: {
    holdoutRocAuc: 0.9351,
    holdoutRocAucHeuristic: 0.9004,
    cvRocAuc: 0.8975,
    cvRocAucHeuristic: 0.7951
  },
  beatsHeuristic: true
};

beforeEach(() => {
  api.listSuppliers.mockResolvedValue({ suppliers: [supplier(), LATE], model: MODEL });
});

const mount = () => render(<SuppliersScreen run={RUN} />);

describe('the risk band on the suppliers screen', () => {
  it('asks for the bands as of the period being worked on', async () => {
    mount();
    await waitFor(() => expect(api.listSuppliers).toHaveBeenCalledWith('2026-07'));
  });

  it('shows the band as words, never as a probability', async () => {
    mount();
    const table = await screen.findByTestId('suppliers-table');

    expect(within(table).getByTestId('risk-HIGH')).toBeInTheDocument();
    expect(within(table).getByTestId('risk-LOW')).toBeInTheDocument();

    // No decimal anywhere in the risk cells. 0.6139 produced the HIGH band and
    // must not have travelled with it.
    for (const cell of table.querySelectorAll('.risk-cell')) {
      expect(cell.textContent).not.toMatch(/\d\.\d/);
    }
  });

  it('says why, in a sentence the trader can check against their own memory', async () => {
    mount();
    const table = await screen.findByTestId('suppliers-table');
    expect(within(table).getByText('filed late in 4 of the last 6 months')).toBeInTheDocument();
    expect(
      within(table).getByText('filed on time in all of the last 6 months, by their 11th')
    ).toBeInTheDocument();
  });

  // The reported bug: every RISK cell read "not scored yet" while the model
  // explainer sat directly above the table describing bands and ROC AUC. The
  // cause was server-side — supplier_risk was empty — but the cell is where it
  // showed, so this pins the rendering too.
  it('renders a band chip in the RISK cell for every scored supplier', async () => {
    mount();
    const table = await screen.findByTestId('suppliers-table');

    const chips = table.querySelectorAll('.risk-chip');
    expect(chips).toHaveLength(2);
    // HIGH first: the table sorts by band now, so the order is the ranking.
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      RISK_BAND_LABEL.HIGH,
      RISK_BAND_LABEL.LOW
    ]);
    // Each chip carries its band class, which is what colours it.
    expect(table.querySelector('.risk-chip.risk-LOW')).toBeInTheDocument();
    expect(table.querySelector('.risk-chip.risk-HIGH')).toBeInTheDocument();

    expect(within(table).queryByText('not scored yet')).not.toBeInTheDocument();
  });

  // Cold start reads as UNPROVEN, not as a concern.
  //
  // The band stored is still MEDIUM — the phase 7 call that absence of history is
  // not evidence of reliability is right and is unchanged. What was wrong was the
  // sentence: "Worth a look" printed over "amounts matched on all 11 documents,
  // filed on time, only 1 month of history" reads as a broken model, and it
  // collapses "we do not know yet" into "we have concerns".
  it('reads a cold-start supplier as unproven rather than as suspect', async () => {
    api.listSuppliers.mockResolvedValue({
      suppliers: [supplier({ risk: COLD_START })],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');

    expect(table.querySelector('.risk-chip.risk-UNPROVEN')).toBeInTheDocument();
    expect(within(table).getByText(RISK_BAND_LABEL.UNPROVEN)).toBeInTheDocument();
    expect(within(table).getByText(/no filing history yet/)).toBeInTheDocument();

    // Neither the amber "concerns" wording nor a blank.
    expect(within(table).queryByText(RISK_BAND_LABEL.MEDIUM)).not.toBeInTheDocument();
    expect(within(table).queryByText('not scored yet')).not.toBeInTheDocument();
  });

  it('will not call a supplier normal off a single month', async () => {
    // No guard fired — the model rated them LOW — but one month is one
    // observation, and "Normal for this point in the month" off one document is
    // the phase 7 mistake pointing the other way.
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        supplier({
          risk: {
            ...supplier().risk,
            band: 'LOW',
            guard: null,
            periodsObserved: 1,
            reasons: ['filed on time in all of the last 1 month, by their 11th']
          }
        })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');
    expect(table.querySelector('.risk-chip.risk-UNPROVEN')).toBeInTheDocument();
    expect(within(table).queryByText(RISK_BAND_LABEL.LOW)).not.toBeInTheDocument();
  });

  it('does show the model verdict once there are two months and no guard', async () => {
    // The line is deliberately at one month, not at three. With two months and an
    // uncapped model band there IS a call, and hiding it under "too early to say"
    // would throw away the only signal on the screen.
    mount();
    const table = await screen.findByTestId('suppliers-table');
    expect(within(table).getByText(RISK_BAND_LABEL.HIGH)).toBeInTheDocument();
    expect(within(table).getByText(RISK_BAND_LABEL.LOW)).toBeInTheDocument();
  });

  it('reads a thin-history supplier the model flagged as unproven too', async () => {
    // The guard capped a HIGH model score because two months is not a pattern.
    // "Too early to say" is the honest label; the reasons still show the facts.
    api.listSuppliers.mockResolvedValue({
      suppliers: [supplier({ risk: { ...COLD_START, guard: 'THIN_HISTORY', periodsObserved: 2,
        reasons: ['filed late in 1 of the last 2 months', 'only 2 months of history so far, so this is a provisional read'] } })],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');

    expect(table.querySelector('.risk-chip.risk-UNPROVEN')).toBeInTheDocument();
    // The evidence is not hidden behind the softer label.
    expect(within(table).getByText('filed late in 1 of the last 2 months')).toBeInTheDocument();
  });

  it('says "not scored yet" only for a supplier with no behaviour row at all', async () => {
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        supplier(),
        supplier({
          gstin: '27CCCCC0004C1Z2',
          tradeName: 'Never Reconciled',
          // No periods observed anywhere, so nothing to score from.
          stats: { ...supplier().stats, periodsObserved: 0, invoiceCount: 0 },
          risk: null
        })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');

    // Exactly one, and it is the supplier with no behaviour row.
    expect(within(table).getAllByText('not scored yet')).toHaveLength(1);
    const unscoredRow = within(table).getByText('Never Reconciled').closest('tr');
    expect(within(unscoredRow).getByText('not scored yet')).toBeInTheDocument();

    // The other supplier still shows its band.
    const scoredRow = within(table).getByText('Steady Supplies').closest('tr');
    expect(scoredRow.querySelector('.risk-chip')).toBeInTheDocument();
  });
});

describe('the provenance note', () => {
  it('states plainly that the training data is synthetic', async () => {
    mount();
    const note = await screen.findByTestId('model-note');
    expect(note).toHaveTextContent('trained on synthetic data');
    expect(note).toHaveTextContent('generated by this repo');
    expect(note).toHaveTextContent('not evidence that it works');
  });

  it('gives the sample size, not just a metric', async () => {
    mount();
    const note = await screen.findByTestId('model-note');
    expect(note).toHaveTextContent('200 supplier-months');
    expect(note).toHaveTextContent('43 of');
    expect(note).toHaveTextContent('40 suppliers');
  });

  it('reports the held-out comparison against the scorer it replaced', async () => {
    mount();
    const note = await screen.findByTestId('model-note');
    expect(note).toHaveTextContent('0.9351');
    expect(note).toHaveTextContent('0.9004'); // the hand-weighted score
    expect(note).toHaveTextContent('small samples');
  });

  it('names the features it could not learn from, and what happens instead', async () => {
    mount();
    const note = await screen.findByTestId('model-note');
    expect(note).toHaveTextContent('filed_ratio_6m');
    expect(note).toHaveTextContent('hand-weighted fallback');
  });

  it('says so when no model is loaded at all', async () => {
    api.listSuppliers.mockResolvedValue({
      suppliers: [supplier()],
      model: { source: 'HEURISTIC', synthetic: false }
    });
    mount();
    expect(await screen.findByTestId('model-note')).toHaveTextContent('not a trained model');
  });
});

// The subtitle used to promise ranking by late, missed and mismatches, while the
// code sorted by late count then average timing and never looked at mismatches at
// all — a supplier with zero mismatches outranked one with four.
describe('row order', () => {
  const withCounts = (over, risk) =>
    supplier({ ...over, risk: { ...supplier().risk, ...risk } });

  it('puts the risk band first, whatever the counts say', async () => {
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        withCounts({ gstin: '27AAA0000001AZ1', tradeName: 'Low But Messy' },
          { band: 'LOW', guard: null, features: { periodsObserved: 6, lateCount: 0, missedCount: 0, mismatches: 9, documents: 20, meanDaysLate: -3, cutOffDay: 11 } }),
        withCounts({ gstin: '27AAA0000002AZ2', tradeName: 'High And Clean' },
          { band: 'HIGH', guard: null, features: { periodsObserved: 6, lateCount: 1, missedCount: 0, mismatches: 0, documents: 20, meanDaysLate: 1, cutOffDay: 11 } })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');
    const names = [...table.querySelectorAll('tbody .cell-strong')].map((n) => n.textContent);
    expect(names).toEqual(['High And Clean', 'Low But Messy']);
  });

  it('breaks ties by late, then missed, then mismatches — as the subtitle says', async () => {
    const band = { band: 'MEDIUM', guard: null };
    const feats = (lateCount, missedCount, mismatches) => ({
      periodsObserved: 6, lateCount, missedCount, mismatches, documents: 20,
      meanDaysLate: 0, cutOffDay: 11
    });
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        withCounts({ gstin: '27AAA0000003AZ3', tradeName: 'Mismatches Only' }, { ...band, features: feats(0, 0, 7) }),
        withCounts({ gstin: '27AAA0000004AZ4', tradeName: 'Missed One' }, { ...band, features: feats(0, 1, 0) }),
        withCounts({ gstin: '27AAA0000005AZ5', tradeName: 'Late Twice' }, { ...band, features: feats(2, 0, 0) })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');
    const names = [...table.querySelectorAll('tbody .cell-strong')].map((n) => n.textContent);
    expect(names).toEqual(['Late Twice', 'Missed One', 'Mismatches Only']);
  });

  it('files unproven suppliers above proven-clean ones but below real concerns', async () => {
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        withCounts({ gstin: '27AAA0000006AZ6', tradeName: 'Known Good' }, { band: 'LOW', guard: null }),
        withCounts({ gstin: '27AAA0000007AZ7', tradeName: 'Brand New' }, COLD_START),
        withCounts({ gstin: '27AAA0000008AZ8', tradeName: 'Known Bad' },
          { band: 'HIGH', guard: null, features: { periodsObserved: 6, lateCount: 4, missedCount: 0, mismatches: 0, documents: 20, meanDaysLate: 3, cutOffDay: 11 } })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');
    const names = [...table.querySelectorAll('tbody .cell-strong')].map((n) => n.textContent);
    // Unproven is not "normal", but there is nothing to act on either.
    expect(names).toEqual(['Known Bad', 'Brand New', 'Known Good']);
  });
});

describe('cosmetics', () => {
  it('keeps the provenance collapsed to one line, with every word still there', async () => {
    mount();
    const note = await screen.findByTestId('model-note');
    expect(note.tagName).toBe('DETAILS');
    expect(note).not.toHaveAttribute('open');

    expect(screen.getByTestId('model-note-summary')).toHaveTextContent(
      'Trained on synthetic data · how this is scored'
    );
    // Collapsed, not shortened — the full caveat is still in the DOM.
    expect(note).toHaveTextContent('trained on synthetic data');
    expect(note).toHaveTextContent('It has largely learned that generator');
    expect(note).toHaveTextContent('not evidence that it works');
    expect(note).toHaveTextContent('200 supplier-months');
    expect(note).toHaveTextContent('0.9351');
    expect(note).toHaveTextContent('small samples');
    expect(note).toHaveTextContent('filed_ratio_6m');
  });

  it('draws no sparkline from a single point', async () => {
    // One point becomes one full-width bar — the widest mark in the column,
    // drawn from a single month.
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        supplier({
          stats: { ...supplier().stats, trend: [{ taxPeriod: '2026-04', daysLate: -3 }] }
        })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');
    expect(table.querySelector('svg.trend')).not.toBeInTheDocument();
    expect(within(table).getByText('one month only')).toBeInTheDocument();
  });

  it('still draws one once there are two points to compare', async () => {
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        supplier({
          stats: {
            ...supplier().stats,
            trend: [
              { taxPeriod: '2026-03', daysLate: -3 },
              { taxPeriod: '2026-04', daysLate: 2 }
            ]
          }
        })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');
    expect(table.querySelector('svg.trend')).toBeInTheDocument();
  });
});
