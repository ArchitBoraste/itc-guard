import { Router } from 'express';
import multer from 'multer';
import {
  ServiceError,
  UPLOAD_KINDS,
  commitUpload,
  createUpload,
  getUpload,
  listUploads,
  previewUpload
} from '../services/ingest.js';
import {
  confirmResult,
  createRun,
  getRun,
  getRunByPeriod,
  listPeriodInventory,
  listResults,
  listRuns,
  rerunPeriodIfRun
} from '../services/reconcile.js';
import { listChangesForRun } from '../services/syncDiff.js';
import { preventiveAlerts } from '../services/preventive.js';
import { DEMO_PERIOD, availableDemoPeriods, seedDemoPeriod } from '../services/demo.js';
import { config } from '../config.js';
import { demoSession, requireReadySession } from '../http/session.js';
import { resetSession, tenancyStats } from '../services/demoTenancy.js';
import { describeColumns } from '../adapters/purchaseRegister.js';
import { pool } from '../db/pool.js';
import { getSupplierHistory, listSuppliers } from '../services/supplierStats.js';
import { rebuildSupplierStats, supplierRiskMap } from '../services/supplierRisk.js';
import { modelProvenance } from '../risk/score.js';
import { buildRunImsActions } from '../services/imsActions.js';
import { BUCKETS } from '../matching/buckets.js';

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

  // The first call the web app makes. It is what mints a session, so it is
  // mounted ABOVE requireReadySession — it has to answer while the org it just
  // created is still being seeded, since saying "not ready yet" is its whole job
  // in that case.
  //
  // state: READY        use the app
  //        PROVISIONING show "preparing your demo data" and poll this again
  router.get('/session', wrap(async (req, res) => {
    res.json({
      session: {
        orgId: req.orgId,
        state: req.sessionState ?? 'READY',
        isNew: Boolean(req.sessionIsNew),
        // Set when a seed or a reset failed. The screen shows it with a retry
        // rather than dropping the visitor into an empty app with no explanation.
        error: req.sessionError ?? null,
        // Whether this deployment gives each visitor their own copy at all. The
        // UI hides "Reset my data" when it does not — on a single-org dev run the
        // button would wipe the developer's own data.
        perVisitor: config.demo.enabled
      },
      pool: config.demo.enabled ? await tenancyStats() : null
    });
  }));

  // "Reset my data". Wipes and rebuilds the CALLER's org and nothing else, then
  // answers PROVISIONING so the UI switches to the same preparing screen a cold
  // first visit uses.
  router.post('/session/reset', wrap(async (req, res) => {
    if (!config.demo.enabled) {
      throw new ServiceError(
        'per-visitor demo data is not enabled on this deployment — use "npm run demo:reset"',
        409,
        'conflict'
      );
    }
    const result = await resetSession(req.orgId);
    res.status(202).json({ session: { orgId: req.orgId, state: result.state, error: null } });
  }));

  // From here down, every route needs an org whose data is actually there.
  router.use(requireReadySession);

  // --- who this is ---------------------------------------------------------

  // The trader's own identity. It goes on every screen and into the IMS upload as
  // rtin, so the UI has to be able to show which GSTIN it is about to file for.
  router.get('/org', wrap(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT id, gstin, legal_name, trade_name, state_code, filer_type FROM organizations WHERE id = ?',
      [req.orgId]
    );
    res.json({
      org: rows.length
        ? {
            id: rows[0].id,
            gstin: rows[0].gstin,
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

  // --- demo ----------------------------------------------------------------

  // Seeds one fixture period through the real ingest path. The only route that
  // writes data the user did not upload, so it says exactly what it loaded.
  router.post('/demo/seed', wrap(async (req, res) => {
    const seeded = await seedDemoPeriod(req.orgId, {
      taxPeriod: req.body?.taxPeriod ?? DEMO_PERIOD,
      asOfDate: req.body?.asOfDate ?? null
    });
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
      columnMap: parseColumnMap(req.query.columnMap)
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
      columnMap: req.body?.columnMap ?? null
    });
    // New data makes the period's existing run wrong the instant it lands: the
    // stored verdicts were computed against the old figures, while every read
    // joins the portal rows live. Rebuild it here rather than leaving a run that
    // renders new numbers under an old answer.
    const rerun = await rerunPeriodIfRun(req.orgId, result.taxPeriod);
    res.json({ ...result, rerun });
  }));

  // What the org already holds, per period. The Reconcile button needs this: a
  // trader re-downloading IMS weekly uploads ONE file, and whether the run can go
  // ahead depends on what was committed in every previous session too, not on
  // what happens to be on screen right now.
  router.get('/periods', wrap(async (req, res) => {
    res.json({ periods: await listPeriodInventory(req.orgId) });
  }));

  // --- runs ----------------------------------------------------------------

  router.post('/runs', wrap(async (req, res) => {
    const run = await createRun({
      orgId: req.orgId,
      taxPeriod: req.body?.taxPeriod,
      mode: req.body?.mode ?? 'REACTIVE',
      asOfDate: req.body?.asOfDate ?? null,
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
  router.get('/runs/:id/ims-actions.json', wrap(async (req, res) => {
    const built = await buildRunImsActions(req.orgId, Number(req.params.id));
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
    res.json({ stats: built.stats, warnings: built.warnings });
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

  // Who to chase BEFORE the cut-off, ranked by supplier risk.
  //
  // asOf is a request parameter, not the server clock, for two reasons: the demo
  // walks through the month (the 5th, the 10th, the 12th, the 16th) without
  // touching the system clock, and a trader reviewing what they were told on the
  // 9th needs the answer as it stood on the 9th. It defaults to the period's run
  // as-of date so the alerts screen and the rest of the app share one clock.
  router.get('/alerts', wrap(async (req, res) => {
    const taxPeriod = req.query.taxPeriod ? String(req.query.taxPeriod) : null;
    if (!taxPeriod) throw new ServiceError('taxPeriod is required (YYYY-MM)');

    let asOf = req.query.asOf ? String(req.query.asOf) : null;
    if (!asOf) {
      const [rows] = await pool.query(
        'SELECT as_of_date FROM runs WHERE org_id = ? AND tax_period = ?',
        [req.orgId, taxPeriod]
      );
      asOf = rows[0]?.as_of_date ?? null;
    }

    res.json({ alerts: await preventiveAlerts(req.orgId, { taxPeriod, asOfDate: asOf }) });
  }));

  // --- results -------------------------------------------------------------

  router.patch('/results/:id', wrap(async (req, res) => {
    const updated = await confirmResult(req.orgId, Number(req.params.id), {
      confirmedAction: req.body?.confirmedAction,
      userId: req.userId
    });
    res.json({ result: updated });
  }));

  // --- suppliers -----------------------------------------------------------

  router.get('/suppliers', wrap(async (req, res) => {
    const asOfPeriod = req.query.taxPeriod ? String(req.query.taxPeriod) : null;
    const [suppliers, risk] = await Promise.all([
      listSuppliers(req.orgId, { limit: Number(req.query.limit ?? 200) }),
      supplierRiskMap(req.orgId, asOfPeriod)
    ]);
    res.json({
      suppliers: suppliers.map((supplier) => ({ ...supplier, risk: risk.get(supplier.gstin) ?? null })),
      // Named so the UI can say which scorer produced the bands it is showing.
      model: modelProvenance()
    });
  }));

  router.get('/suppliers/:gstin', wrap(async (req, res) => {
    res.json({ supplier: await getSupplierHistory(req.orgId, String(req.params.gstin).toUpperCase()) });
  }));

  return router;
}

function parseColumnMap(value) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new ServiceError('columnMap must be valid JSON');
  }
}
