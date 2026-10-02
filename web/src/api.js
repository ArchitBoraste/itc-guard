// Thin fetch wrapper. Vite proxies /api and /health to the API container.
//
// Every error the API returns is { error, message } with a real status code, and
// callers need both: a 409 on a blocked PENDING is a different thing to show than
// a 500. So the status and code ride on the thrown Error rather than being
// flattened into a string.

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.code = code ?? 'network_error';
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (err) {
    throw new ApiError(`cannot reach the API — ${err.message}`, { code: 'unreachable' });
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null; // a proxy error page, not our JSON
    }
  }

  if (!response.ok) {
    throw new ApiError(body?.message ?? `${response.status} ${response.statusText}`, {
      status: response.status,
      code: body?.error ?? 'http_error'
    });
  }
  return body;
}

const json = (method, path, payload) =>
  request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {})
  });

export const api = {
  health: () => request('/health'),
  org: () => request('/api/org'),

  // --- this visitor's session ----------------------------------------------
  //
  // The first call the app makes. On a public deployment it mints a private org
  // and sets an httpOnly cookie; the cookie rides on every later request because
  // Vite proxies /api to the same origin, so fetch sends it by default.
  //
  // Returns { session: { orgId, state, isNew, error, perVisitor }, pool }.
  // state is READY or PROVISIONING — see PreparingScreen.
  session: () => request('/api/session').then((body) => body.session),

  // Reloads the sample data into the caller's own org. Answers immediately with
  // PROVISIONING; the app polls session() until it is READY again.
  resetSession: () => json('POST', '/api/session/reset').then((body) => body.session),

  // --- uploads -------------------------------------------------------------
  listUploads: () => request('/api/uploads').then((body) => body.uploads),

  uploadFile: (kind, file, taxPeriod = null) => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    if (taxPeriod) form.append('taxPeriod', taxPeriod);
    return request('/api/uploads', { method: 'POST', body: form }).then((body) => body.upload);
  },

  previewUpload: (id, { limit = 8, columnMap = null } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (columnMap) params.set('columnMap', JSON.stringify(columnMap));
    return request(`/api/uploads/${id}/preview?${params}`);
  },

  uploadColumns: (id) => request(`/api/uploads/${id}/columns`),

  commitUpload: (id, columnMap = null) => json('POST', `/api/uploads/${id}/commit`, { columnMap }),

  // What the org already holds per period. The Reconcile button asks the SERVER
  // what has been committed rather than remembering what this page uploaded — a
  // trader re-downloading IMS weekly uploads one file into a period whose other
  // two sources landed weeks ago.
  listPeriods: () => request('/api/periods').then((body) => body.periods),

  // --- runs ----------------------------------------------------------------
  listRuns: () => request('/api/runs').then((body) => body.runs),
  getRunByPeriod: (taxPeriod) =>
    request(`/api/runs?taxPeriod=${encodeURIComponent(taxPeriod)}`).then((body) => body.run),
  getRun: (id) => request(`/api/runs/${id}`).then((body) => body.run),
  createRun: (payload) => json('POST', '/api/runs', payload).then((body) => body.run),

  // The action list works on the whole run at once — it groups and totals across
  // every result, so a partial page would give wrong group totals. Paged here
  // only because the API caps a page at 500.
  listAllResults: async (runId) => {
    const pageSize = 500;
    let page = 1;
    let all = [];
    for (;;) {
      const body = await request(
        `/api/runs/${runId}/results?page=${page}&pageSize=${pageSize}`
      );
      all = all.concat(body.results);
      if (all.length >= body.total || body.results.length === 0) return all;
      page += 1;
    }
  },

  imsActionsSummary: (runId) => request(`/api/runs/${runId}/ims-actions-summary`),

  // --- what moved on the portal since last time ----------------------------
  listChanges: (runId) => request(`/api/changes?runId=${encodeURIComponent(runId)}`),
  // The API holds the file back (409) while any record would go out as N, unless
  // the trader has acknowledged those records.
  imsActionsUrl: (runId, { acknowledgeOpenDecisions = false } = {}) =>
    `/api/runs/${runId}/ims-actions.json` +
    (acknowledgeOpenDecisions ? '?acknowledgeOpenDecisions=true' : ''),

  // --- decisions -----------------------------------------------------------
  confirmResult: (resultId, confirmedAction) =>
    json('PATCH', `/api/results/${resultId}`, { confirmedAction }).then((body) => body.result),

  // "Confirm all": the engine's recommendation on each listed row, in one request.
  // Returns { confirmed: [ids], skipped: [{ resultId, reason }] }.
  confirmRecommendations: (runId, resultIds) =>
    json('POST', `/api/runs/${runId}/confirmations`, { resultIds }),

  // --- preventive alerts ---------------------------------------------------
  //
  // asOf is sent explicitly rather than left to the server clock: the alerts
  // screen lets the trader move through the filing month, and the answer for the
  // 9th has to keep meaning the 9th.
  listAlerts: (taxPeriod, asOf = null) => {
    const params = new URLSearchParams({ taxPeriod });
    if (asOf) params.set('asOf', asOf);
    return request(`/api/alerts?${params}`).then((body) => body.alerts);
  },

  // --- suppliers -----------------------------------------------------------
  // Returns { suppliers, model }. `model` is the provenance of the scorer that
  // produced the bands — the screen has to be able to say what it was fitted on.
  listSuppliers: (taxPeriod = null) => {
    const params = new URLSearchParams({ limit: '200' });
    if (taxPeriod) params.set('taxPeriod', taxPeriod);
    return request(`/api/suppliers?${params}`);
  },
  getSupplier: (gstin) =>
    request(`/api/suppliers/${encodeURIComponent(gstin)}`).then((body) => body.supplier),

  // --- demo ----------------------------------------------------------------
  seedDemo: (taxPeriod) => json('POST', '/api/demo/seed', { taxPeriod })
};
