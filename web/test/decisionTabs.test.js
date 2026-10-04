// Which tab of IMS decisions a record sits in.
import { describe, expect, it } from 'vitest';
import aug11 from './fixtures/aug-11sep.json';
import sep05 from './fixtures/sep-05oct.json';
import {
  acceptAllIds,
  awaitsSupplier,
  decisionRows,
  defaultTab,
  isOverride,
  rowsForTab,
  statusOf,
  tabCounts
} from '../src/lib/decisionTabs.js';

const byInvoice = (results, invoiceNo) =>
  results.find((row) => (row.books?.invoiceNo ?? row.portal?.invoiceNo) === invoiceNo && !row.linkedFrom);
const decided = (result, confirmedAction) => ({ ...result, confirmedAction, needsDecision: false });

describe('on the cut-off day', () => {
  const rows = decisionRows(aug11.results);

  it('lists only records in IMS, and never a saved one still waiting on its supplier', () => {
    const invoices = rows.map(({ result }) => result.books?.invoiceNo ?? result.portal.invoiceNo).sort();
    expect(invoices).toEqual(['BA/219', 'CE-CN-08', 'GT/0145', 'INV-0801', 'LC-821', 'MS-878', 'NS-612', 'RT-760', 'UD-1905']);
    expect(awaitsSupplier(byInvoice(aug11.results, 'AE/177'))).toBe(true);
  });

  it('counts what the API counts as needing a decision', () => {
    const counts = tabCounts(rows);
    expect(counts).toEqual({ ready: 5, needs: 4, decided: 0, overridden: 0 });
    expect(counts.needs).toBe(aug11.run.openDecisions.count);
    expect(defaultTab(counts)).toBe('needs');
  });

  it('offers Accept all on the clean matches only', () => {
    const ids = acceptAllIds(rows);
    expect(ids).toHaveLength(5);
    expect(rowsForTab(rows, 'ready').map(({ result }) => result.id)).toEqual(ids);
  });
});

describe('decided or overridden', () => {
  const balaji = byInvoice(aug11.results, 'BA/219');
  const mahavir = byInvoice(aug11.results, 'MS-878');
  const national = byInvoice(aug11.results, 'NS-612');

  it('accepting a suggested match follows the recommendation (audit P24)', () => {
    expect(statusOf(decided(balaji, 'ACCEPT'))).toBe('decided');
    expect(isOverride(decided(balaji, 'ACCEPT'))).toBe(false);
    expect(statusOf(decided(balaji, 'REJECT'))).toBe('overridden');
  });

  it('a decision against the recommendation is an override', () => {
    expect(statusOf(decided(mahavir, 'ACCEPT'))).toBe('decided');
    expect(statusOf(decided(mahavir, 'REJECT'))).toBe('overridden');
    expect(statusOf(decided(national, 'REJECT'))).toBe('decided');
    expect(statusOf(decided(national, 'PENDING'))).toBe('overridden');
  });

  it('N is never a decision, whoever set it', () => {
    expect(statusOf({ ...national, confirmedAction: 'NO_ACTION' })).toBe('needs');
    const orbit = byInvoice(aug11.results, 'INV-0801');
    expect(statusOf({ ...orbit, confirmedAction: 'NO_ACTION' })).toBe('ready');
  });

  it('an action already recorded on the portal is a decision', () => {
    const recorded = { ...national, needsDecision: false, portal: { ...national.portal, imsAction: 'R' } };
    expect(statusOf(recorded)).toBe('decided');
  });

  it('Decided holds the overridden ones too', () => {
    const rows = decisionRows([decided(mahavir, 'REJECT'), decided(national, 'REJECT')]);
    expect(tabCounts(rows)).toEqual({ ready: 0, needs: 0, decided: 2, overridden: 1 });
    expect(rowsForTab(rows, 'decided')).toHaveLength(2);
  });
});

describe('September, with a saved record inside the free-fix window', () => {
  it("keeps National's saved, different NS-701 off the screen: it is a phone call", () => {
    const rows = decisionRows(sep05.results);
    expect(rows.map(({ result }) => result.books?.invoiceNo)).not.toContain('NS-701');
    expect(tabCounts(rows).needs).toBe(0);
  });

  it("lists August's amendment, arriving in September, as ready", () => {
    const rows = decisionRows(sep05.results);
    const amendment = rows.find(({ result }) => result.linkedFrom && result.books?.invoiceNo === 'MS-878');
    expect(amendment.status).toBe('ready');
  });
});
