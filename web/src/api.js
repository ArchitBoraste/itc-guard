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
  imsActionsUrl: (runId) => `/api/runs/${runId}/ims-actions.json`,

  // --- decisions -----------------------------------------------------------
  confirmResult: (resultId, confirmedAction) =>
    json('PATCH', `/api/results/${resultId}`, { confirmedAction }).then((body) => body.result),

  // --- suppliers -----------------------------------------------------------
  listSuppliers: () => request('/api/suppliers?limit=200').then((body) => body.suppliers),
  getSupplier: (gstin) =>
    request(`/api/suppliers/${encodeURIComponent(gstin)}`).then((body) => body.supplier),

  // --- demo ----------------------------------------------------------------
  seedDemo: (taxPeriod) => json('POST', '/api/demo/seed', { taxPeriod })
};
