import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import {
  ServiceError,
  UPLOAD_KINDS,
  commitUpload,
  createUpload,
  deleteUpload,
  getUpload,
  listUploads,
  previewUpload
} from '../services/ingest.js';
import {
  confirmRecommendations,
  confirmResult,
  createRun,
  dismissConfirmationReset,
  getRun,
  getRunByPeriod,
  listPeriodInventory,
  listResults,
  listRuns,
  rerunPeriods
} from '../services/reconcile.js';
import { listChangesForRun } from '../services/syncDiff.js';
import { listCorrections } from '../services/corrections.js';
import { preventiveAlerts } from '../services/preventive.js';
import { DEMO_PERIOD, availableDemoPeriods, seedDemoPeriod } from '../services/demo.js';
import { config } from '../config.js';
import { demoSession } from '../http/session.js';
import { clearWorkspace, tenancyStats } from '../services/demoTenancy.js';
import { describeColumns } from '../adapters/purchaseRegister.js';
import { pool } from '../db/pool.js';
import { getSupplierHistory, listSuppliers } from '../services/supplierStats.js';
import { rebuildSupplierStats, supplierRiskMap, supplierView } from '../services/supplierRisk.js';
import { changeSupplierScheme } from '../services/supplierScheme.js';
import { setSupplierContact } from '../services/supplierContacts.js';
import { modelProvenance } from '../risk/score.js';
import { buildRunImsActions } from '../services/imsActions.js';
import { BUCKETS } from '../matching/buckets.js';
import { FILING_SCHEMES, filingCalendar } from '../matching/cutoff.js';
import { readWorkspaceClock } from '../services/workspaceClock.js';
import { changeWorkspaceClock } from '../services/workspace.js';

// Files are held in memory and then stored on the upload row: the preview ->
// commit flow needs the bytes across two requests, and a file storage service is
// out of scope for the prototype.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Single-user fallback: every request is org 1.
//
// Still the default when DEMO_TENANCY is off, which is how a local dev run and
// the whole test suite behave. The public deployment turns tenancy on and gets
// demoSession instead, which resolves the org from a signed cookie.
export function stubAuth(req, res, next) {
  req.orgId = 1;
  req.userId = null;
  req.sessionState = 'READY';
  next();
}

const defaultAuth = () => (config.demo.enabled ? demoSession : stubAuth);

// Wraps an async handler so a rejected promise reaches the error middleware
// instead of hanging the request.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// `auth` is injectable for one reason: stubAuth pins every request to org 1, and
// org 1 is the RUNNING DEMO — tests are forbidden from touching it (see TEST_ORGS
// in test/helpers/db.js). Without a seam here the only way to exercise a route
// end to end would be against the demo's own data. Production still gets
// stubAuth; only tests pass anything else. Real auth will use this too.
export function apiRouter({ auth = defaultAuth() } = {}) {
  const router = Router();
  router.use(auth);

  // --- this visitor's session ---------------------------------------------

  // The first call the web app makes; on a per-visitor deployment it is what
  // creates the visitor's workspace. state is always READY: a new workspace is
  // empty, so there is nothing to wait for.
  router.get('/session', wrap(async (req, res) => {
    res.json({
      session: {
        orgId: req.orgId,
        state: req.sessionState ?? 'READY',
        isNew: Boolean(req.sessionIsNew),
        error: req.sessionError ?? null,
        // Whether this deployment gives each visitor their own workspace at all.
        // The UI hides "Clear all data" when it does not: on a single-org dev run
        // the button would wipe the developer's own data.
        perVisitor: config.demo.enabled
      },
      pool: config.demo.enabled ? await tenancyStats() : null
    });
  }));

  // "Clear all data": the CALLER's workspace back to empty, the date back to
  // following today, and nothing else touched.
  router.post('/workspace/clear', wrap(async (req, res) => {
    if (!config.demo.enabled) {
      throw new ServiceError(
        'this deployment has one shared workspace, so it is not cleared from here: use ' +
          '"npm run demo:reset"',
        409,
        'conflict'
      );
    }
    const cleared = await clearWorkspace(req.orgId);
    res.json({ cleared, clock: await readWorkspaceClock(req.orgId) });
  }));

  // --- who this is ---------------------------------------------------------

  // The trader's own identity. It goes on every screen and into the IMS upload as
  // rtin, so the UI has to be able to show which GSTIN it is about to file for.
  router.get('/org', wrap(async (req, res) => {
    // gstin is the one the workspace adopted from its files (services/workspaceGstin.js),
    // else the org's own; gstinAdopted says which.
    const [rows] = await pool.query(
      `SELECT id, COALESCE(workspace_gstin, gstin) AS gstin, workspace_gstin IS NOT NULL AS gstin_adopted,
              legal_name, trade_name, state_code, filer_type
         FROM organizations WHERE id = ?`,
      [req.orgId]
    );
    // Which periods in THIS org were loaded from the bundled sample files rather
    // than from something the visitor uploaded. Recognised by the seeder's own
    // filenames (services/demo.js SOURCES), which is enough for a screen that
    // wants to say "the data you are looking at is the sample" without claiming
    // it about a register the visitor dropped in themselves.
    const [seeded] = await pool.query(
      `SELECT DISTINCT tax_period FROM uploads
        WHERE org_id = ? AND tax_period IS NOT NULL
          AND original_filename IN ('purchase_register.xlsx', 'ims.json', 'gstr2b.json')
        ORDER BY tax_period`,
      [req.orgId]
    );
    res.json({
      seededPeriods: seeded.map((row) => row.tax_period),
      org: rows.length
        ? {
            id: rows[0].id,
            gstin: rows[0].gstin,
            gstinAdopted: Boolean(rows[0].gstin_adopted),
            legalName: rows[0].legal_name,
            tradeName: rows[0].trade_name,
            stateCode: rows[0].state_code,
            filerType: rows[0].filer_type
          }
        : null,
      demoPeriods: availableDemoPeriods(),
      defaultDemoPeriod: DEMO_PERIOD
    });
  }));

  // --- the workspace's date --------------------------------------------------

  // { clock: { asOfDate, today, followsToday }, calendar } — calendar only when a
  // taxPeriod is named: that period's deadlines and days left as of the date.
  router.get('/workspace/clock', wrap(async (req, res) => {
    const clock = await readWorkspaceClock(req.orgId);
    res.json({ clock, calendar: await calendarFor(req.orgId, req.query.taxPeriod, clock.asOfDate) });
  }));

  // { asOfDate: 'yyyy-mm-dd' } sets the date; { asOfDate: null } follows today
  // again. Every reconciled period is re-evaluated before this answers.
  router.put('/workspace/clock', wrap(async (req, res) => {
    if (!req.body || !('asOfDate' in req.body)) {
      throw new ServiceError('asOfDate is required: yyyy-mm-dd, or null to follow today');
    }
    const { clock, reruns } = await changeWorkspaceClock(req.orgId, req.body.asOfDate);
    res.json({ clock, reruns, calendar: await calendarFor(req.orgId, req.body.taxPeriod, clock.asOfDate) });
  }));

  // --- demo ----------------------------------------------------------------

  // Seeds one fixture period through the real ingest path. The only route that
  // writes data the user did not upload, so it says exactly what it loaded.
  router.post('/demo/seed', wrap(async (req, res) => {
    const seeded = await seedDemoPeriod(req.orgId, { taxPeriod: req.body?.taxPeriod ?? DEMO_PERIOD });
    res.status(201).json({
      taxPeriod: seeded.taxPeriod,
      runId: seeded.runId,
      run: seeded.run,
      uploads: seeded.uploads.map((upload) => ({
        kind: upload.kind,
        filename: upload.filename,
        rows: upload.parsed
      }))
    });
  }));

  // The demo's sample files (fixtures/demo, or demo-local with real contacts when
  // the presenter generated it), so a visitor can download what the demo uploads.
  router.get('/demo/files', wrap(async (req, res) => {
    const dir = demoFilesDir();
    const files = dir
      ? DEMO_FOLDERS.flatMap((folder) =>
          existsSync(join(dir, folder))
            ? readdirSync(join(dir, folder))
                .filter((name) => DEMO_FILE_NAME.test(name))
                .sort()
                .map((name) => ({
                  folder,
                  name,
                  bytes: statSync(join(dir, folder, name)).size,
                  url: `/api/demo/files/${folder}/${encodeURIComponent(name)}`
                }))
            : []
        )
      : [];
    res.json({ files });
  }));

  router.get('/demo/files/:folder/:name', wrap(async (req, res) => {
    const dir = demoFilesDir();
    const { folder, name } = req.params;
    if (!dir || !DEMO_FOLDERS.includes(folder) || !DEMO_FILE_NAME.test(name) || !existsSync(join(dir, folder, name))) {
      throw new ServiceError('demo file not found', 404, 'not_found');
    }
    res.download(join(dir, folder, name), name);
  }));

  // --- uploads -------------------------------------------------------------

  router.get('/uploads', wrap(async (req, res) => {
    res.json({ uploads: await listUploads(req.orgId) });
  }));

  router.post('/uploads', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new ServiceError('a file is required (multipart field "file")');
    const kind = String(req.body?.kind ?? '').trim().toUpperCase();
    if (!UPLOAD_KINDS.includes(kind)) {
      throw new ServiceError(`kind must be one of ${UPLOAD_KINDS.join(', ')}`);
    }
    const created = await createUpload({
      orgId: req.orgId,
      kind,
      filename: req.file.originalname,
      buffer: req.file.buffer,
      taxPeriod: req.body?.taxPeriod ?? null
    });
    res.status(201).json({ upload: created });
  }));

  router.get('/uploads/:id/preview', wrap(async (req, res) => {
    const preview = await previewUpload(req.orgId, Number(req.params.id), {
      limit: Number(req.query.limit ?? 20),
      columnMap: parseColumnMap(req.query.columnMap),
      allInvoices: req.query.allInvoices === 'true'
    });
    res.json(preview);
  }));

  // The header row as it actually is, plus what auto-mapped. Needed precisely
  // when detection FAILED — preview refuses to parse an unrecognised file, so it
  // cannot be the thing that tells the trader which columns exist.
  router.get('/uploads/:id/columns', wrap(async (req, res) => {
    const upload = await getUpload(req.orgId, Number(req.params.id), { withBytes: true });
    if (upload.kind !== 'PURCHASE_REGISTER') {
      throw new ServiceError('column mapping applies to the purchase register only', 409, 'conflict');
    }
    if (!upload.raw_bytes) throw new ServiceError('upload has no stored bytes', 409, 'conflict');
    res.json({ uploadId: upload.id, ...describeColumns(upload.raw_bytes) });
  }));

  router.post('/uploads/:id/commit', wrap(async (req, res) => {
    const result = await commitUpload(req.orgId, Number(req.params.id), {
      columnMap: req.body?.columnMap ?? null,
      // A register with no document-type column is refused unless the trader
      // confirms every row is an invoice.
      allInvoices: req.body?.allInvoices === true
    });
    // New data makes the period's existing run wrong the instant it lands: the
    // stored verdicts were computed against the old figures, while every read
    // joins the portal rows live. Rebuild every period the file touched rather
    // than leaving a run that renders new numbers under an old answer. A register
    // that set a supplier's filing scheme moves that supplier's cut-off in every
    // period, so then every reconciled period is rebuilt.
    const [runs] = result.filingSchemes.changed
      ? await pool.query('SELECT tax_period FROM runs WHERE org_id = ?', [req.orgId])
      : [[]];
    const reruns = await rerunPeriods(req.orgId, [...result.periods, ...runs.map((run) => run.tax_period)]);
    // `rerun` is the file's own period, as before; `reruns` is every period.
    const rerun = reruns.find((entry) => entry.taxPeriod === result.taxPeriod) ?? null;
    res.json({ ...result, rerun, reruns });
  }));

  // Removes an upload and every row it still owns: for the latest file of a kind
  // and period, that kind's data for the period. The periods it touched are
  // rebuilt; a period left with nothing to reconcile loses its run.
  router.delete('/uploads/:id', wrap(async (req, res) => {
    const deleted = await deleteUpload(req.orgId, Number(req.params.id));
    res.json({ ...deleted, reruns: await rerunPeriods(req.orgId, deleted.periods) });
  }));

  // What the org already holds, per period. The Reconcile button needs this: a
  // trader re-downloading IMS weekly uploads ONE file, and whether the run can go
  // ahead depends on what was committed in every previous session too, not on
  // what happens to be on screen right now.
  router.get('/periods', wrap(async (req, res) => {
    res.json({ periods: await listPeriodInventory(req.orgId) });
  }));

  // --- runs ----------------------------------------------------------------

  // The run is computed against the workspace's date. A per-run date would let two
  // screens read the same supplier on different days, so one is refused rather
  // than quietly ignored.
  router.post('/runs', wrap(async (req, res) => {
    if (req.body && 'asOfDate' in req.body) {
      throw new ServiceError(
        'a run has no date of its own: it uses the workspace date. Set that with ' +
          'PUT /api/workspace/clock',
        400,
        'as_of_is_workspace_wide'
      );
    }
    const run = await createRun({
      orgId: req.orgId,
      taxPeriod: req.body?.taxPeriod,
      mode: req.body?.mode ?? 'REACTIVE',
      filingScheme: req.body?.filingScheme ?? 'MONTHLY'
    });
    // Supplier stats AND the risk band are by-products of the run: the stats need
    // its verdicts to count mismatches, and the band is computed from the stats.
    // One call so neither half can be forgotten — see rebuildSupplierStats().
    await rebuildSupplierStats(req.orgId, run.taxPeriod, { runId: run.id });
    res.status(201).json({ run: await getRun(req.orgId, run.id) });
  }));

  router.get('/runs', wrap(async (req, res) => {
    if (req.query.taxPeriod) {
      const run = await getRunByPeriod(req.orgId, String(req.query.taxPeriod));
      return res.json({ run });
    }
    res.json({ runs: await listRuns(req.orgId, { limit: req.query.limit ?? 36 }) });
  }));

  router.get('/runs/:id', wrap(async (req, res) => {
    res.json({ run: await getRun(req.orgId, Number(req.params.id)) });
  }));

  router.get('/runs/:id/results', wrap(async (req, res) => {
    const bucket = req.query.bucket ? String(req.query.bucket).toUpperCase() : null;
    if (bucket && !Object.values(BUCKETS).includes(bucket)) {
      throw new ServiceError(`bucket must be one of ${Object.values(BUCKETS).join(', ')}`);
    }
    res.json(
      await listResults(req.orgId, Number(req.params.id), {
        bucket,
        page: req.query.page,
        pageSize: req.query.pageSize
      })
    );
  }));

  // Served as a download: this file is uploaded to the portal as-is.
  //
  // A record still carrying N goes to the portal as no action, which is deemed
  // acceptance at GSTR-3B. While any would, the file is held back with the counts
  // by category, and handed over only when the trader asks for it again with
  // acknowledgeOpenDecisions=true.
  router.get('/runs/:id/ims-actions.json', wrap(async (req, res) => {
    const built = await buildRunImsActions(req.orgId, Number(req.params.id));
    const { count, byCategory } = built.openDecisions;
    if (count > 0 && req.query.acknowledgeOpenDecisions !== 'true') {
      return res.status(409).json({
        error: 'open_decisions',
        message:
          `${count} record${count === 1 ? '' : 's'} would go to the portal as N (no action), ` +
          `which is deemed acceptance at GSTR-3B: ${byCategory.phantom.count} not in your ` +
          `books, ${byCategory.verify.count} probably the same invoice, ` +
          `${byCategory.other.count} other. Decide them, or download again with ` +
          'acknowledgeOpenDecisions=true.',
        openDecisions: built.openDecisions
      });
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ims-actions-run-${req.params.id}.json"`
    );
    // The envelope only — the portal rejects anything with extra keys.
    res.send(JSON.stringify(built.json, null, 2));
  }));

  router.get('/runs/:id/ims-actions-summary', wrap(async (req, res) => {
    const built = await buildRunImsActions(req.orgId, Number(req.params.id));
    res.json({ stats: built.stats, warnings: built.warnings, openDecisions: built.openDecisions });
  }));

  // "Confirm all" on an Actions group: records the engine's own recommendation on
  // each listed row. 422 when any of them is not an IMS decision (Verify and the
  // other workflow states are decided one row at a time).
  router.post('/runs/:id/confirmations', wrap(async (req, res) => {
    res.json(
      await confirmRecommendations(req.orgId, Number(req.params.id), {
        resultIds: req.body?.resultIds,
        userId: req.userId
      })
    );
  }));

  // --- what changed since last time ---------------------------------------

  // The change feed for a run, most recent first. Scoped by runId because that is
  // what the trader is looking at: the same period, the same records, and the
  // same decisions the changes may have invalidated.
  router.get('/changes', wrap(async (req, res) => {
    const runId = Number(req.query.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      throw new ServiceError('runId is required');
    }
    res.json(await listChangesForRun(req.orgId, runId, { limit: req.query.limit ?? 200 }));
  }));

  // --- preventive alerts ---------------------------------------------------

  // Who to chase BEFORE the cut-off, ranked by supplier risk, as of the workspace
  // date. An explicit asOf reads the list on another day without moving the
  // workspace: what the trader was told on the 9th, while it is now the 12th.
  router.get('/alerts', wrap(async (req, res) => {
    const taxPeriod = req.query.taxPeriod ? String(req.query.taxPeriod) : null;
    if (!taxPeriod) throw new ServiceError('taxPeriod is required (YYYY-MM)');
    const asOfDate = req.query.asOf ? String(req.query.asOf) : null;
    res.json({ alerts: await preventiveAlerts(req.orgId, { taxPeriod, asOfDate }) });
  }));

  // --- corrections ---------------------------------------------------------

  // Every document an earlier period left waiting on its supplier (not filed,
  // saved but never filed, filed with a different amount), and whether a fix has
  // arrived in this period: where, and the credit it brings here.
  router.get('/corrections', wrap(async (req, res) => {
    res.json({ corrections: await listCorrections(req.orgId, { taxPeriod: req.query.taxPeriod }) });
  }));

  // --- results -------------------------------------------------------------

  router.patch('/results/:id', wrap(async (req, res) => {
    const updated = await confirmResult(req.orgId, Number(req.params.id), {
      confirmedAction: req.body?.confirmedAction,
      userId: req.userId
    });
    res.json({ result: updated });
  }));

  // Dismisses "your decision was dropped" on one row. The warning otherwise stands,
  // across re-runs, until the trader decides that row again. Decides nothing.
  router.post('/results/:id/dismiss-reset', wrap(async (req, res) => {
    res.json({ result: await dismissConfirmationReset(req.orgId, Number(req.params.id)) });
  }));

  // --- suppliers -----------------------------------------------------------

  router.get('/suppliers', wrap(async (req, res) => {
    const requested = req.query.taxPeriod ? String(req.query.taxPeriod) : null;
    // One as-of period and one window for every figure on a row (audit P17).
    const { asOfPeriod, window } = await supplierView(req.orgId, requested);
    const [suppliers, risk] = await Promise.all([
      listSuppliers(req.orgId, { limit: Number(req.query.limit ?? 200), window }),
      supplierRiskMap(req.orgId, asOfPeriod)
    ]);
    res.json({
      asOfPeriod,
      window,
      suppliers: suppliers.map((supplier) => ({ ...supplier, risk: risk.get(supplier.gstin) ?? null })),
      // Named so the UI can say which scorer produced the bands it is showing.
      model: modelProvenance()
    });
  }));

  router.get('/suppliers/:gstin', wrap(async (req, res) => {
    res.json({ supplier: await getSupplierHistory(req.orgId, String(req.params.gstin).toUpperCase()) });
  }));

  // The trader settles a supplier's filing scheme: { scheme: 'MONTHLY' | 'QRMP' },
  // or { scheme: null } to hand it back to inference. Every reconciled period is
  // re-run against the new cut-off before this answers.
  router.put('/suppliers/:gstin/filing-scheme', wrap(async (req, res) => {
    if (!req.body || !('scheme' in req.body)) {
      throw new ServiceError('scheme is required: MONTHLY, QRMP, or null to infer it');
    }
    const scheme = req.body.scheme === null ? null : String(req.body.scheme).toUpperCase();
    res.json(
      await changeSupplierScheme(req.orgId, String(req.params.gstin).toUpperCase(), scheme)
    );
  }));

  // Sets or edits a supplier's contact: { contactPerson, phone, email }, each
  // replaced as given (omitted or empty clears it). The way to reach a supplier
  // who is on the portal but not in the register. A typo GSTIN sets its supplier's.
  router.put('/suppliers/:gstin/contact', wrap(async (req, res) => {
    res.json(await setSupplierContact(req.orgId, String(req.params.gstin).toUpperCase(), req.body ?? {}));
  }));

  return router;
}

const DEMO_FOLDERS = ['aug', 'sep'];
const DEMO_FILE_NAME = /^[A-Za-z0-9_.-]+\.(json|xlsx)$/;

function demoFilesDir() {
  if (!config.fixturesDir) return null;
  return ['demo-local', 'demo'].map((name) => join(config.fixturesDir, name)).find((path) => existsSync(path)) ?? null;
}

// A period's deadlines against the workspace date, for the trader's own filer
// type. null when no period was named.
async function calendarFor(orgId, taxPeriod, asOfDate) {
  if (!taxPeriod) return null;
  if (!/^\d{4}-\d{2}$/.test(String(taxPeriod))) throw new ServiceError('taxPeriod must be YYYY-MM');
  const [rows] = await pool.query('SELECT filer_type FROM organizations WHERE id = ?', [orgId]);
  return filingCalendar(asOfDate, String(taxPeriod), rows[0]?.filer_type ?? FILING_SCHEMES.MONTHLY);
}

function parseColumnMap(value) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new ServiceError('columnMap must be valid JSON');
  }
}
