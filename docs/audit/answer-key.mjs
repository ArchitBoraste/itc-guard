// Independent answer key for the ITC Guard audit (docs/audit-findings.md).
//
// Reads the RAW fixture files only — purchase_register.xlsx, ims.json, gstr2b.json,
// ground_truth.json, suppliers.json — and works out what every screen should show,
// from the rules in CLAUDE.md. It imports NOTHING from api/src or web/src: reusing
// the app's own code to compute "expected" would confirm the app's bugs.
//
// The only third-party import is the `xlsx` parser, needed to read the register.
//
//   node docs/audit/answer-key.mjs [--fixtures <dir>] [--out <file>]
//
// XLSX_FROM may point at any package.json whose node_modules holds `xlsx`
// (default: api/package.json — a node_modules lookup, not app source).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const FIXTURES = resolve(arg('--fixtures', join(REPO, 'fixtures')));
const OUT = resolve(arg('--out', join(HERE, 'answer-key.json')));
const XLSX = createRequire(process.env.XLSX_FROM ?? join(REPO, 'api', 'package.json'))('xlsx');

const PERIODS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
// What a fresh visitor's org holds on the deployed demo (see "Reset my data").
const PRELOADED = ['2026-03', '2026-04'];
const STORY_PERIOD = '2026-04';
const STORY_REDUCE_TAXABLE = 500000; // Rs 5,000 in paise

// ---------------------------------------------------------------- helpers
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const fromDdMmYyyy = (s) => { const [d, m, y] = String(s).split('-').map(Number); return iso(y, m, d); };
const fromDMmmYy = (s) => { const [d, mon, yy] = String(s).split('-'); return iso(2000 + Number(yy), MON[mon], Number(d)); };
const nextPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };
const dayOfNext = (p, d) => `${nextPeriod(p)}-${pad(d)}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
// Rupees (number or "4,98,100.5" string) -> integer paise, via the decimal string.
function paise(value) {
  if (value === null || value === undefined || value === '') return 0;
  const text = typeof value === 'number' ? value.toFixed(2) : String(value).replace(/,/g, '').trim();
  const neg = text.startsWith('-');
  const [ip, fp = ''] = text.replace('-', '').split('.');
  const p = Number(ip) * 100 + Number((fp + '00').slice(0, 2));
  return neg ? -p : p;
}
const rs = (p) => {
  const neg = p < 0; const a = Math.abs(p);
  const whole = Math.floor((a + 50) / 100);
  const s = String(whole); const tail = s.slice(-3); let head = s.slice(0, -3); const g = [];
  while (head.length > 2) { g.unshift(head.slice(-2)); head = head.slice(0, -2); }
  if (head) g.unshift(head);
  return `${neg ? '-' : ''}Rs ${g.length ? `${g.join(',')},${tail}` : tail}`;
};
const sign = (docType) => (docType === 'CREDIT_NOTE' || docType === 'ISDC' ? -1 : 1);

// ---------------------------------------------------------------- loaders
function loadRegister(period) {
  const wb = XLSX.readFile(join(FIXTURES, period, 'purchase_register.xlsx'));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const headerAt = rows.findIndex((r) => String(r?.[0] ?? '').startsWith('GSTIN of Supplier'));
  const docTypeOf = { Invoice: 'INVOICE', 'Debit Note': 'DEBIT_NOTE', 'Credit Note': 'CREDIT_NOTE' };
  return rows.slice(headerAt + 1).filter((r) => r && r[0]).map((r, i) => {
    const igst = paise(r[7]), cgst = paise(r[8]), sgst = paise(r[9]), cess = paise(r[10]);
    return {
      row: headerAt + 2 + i, gstin: String(r[0]).trim(), name: String(r[1] ?? '').trim(),
      supplyType: String(r[2]).trim(), docType: docTypeOf[String(r[3]).trim()],
      invoiceNo: String(r[4]).trim(), date: fromDMmmYy(String(r[5]).trim()),
      taxable: paise(r[6]), igst, cgst, sgst, cess, tax: igst + cgst + sgst + cess
    };
  });
}

function loadIms(period) {
  const j = JSON.parse(readFileSync(join(FIXTURES, period, 'ims.json'), 'utf8')).imsDetails;
  const out = [];
  for (const [section, list] of Object.entries(j)) {
    for (const r of list ?? []) {
      const igst = paise(r.iamt), cgst = paise(r.camt), sgst = paise(r.samt), cess = paise(r.cess);
      out.push({
        section, gstin: r.stin, name: r.tradenm, invoiceNo: String(r.inum ?? r.nt_num),
        date: fromDdMmYyyy(r.idt ?? r.nt_dt),
        docType: section.startsWith('b2bcn') ? 'CREDIT_NOTE' : section.startsWith('b2bdn') ? 'DEBIT_NOTE' : 'INVOICE',
        invType: r.inv_typ, pos: r.pos, value: paise(r.val), taxable: paise(r.txval),
        igst, cgst, sgst, cess, tax: igst + cgst + sgst + cess,
        action: r.action, status: r.srcfilstatus, srcform: r.srcform, rtnprd: r.rtnprd,
        pendingBlocked: r.ispendactblocked === 'Y', remarksBlocked: r.isRemarksBlocked === 'Y',
        itcRedBlocked: r.itcRedReqBlocked === 'Y'
      });
    }
  }
  return out;
}

function load2b(period) {
  const j = JSON.parse(readFileSync(join(FIXTURES, period, 'gstr2b.json'), 'utf8'));
  const d = j.docdata;
  const out = [];
  const sum = (items, k) => (items ?? []).reduce((s, it) => s + paise(it[k]), 0);
  for (const g of d.b2b ?? []) for (const inv of g.inv) {
    const igst = sum(inv.items, 'igst'), cgst = sum(inv.items, 'cgst'), sgst = sum(inv.items, 'sgst'), cess = sum(inv.items, 'cess');
    out.push({ section: 'b2b', gstin: g.ctin, name: g.trdnm, filedOn: fromDdMmYyyy(g.supfildt), supprd: g.supprd,
      invoiceNo: String(inv.inum), date: fromDdMmYyyy(inv.dt), docType: 'INVOICE', taxable: sum(inv.items, 'txval'),
      igst, cgst, sgst, cess, tax: igst + cgst + sgst + cess, rev: inv.rev === 'Y', itcavl: inv.itcavl === 'Y', rsn: inv.rsn });
  }
  for (const g of d.cdnr ?? []) for (const nt of g.nt) {
    const igst = sum(nt.items, 'igst'), cgst = sum(nt.items, 'cgst'), sgst = sum(nt.items, 'sgst'), cess = sum(nt.items, 'cess');
    out.push({ section: 'cdnr', gstin: g.ctin, name: g.trdnm, filedOn: fromDdMmYyyy(g.supfildt), supprd: g.supprd,
      invoiceNo: String(nt.ntnum), date: fromDdMmYyyy(nt.ntdt), docType: nt.typ === 'C' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
      taxable: sum(nt.items, 'txval'), igst, cgst, sgst, cess, tax: igst + cgst + sgst + cess,
      rev: nt.rev === 'Y', itcavl: nt.itcavl === 'Y', rsn: nt.rsn });
  }
  for (const g of d.isd ?? []) for (const doc of g.doclist) {
    const tax = paise(doc.igst) + paise(doc.cgst) + paise(doc.sgst) + paise(doc.cess);
    out.push({ section: 'isd', gstin: g.ctin, name: g.trdnm, invoiceNo: doc.docnum, date: fromDdMmYyyy(doc.docdt),
      docType: doc.doctyp, taxable: 0, tax, rev: false, itcavl: doc.itcelg === 'Y' });
  }
  for (const section of ['impg', 'impgsez']) for (const b of d[section] ?? []) {
    out.push({ section, gstin: b.sgstin ?? null, invoiceNo: b.boenum, date: fromDdMmYyyy(b.boedt), docType: 'BOE',
      portCode: b.portcode, taxable: paise(b.txval), tax: paise(b.igst) + paise(b.cess), rev: false, itcavl: true });
  }
  return { rtnprd: j.rtnprd, records: out, amendmentCounts: { b2ba: (d.b2ba ?? []).length, cdnra: (d.cdnra ?? []).length, isda: (d.isda ?? []).length, ecoma: (d.ecoma ?? []).length, ecom: (d.ecom ?? []).length } };
}

const suppliersFile = JSON.parse(readFileSync(join(FIXTURES, 'suppliers.json'), 'utf8'));
const SUPPLIER = new Map(suppliersFile.suppliers.map((s) => [s.gstin, s]));

// ---------------------------------------------------------------- join GT to raw
function take(list, pred, what) {
  const hits = list.filter((x) => !x._used && pred(x));
  if (hits.length !== 1) throw new Error(`${what}: expected 1 raw record, found ${hits.length}`);
  hits[0]._used = true;
  return hits[0];
}

function buildPeriod(period) {
  const gt = JSON.parse(readFileSync(join(FIXTURES, period, 'ground_truth.json'), 'utf8')).documents;
  const pr = loadRegister(period);
  const ims = loadIms(period);
  const twoB = load2b(period);
  const docs = gt.map((g) => {
    const doc = { ...g, period };
    if (g.presence.inBooks) {
      doc.booksRaw = take(pr, (r) => r.gstin === g.books.supplierGstin && r.invoiceNo === g.books.invoiceNo &&
        r.date === g.books.invoiceDate && r.taxable === g.books.taxablePaise, `${g.docId} books`);
      if (doc.booksRaw.tax !== g.books.totalTaxPaise) throw new Error(`${g.docId} books tax disagrees with GT`);
    }
    if (g.presence.inIms) {
      doc.imsRaw = take(ims, (r) => r.gstin === g.portal.supplierGstin && r.invoiceNo === g.portal.invoiceNo &&
        r.date === g.portal.invoiceDate && r.taxable === g.portal.taxablePaise, `${g.docId} ims`);
    }
    if (g.presence.in2b) {
      if (g.section === 'isd') doc.twoBRaw = take(twoB.records, (r) => r.section === 'isd' && r.invoiceNo === g.portal.invoiceNo, `${g.docId} isd`);
      else if (g.section === 'impg' || g.section === 'impgsez') doc.twoBRaw = take(twoB.records, (r) => r.section === g.section && r.invoiceNo === g.portal.boeNum, `${g.docId} boe`);
      else doc.twoBRaw = take(twoB.records, (r) => r.gstin === g.portal.supplierGstin && r.invoiceNo === g.portal.invoiceNo &&
        r.date === g.portal.invoiceDate && r.taxable === g.portal.taxablePaise, `${g.docId} 2b`);
    }
    return doc;
  });
  const leftovers = { pr: pr.filter((r) => !r._used).length, ims: ims.filter((r) => !r._used).length, twoB: twoB.records.filter((r) => !r._used).length };
  return { period, docs, pr, ims, twoB, leftovers };
}

// ---------------------------------------------------------------- the story mutation
function applyStory(byPeriod) {
  const april = byPeriod.get(STORY_PERIOD);
  const imsAll = PRELOADED.flatMap((p) => byPeriod.get(p).ims);
  const candidates = april.docs.filter((d) =>
    d.expectedBucket === 'MATCHED' && d.imsRaw && d.imsRaw.status === 'FILED' && d.imsRaw.section === 'b2b' &&
    !d.imsRaw.pendingBlocked && !d.imsRaw.remarksBlocked && d.booksRaw.taxable > STORY_REDUCE_TAXABLE * 2 &&
    imsAll.filter((r) => r.gstin === d.imsRaw.gstin && r.invoiceNo === d.imsRaw.invoiceNo).length === 1
  ).sort((a, b) => b.booksRaw.tax - a.booksRaw.tax);
  const target = candidates[0];
  const b = target.booksRaw;
  const newTaxable = b.taxable - STORY_REDUCE_TAXABLE;
  const f = newTaxable / b.taxable;
  const scale = (v) => Math.round(v * f);
  const revised = { taxable: newTaxable, igst: scale(b.igst), cgst: scale(b.cgst), sgst: scale(b.sgst), cess: scale(b.cess) };
  revised.tax = revised.igst + revised.cgst + revised.sgst + revised.cess;
  target.story = { original: { taxable: b.taxable, tax: b.tax }, revised };
  target.expectedBucket = 'VALUE_MISMATCH';
  target.portalOverride = revised;
  return target;
}

// ---------------------------------------------------------------- rules (CLAUDE.md)
function portalOf(doc) {
  if (doc.portalOverride) return { ...doc.imsRaw, ...doc.portalOverride };
  return doc.imsRaw ?? doc.twoBRaw ?? null;
}
function cutoffFor(doc, period, scheme) {
  return dayOfNext(period, scheme === 'QUARTERLY' ? 13 : 11);
}
function trueScheme(gstin) { return SUPPLIER.get(gstin)?.scheme ?? 'MONTHLY'; }

// The recommendation the CLAUDE.md table gives, and the one the audit brief's
// direction rule gives (portal lower -> accept + chase the difference; higher -> reject).
function recommend(doc, asOf, scheme) {
  const cut = cutoffFor(doc, doc.period, scheme);
  const pre = asOf <= cut;
  const portal = portalOf(doc);
  const status = doc.imsRaw?.status ?? (doc.twoBRaw ? 'FILED' : null);
  switch (doc.expectedBucket) {
    case 'MATCHED': return { spec: 'ACCEPT' };
    case 'SUGGESTED': return { spec: 'VERIFY' };
    case 'MISSING_IN_BOOKS': return { spec: 'VERIFY' };
    case 'INELIGIBLE': case 'NON_IMS': return { spec: 'NO_ACTION' };
    case 'MISSING_IN_PORTAL': return { spec: pre ? 'CHASE_SUPPLIER' : 'DEFERRED' };
    case 'VALUE_MISMATCH': {
      const dTax = portal.tax - doc.booksRaw.tax;
      const dTaxable = portal.taxable - doc.booksRaw.taxable;
      const direction = dTax < -100 || (Math.abs(dTax) <= 100 && dTaxable < 0) ? 'PORTAL_LOWER' : 'PORTAL_HIGHER';
      let spec;
      if (status === 'SAVED') spec = pre ? 'CHASE_SUPPLIER' : 'UNSPECIFIED(SAVED_AFTER_CUTOFF)';
      else spec = 'REJECT';
      const brief = status === 'SAVED' && pre ? 'CHASE_SUPPLIER' : direction === 'PORTAL_LOWER' ? 'ACCEPT+CHASE_DIFFERENCE' : 'REJECT';
      return { spec, brief, direction, status, dTax, dTaxable, preCutOff: pre };
    }
    default: return { spec: '?' };
  }
}

function itcOf(doc) {
  // Books side when there is one (the trader's own claim), portal side otherwise.
  if (doc.booksRaw) return sign(doc.docType) * doc.booksRaw.tax;
  const p = portalOf(doc);
  return sign(doc.docType === 'ISDC' ? 'ISDC' : doc.docType) * (p?.tax ?? 0);
}

function totalsAt(docs, asOf, schemeOf) {
  const t = { claimable: 0, atRisk: 0, deferred: 0, ineligible: 0, nonIms: 0 };
  const cnt = { claimable: 0, atRisk: 0, deferred: 0, ineligible: 0, nonIms: 0 };
  const split = { deferred: { inv: 0, cn: 0, invN: 0, cnN: 0 } };
  for (const d of docs) {
    const itc = itcOf(d);
    let k;
    switch (d.expectedBucket) {
      case 'MATCHED': k = 'claimable'; break;
      case 'NON_IMS': k = 'nonIms'; break;
      case 'INELIGIBLE': k = 'ineligible'; break;
      case 'MISSING_IN_PORTAL': k = asOf <= cutoffFor(d, d.period, schemeOf(d)) ? 'atRisk' : 'deferred'; break;
      default: k = 'atRisk';
    }
    t[k] += itc; cnt[k] += 1;
    if (k === 'deferred') { if (itc < 0) { split.deferred.cn += itc; split.deferred.cnN++; } else { split.deferred.inv += itc; split.deferred.invN++; } }
  }
  const expected = t.claimable + t.atRisk + t.deferred + t.ineligible;
  return { ...t, expected, grand: expected + t.nonIms, counts: cnt, split };
}

// ---------------------------------------------------------------- Still fixable
function stillFixable(docs, period, asOf, schemeOf) {
  const listed = [];
  const leftOut = [];
  for (const d of docs) {
    if (!d.presence.inBooks) continue;
    const filedInIms = d.imsRaw && d.imsRaw.status === 'FILED';
    if (filedInIms) continue;
    if (d.expectedBucket === 'NON_IMS' || d.expectedBucket === 'INELIGIBLE') { leftOut.push(d); continue; }
    const status = !d.imsRaw ? 'NOT_REPORTED' : d.expectedBucket === 'VALUE_MISMATCH' ? 'SAVED_VALUE_MISMATCH' : 'SAVED_NOT_FILED';
    listed.push({ d, status });
  }
  const bySupplier = new Map();
  for (const item of listed) {
    const g = item.d.booksRaw.gstin;
    if (!bySupplier.has(g)) bySupplier.set(g, []);
    bySupplier.get(g).push(item);
  }
  const suppliers = [...bySupplier.entries()].map(([gstin, items]) => {
    const scheme = schemeOf(items[0].d);
    const cut = dayOfNext(period, scheme === 'QUARTERLY' ? 13 : 11);
    const exposure = items.reduce((s, it) => s + Math.abs(itcOf(it.d)), 0);
    const filedOn = items[0].d.twoBRaw?.filedOn ?? null;
    return {
      gstin, name: items[0].d.booksRaw.name, scheme, cutOff: cut, preCutOff: asOf <= cut,
      daysLeft: daysBetween(asOf, cut), exposure,
      invoices: items.map((it) => ({ no: it.d.booksRaw.invoiceNo, status: it.status, docType: it.d.docType,
        tax: it.d.booksRaw.tax, portalTax: it.d.imsRaw?.tax ?? null, inGstr2b: Boolean(it.d.twoBRaw) }))
    };
  });
  return {
    asOf, supplierCount: suppliers.length, docCount: listed.length,
    exposure: suppliers.reduce((s, x) => s + x.exposure, 0),
    leftOut: { docs: leftOut.length, suppliers: new Set(leftOut.map((d) => d.booksRaw.gstin)).size,
      itc: leftOut.reduce((s, d) => s + Math.abs(itcOf(d)), 0) },
    pastCutOff: suppliers.filter((s) => !s.preCutOff).length,
    suppliers
  };
}

// ---------------------------------------------------------------- supplier filing history
function filingHistory(byPeriod) {
  const rows = [];
  for (const [period, p] of byPeriod) {
    const seen = new Map();
    for (const r of p.twoB.records) if (r.filedOn && r.gstin && !seen.has(r.gstin)) seen.set(r.gstin, r.filedOn);
    for (const [gstin, filedOn] of seen) {
      const s = SUPPLIER.get(gstin);
      const trueCut = dayOfNext(period, s?.scheme === 'QUARTERLY' ? 13 : 11);
      const monthlyCut = dayOfNext(period, 11);
      rows.push({ period, gstin, name: s?.tradeName ?? null, scheme: s?.scheme ?? null, filedOn,
        lateVsTrue: filedOn > trueCut, daysLateTrue: daysBetween(trueCut, filedOn),
        lateIfMonthly: filedOn > monthlyCut, after2bGeneration: filedOn > dayOfNext(period, 14) || filedOn >= dayOfNext(period, 14) });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- main
const byPeriod = new Map(PERIODS.map((p) => [p, buildPeriod(p)]));
const story = applyStory(byPeriod);
const schemeTrue = (d) => trueScheme(d.booksRaw?.gstin ?? d.portal?.supplierGstin);
const schemeMonthly = () => 'MONTHLY';

const out = { generatedFrom: FIXTURES, preloaded: PRELOADED, story: {
  period: STORY_PERIOD, docId: story.docId, supplier: story.booksRaw.name, gstin: story.booksRaw.gstin,
  invoiceNo: story.booksRaw.invoiceNo, books: story.story.original, revised: story.story.revised }, periods: {} };

for (const [period, p] of byPeriod) {
  const docs = p.docs;
  const runAsOf = dayOfNext(period, 16);
  const buckets = {};
  for (const d of docs) {
    const b = (buckets[d.expectedBucket] ??= { count: 0, itc: 0 });
    b.count += 1; b.itc += itcOf(d);
  }
  const asOfs = { d05: dayOfNext(period, 5), d11: dayOfNext(period, 11), d12: dayOfNext(period, 12), d13: dayOfNext(period, 13), d14: dayOfNext(period, 14), d16: runAsOf };
  const valueMismatches = docs.filter((d) => d.expectedBucket === 'VALUE_MISMATCH').map((d) => {
    const r16 = recommend(d, runAsOf, 'MONTHLY');
    const pp = portalOf(d);
    return { docId: d.docId, supplier: d.booksRaw.name, gstin: d.booksRaw.gstin, invoiceNo: d.booksRaw.invoiceNo,
      status: r16.status, direction: r16.direction, booksTaxable: d.booksRaw.taxable, portalTaxable: pp.taxable,
      booksTax: d.booksRaw.tax, portalTax: pp.tax, dTax: r16.dTax, specAt16: r16.spec, briefAt16: r16.brief,
      remarksBlocked: d.imsRaw?.remarksBlocked ?? null, pendingBlocked: d.imsRaw?.pendingBlocked ?? null, story: Boolean(d.story),
      supplierFiledOn: d.twoBRaw?.filedOn ?? null };
  });
  const imsDocs = docs.filter((d) => d.imsRaw);
  const decisionNeeded = docs.filter((d) => ['VALUE_MISMATCH', 'SUGGESTED', 'MISSING_IN_BOOKS'].includes(d.expectedBucket) ||
    (d.expectedBucket === 'MISSING_IN_PORTAL' && runAsOf <= cutoffFor(d, period, schemeTrue(d))));
  const exportExpect = { records: imsDocs.length, A: 0, R: 0, P: 0, N: 0, bySection: {} };
  for (const d of imsDocs) {
    const r = recommend(d, runAsOf, 'MONTHLY').spec;
    const code = r === 'ACCEPT' ? 'A' : r === 'REJECT' ? 'R' : 'N';
    exportExpect[code] += 1;
    const sec = d.imsRaw.section; exportExpect.bySection[sec] = (exportExpect.bySection[sec] ?? 0) + 1;
  }
  const unactioned = imsDocs.reduce((s, d) => s + itcOf(d), 0);
  const risky = imsDocs.filter((d) => d.expectedBucket !== 'MATCHED');
  out.periods[period] = {
    runAsOf, cutOff: dayOfNext(period, 11), twoBGeneration: dayOfNext(period, 14), gstr3bDue: dayOfNext(period, 20),
    rawCounts: { registerRows: p.pr.length, imsRecords: p.ims.length, twoBRecords: p.twoB.records.length, groundTruthDocs: docs.length },
    rawLeftovers: p.leftovers, amendmentSections: p.twoB.amendmentCounts,
    buckets,
    totalsAtRunAsOf: totalsAt(docs, runAsOf, schemeTrue),
    totalsAtRunAsOfMonthly: totalsAt(docs, runAsOf, schemeMonthly),
    decisionNeededCount: decisionNeeded.length,
    nonMatchedCount: docs.filter((d) => d.expectedBucket !== 'MATCHED').length,
    banner: { unactionedCount: imsDocs.length, unactionedItc: unactioned, riskyCount: risky.length, riskyItc: risky.reduce((s, d) => s + itcOf(d), 0) },
    export: exportExpect,
    valueMismatches,
    stillFixable: Object.fromEntries(Object.entries(asOfs).map(([k, a]) => [k, {
      trueScheme: stillFixable(docs, period, a, schemeTrue),
      monthlyAssumed: stillFixable(docs, period, a, schemeMonthly)
    }])),
    qrmpDocsInPeriod: docs.filter((d) => d.supplierScheme === 'QUARTERLY').length,
    lateFiledButIn2b: docs.filter((d) => d.filedLate && d.presence.in2b).map((d) => ({ docId: d.docId, gstin: d.twoBRaw?.gstin, filedOn: d.twoBRaw?.filedOn })),
    savedWhileSupplierFiled: docs.filter((d) => d.imsRaw?.status === 'SAVED').map((d) => ({
      docId: d.docId, supplier: d.booksRaw.name, invoiceNo: d.booksRaw.invoiceNo,
      supplierFiledOn: p.twoB.records.find((r) => r.gstin === d.imsRaw.gstin && r.filedOn)?.filedOn ?? null }))
  };
}
out.filingHistory = filingHistory(byPeriod);
out.suppliers = suppliersFile.suppliers.map((s) => ({ gstin: s.gstin, tradeName: s.tradeName, profile: s.profile, scheme: s.scheme }));

writeFileSync(OUT, JSON.stringify(out, (k, v) => (k === '_used' ? undefined : v), 2));

// ---------------------------------------------------------------- console summary
console.log(`answer key -> ${OUT}`);
console.log(`story: ${out.story.invoiceNo} ${out.story.supplier} taxable ${rs(out.story.books.taxable)} -> ${rs(out.story.revised.taxable)}, tax ${rs(out.story.books.tax)} -> ${rs(out.story.revised.tax)}`);
for (const [period, k] of Object.entries(out.periods)) {
  const t = k.totalsAtRunAsOf;
  console.log(`\n${period} as of ${k.runAsOf}  raw PR ${k.rawCounts.registerRows} IMS ${k.rawCounts.imsRecords} 2B ${k.rawCounts.twoBRecords} GT ${k.rawCounts.groundTruthDocs} leftovers ${JSON.stringify(k.rawLeftovers)}`);
  console.log(`  buckets ${Object.entries(k.buckets).map(([b, v]) => `${b}:${v.count}/${rs(v.itc)}`).join('  ')}`);
  console.log(`  totals  expected ${rs(t.expected)}  claimable ${rs(t.claimable)} (${t.counts.claimable})  atRisk ${rs(t.atRisk)} (${t.counts.atRisk})  deferred ${rs(t.deferred)} (${t.counts.deferred})  ineligible ${rs(t.ineligible)}  nonIms ${rs(t.nonIms)}  grand ${rs(t.grand)}`);
  console.log(`  decisions needed ${k.decisionNeededCount}  (non-MATCHED ${k.nonMatchedCount})  banner ${k.banner.unactionedCount} / ${rs(k.banner.unactionedItc)}  risky ${k.banner.riskyCount} / ${rs(k.banner.riskyItc)}`);
  console.log(`  export ${JSON.stringify(k.export)}`);
  for (const v of k.valueMismatches) console.log(`  VM ${v.supplier.padEnd(24)} ${v.invoiceNo.padEnd(22)} ${v.status} ${v.direction.padEnd(13)} dTax ${rs(v.dTax).padStart(12)}  spec@16 ${v.specAt16.padEnd(8)} brief ${v.briefAt16}${v.story ? '  (story)' : ''}`);
  for (const [key, sf] of Object.entries(k.stillFixable)) {
    const s = sf.trueScheme, m = sf.monthlyAssumed;
    console.log(`  fixable ${key} ${s.asOf}: ${s.docCount} docs / ${s.supplierCount} suppliers / ${rs(s.exposure)}; past cut-off ${s.pastCutOff} (true scheme) vs ${m.pastCutOff} (monthly assumed); left out ${s.leftOut.docs} docs ${s.leftOut.suppliers} suppliers ${rs(s.leftOut.itc)}`);
  }
}
