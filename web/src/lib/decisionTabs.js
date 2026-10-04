// Which tab of IMS decisions a record sits in. Pure: results in, rows out.
//
// The rules mirror api/src/services/decisions.js, which the export and every
// count read:
//   - Only records in IMS can be decided. A saved record still waiting on its
//     supplier is a phone call, not a decision, and is shown on Not filed yet.
//   - N is never a decision, whoever set it. A row whose decision is N is back to
//     Ready (a clean match, which goes out as Accept) or Needs a decision.
//   - Overridden means the trader chose something other than what was
//     recommended. "Accept if same bill" recommends Accept, so accepting a
//     suggested match follows the recommendation (audit P24).
import { recommendationOf } from './issues.js';

export const TABS = [
  {
    key: 'ready',
    label: 'Ready to accept',
    hint: 'These match your books. Accept them in one go.',
    empty: 'Nothing left to accept.'
  },
  {
    key: 'needs',
    label: 'Needs a decision',
    hint: 'These differ from your books. Open a row to see why.',
    empty: 'All caught up. Nothing needs a decision.'
  },
  {
    key: 'decided',
    label: 'Decided',
    hint: 'Everything you have decided. It all goes into the IMS file.',
    empty: 'Nothing decided yet.'
  },
  {
    key: 'overridden',
    label: 'Overridden',
    hint: 'Decisions that differ from what we recommended.',
    empty: 'No overrides. You followed every recommendation.'
  }
];

const IMS_DECISIONS = new Set(['ACCEPT', 'REJECT', 'PENDING']);
const PORTAL_DECISIONS = { A: 'ACCEPT', R: 'REJECT', P: 'PENDING' };

export function isImsActionable(result) {
  return (
    result.portal?.source === 'IMS' &&
    result.bucket !== 'NON_IMS' &&
    result.bucket !== 'INELIGIBLE' &&
    !result.withdrawn
  );
}

export function awaitsSupplier(result) {
  if (result.portal?.filingStatus !== 'SAVED') return false;
  const passed = (result.flags ?? []).includes('CUTOFF_PASSED');
  return !passed || result.bucket === 'MISSING_IN_PORTAL';
}

// The trader's own decision, else one already recorded on the portal, else none.
export function decisionOf(result) {
  if (IMS_DECISIONS.has(result.confirmedAction)) return result.confirmedAction;
  return PORTAL_DECISIONS[result.portal?.imsAction] ?? null;
}

export function isOverride(result) {
  const decision = decisionOf(result);
  const recommended = recommendationOf(result).ims;
  return Boolean(decision && recommended && decision !== recommended);
}

// 'ready' | 'needs' | 'decided' | 'overridden'
export function statusOf(result) {
  const decision = decisionOf(result);
  if (decision) return isOverride(result) ? 'overridden' : 'decided';
  return result.needsDecision ? 'needs' : 'ready';
}

// The records this screen lists, each with its tab.
export function decisionRows(results = []) {
  return results
    .filter((result) => isImsActionable(result) && !awaitsSupplier(result))
    .map((result) => ({ result, status: statusOf(result) }));
}

export function tabCounts(rows) {
  const count = (predicate) => rows.filter(predicate).length;
  return {
    ready: count((row) => row.status === 'ready'),
    needs: count((row) => row.status === 'needs'),
    decided: count((row) => row.status === 'decided' || row.status === 'overridden'),
    overridden: count((row) => row.status === 'overridden')
  };
}

export function rowsForTab(rows, tab) {
  if (tab === 'decided') return rows.filter((row) => row.status === 'decided' || row.status === 'overridden');
  return rows.filter((row) => row.status === tab);
}

// The tab to open on: whatever needs the trader first.
export function defaultTab(counts) {
  if (counts.needs) return 'needs';
  if (counts.ready) return 'ready';
  return 'decided';
}

// The rows "Accept all" may confirm: ready, recommended Accept, and not out of
// date (the API refuses a decision on a stale verdict).
export function acceptAllIds(rows) {
  return rows
    .filter((row) => row.status === 'ready' && row.result.recommendedAction === 'ACCEPT' && !row.result.stale)
    .map((row) => row.result.id);
}
