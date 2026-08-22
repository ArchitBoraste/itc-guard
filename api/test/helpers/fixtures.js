import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

// fixtures/ is generated (and gitignored) — regenerate with
// `node tools/generate-fixtures.js` from the repo root.
export const FIXTURES_PRESENT = existsSync(join(FIXTURES_DIR, 'ground_truth.json'));

const MANIFEST = FIXTURES_PRESENT
  ? JSON.parse(readFileSync(join(FIXTURES_DIR, 'ground_truth.json'), 'utf8'))
  : {};

export const PERIODS = MANIFEST.periods ?? [];

// The recipient GSTIN written into the purchase-register header rows by the
// generator. This is a fact about the FILES, not about any organizations row —
// keep the two apart, or a test that means "the adapter read the header" quietly
// turns into "the org row happens to match".
export const FIXTURE_TRADER_GSTIN = MANIFEST.trader ?? null;

export function periodDir(period) {
  return join(FIXTURES_DIR, period);
}

export function readBuffer(period, name) {
  return readFileSync(join(periodDir(period), name));
}

export function readJson(period, name) {
  return JSON.parse(readFileSync(join(periodDir(period), name), 'utf8'));
}

export function groundTruth(period) {
  return readJson(period, 'ground_truth.json');
}

// The per-document ground truth doubles as the fixture summary: counts per side
// come from the presence flags rather than a separate hand-maintained total.
export function summarize(period) {
  const gt = groundTruth(period);
  const summary = {
    documents: gt.documents.length,
    inBooks: 0,
    inIms: 0,
    in2b: 0,
    twoBSections: {},
    buckets: {}
  };
  for (const doc of gt.documents) {
    if (doc.presence.inBooks) summary.inBooks += 1;
    if (doc.presence.inIms) summary.inIms += 1;
    if (doc.presence.in2b) {
      summary.in2b += 1;
      // Ground truth labels shared sections as 'b2bcn/cdnr' — take the 2B half.
      const section = doc.section.includes('/') ? doc.section.split('/')[1] : doc.section;
      summary.twoBSections[section] = (summary.twoBSections[section] ?? 0) + 1;
    }
    summary.buckets[doc.expectedBucket] = (summary.buckets[doc.expectedBucket] ?? 0) + 1;
  }
  return summary;
}

export function sumRateLineTotals(rateLines) {
  return rateLines.reduce(
    (acc, line) => ({
      taxableValue: acc.taxableValue + line.taxableValue,
      igst: acc.igst + line.igst,
      cgst: acc.cgst + line.cgst,
      sgst: acc.sgst + line.sgst,
      cess: acc.cess + line.cess
    }),
    { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
  );
}
