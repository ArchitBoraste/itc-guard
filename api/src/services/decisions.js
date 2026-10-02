// Which results are still waiting on the trader. Pure — no db, no fs.
//
// One definition, read by every screen and by the IMS export: a record needs a
// decision when it is in IMS, can be actioned there, and the action it would
// carry right now is N. N is the portal's "nothing recorded" — exactly the state
// deemed acceptance acts on at GSTR-3B — so it never counts as a decision,
// whoever set it.
//
// Input is a result as the API reads it back:
//   { bucket, recommendedAction, confirmedAction, signedItc, withdrawn,
//     portal: { source, imsAction } | null }
import { BUCKETS } from '../matching/buckets.js';

export const IMS_DECISIONS = Object.freeze(['ACCEPT', 'REJECT', 'PENDING']);

// An action already recorded on the portal, as the IMS download reports it.
const PORTAL_DECISIONS = Object.freeze({ A: 'ACCEPT', R: 'REJECT', P: 'PENDING' });

export const DECISION_CATEGORIES = Object.freeze({
  // On the portal, not in the books.
  PHANTOM: 'phantom',
  // Probably the same invoice; only a human can say so.
  VERIFY: 'verify',
  OTHER: 'other'
});

export const isImsDecision = (action) => IMS_DECISIONS.includes(action);

// Reverse charge, ineligible, 2B-only and books-only records have no IMS row to
// act on; a withdrawn record no longer has one.
export function isImsActionable(result) {
  return (
    result.portal?.source === 'IMS' &&
    result.bucket !== BUCKETS.NON_IMS &&
    result.bucket !== BUCKETS.INELIGIBLE &&
    !result.withdrawn
  );
}

// The IMS action this record carries right now. In order: the trader's own
// decision, the action already on the portal, ACCEPT for a clean match — the one
// recommendation that stands without a human — and otherwise N.
export function currentImsAction(result) {
  if (isImsDecision(result.confirmedAction)) return result.confirmedAction;
  const recorded = PORTAL_DECISIONS[result.portal?.imsAction];
  if (recorded) return recorded;
  if (result.bucket === BUCKETS.MATCHED && result.recommendedAction === 'ACCEPT') return 'ACCEPT';
  return 'NO_ACTION';
}

export function needsDecision(result) {
  return isImsActionable(result) && currentImsAction(result) === 'NO_ACTION';
}

export function decisionCategory(result) {
  if (!needsDecision(result)) return null;
  if (result.bucket === BUCKETS.MISSING_IN_BOOKS) return DECISION_CATEGORIES.PHANTOM;
  if (result.bucket === BUCKETS.SUGGESTED) return DECISION_CATEGORIES.VERIFY;
  return DECISION_CATEGORIES.OTHER;
}

// -> { count, itc, byCategory: { phantom: { count, itc }, verify: {...}, other: {...} } }
export function summarizeOpenDecisions(results) {
  const tally = () => ({ count: 0, itc: 0 });
  const summary = {
    ...tally(),
    byCategory: Object.fromEntries(Object.values(DECISION_CATEGORIES).map((name) => [name, tally()]))
  };
  for (const result of results) {
    const category = decisionCategory(result);
    if (!category) continue;
    const itc = result.signedItc ?? 0;
    for (const entry of [summary, summary.byCategory[category]]) {
      entry.count += 1;
      entry.itc += itc;
    }
  }
  return summary;
}
