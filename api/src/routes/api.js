import { Router } from 'express';
import multer from 'multer';
import {
  ServiceError,
  UPLOAD_KINDS,
  commitUpload,
  createUpload,
  listUploads,
  previewUpload
} from '../services/ingest.js';
import {
  confirmResult,
  createRun,
  getRun,
  getRunByPeriod,
  listResults
} from '../services/reconcile.js';
import { rebuildSupplierPeriods, getSupplierHistory, listSuppliers } from '../services/supplierStats.js';
import { buildRunImsActions } from '../services/imsActions.js';
import { BUCKETS } from '../matching/buckets.js';

// Files are held in memory and then stored on the upload row: the preview ->
// commit flow needs the bytes across two requests, and a file storage service is
// out of scope for the prototype.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Stubbed single user. No login yet — every request is org 1.
export function stubAuth(req, res, next) {
  req.orgId = 1;
  req.userId = null;
  next();
}

// Wraps an async handler so a rejected promise reaches the error middleware
// instead of hanging the request.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function apiRouter() {
  const router = Router();
  router.use(stubAuth);

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

  router.post('/uploads/:id/commit', wrap(async (req, res) => {
    const result = await commitUpload(req.orgId, Number(req.params.id), {
      columnMap: req.body?.columnMap ?? null
    });
    res.json(result);
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
    // Supplier stats are a by-product of the run: they need its verdicts to count
    // mismatches per supplier.
    await rebuildSupplierPeriods(req.orgId, run.taxPeriod, { runId: run.id });
    res.status(201).json({ run: await getRun(req.orgId, run.id) });
  }));

  router.get('/runs', wrap(async (req, res) => {
    if (req.query.taxPeriod) {
      const run = await getRunByPeriod(req.orgId, String(req.query.taxPeriod));
      return res.json({ run });
    }
    throw new ServiceError('taxPeriod query parameter is required');
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
    res.json({ suppliers: await listSuppliers(req.orgId, { limit: Number(req.query.limit ?? 200) }) });
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
