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
    topFactors: [{ feature: 'mean_days_late', direction: 'LOWERS', contribution: -0.61 }]
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
    topFactors: [{ feature: 'mean_days_late', direction: 'RAISES', contribution: 1.2 }]
  }
});

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
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      RISK_BAND_LABEL.LOW,
      RISK_BAND_LABEL.HIGH
    ]);
    // Each chip carries its band class, which is what colours it.
    expect(table.querySelector('.risk-chip.risk-LOW')).toBeInTheDocument();
    expect(table.querySelector('.risk-chip.risk-HIGH')).toBeInTheDocument();

    expect(within(table).queryByText('not scored yet')).not.toBeInTheDocument();
  });

  it('shows a band for a supplier with no filing history rather than a blank', async () => {
    // Cold start: a behaviour row exists, nothing before the as-of period. Phase 7
    // settled this as MEDIUM — never LOW, and never unscored.
    api.listSuppliers.mockResolvedValue({
      suppliers: [
        supplier({
          risk: {
            asOfPeriod: '2026-07',
            band: 'MEDIUM',
            periodsObserved: 0,
            source: 'HEURISTIC',
            guard: 'NO_HISTORY',
            reasons: ['no filing history yet - this is the first period we have seen them'],
            topFactors: null
          }
        })
      ],
      model: MODEL
    });
    mount();
    const table = await screen.findByTestId('suppliers-table');

    expect(table.querySelector('.risk-chip.risk-MEDIUM')).toBeInTheDocument();
    expect(within(table).getByText(/no filing history yet/)).toBeInTheDocument();
    expect(within(table).queryByText('not scored yet')).not.toBeInTheDocument();
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
