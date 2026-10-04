// Thin fetch wrapper. Vite proxies /api and /health to the API container.
//
// Every error the API returns is { error, message } with a real status code, and
// callers need both: a 409 on a 2B uploaded before the 14th is a different thing
// to show than a 500. So the status, code and body ride on the thrown Error.

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.code = code ?? 'network_error';
    this.body = body ?? null;
  }
}

async function send(path, options = {}) {
  try {
    return await fetch(path, options);
  } catch (err) {
    throw new ApiError(`Cannot reach ITC Guard's server (${err.message}).`, { code: 'unreachable' });
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // a proxy error page, not our JSON
  }
}

async function request(path, options = {}) {
  const response = await send(path, options);
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(body?.message ?? `${response.status} ${response.statusText}`, {
      status: response.status,
      code: body?.error ?? 'http_error',
      body
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

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  // --- this visitor's workspace ---------------------------------------------
  // The first call the app makes: on a public deployment it creates the
  // visitor's private workspace and sets its cookie.
  session: () => request('/api/session').then((body) => body.session),
  org: () => request('/api/org'),
  clearWorkspace: () => json('POST', '/api/workspace/clear'),

  // { clock: { asOfDate, today, followsToday }, calendar } — the calendar is the
  // period's deadlines as of the workspace date.
  clock: (taxPeriod = null) => request(`/api/workspace/clock${query({ taxPeriod })}`),
  // Moving the date re-runs every reconciled period before it answers.
  setClock: (asOfDate, taxPeriod = null) => json('PUT', '/api/workspace/clock', { asOfDate, taxPeriod }),

  // --- uploads ---------------------------------------------------------------
  listUploads: () => request('/api/uploads').then((body) => body.uploads),
  uploadFile: (kind, file) => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    return request('/api/uploads', { method: 'POST', body: form }).then((body) => body.upload);
  },
  uploadColumns: (id) => request(`/api/uploads/${id}/columns`),
  previewUpload: (id, { columnMap = null, allInvoices = false } = {}) =>
    request(
      `/api/uploads/${id}/preview${query({
        limit: 8,
        columnMap: columnMap ? JSON.stringify(columnMap) : null,
        allInvoices: allInvoices ? 'true' : null
      })}`
    ),
  commitUpload: (id, { columnMap = null, allInvoices = false } = {}) =>
    json('POST', `/api/uploads/${id}/commit`, { columnMap, allInvoices }),
  deleteUpload: (id) => request(`/api/uploads/${id}`, { method: 'DELETE' }),
  // What the workspace holds per period, and whether it has a run.
  listPeriods: () => request('/api/periods').then((body) => body.periods),
  listDemoFiles: () => request('/api/demo/files').then((body) => body.files),

  // --- runs ------------------------------------------------------------------
  getRunByPeriod: (taxPeriod) => request(`/api/runs${query({ taxPeriod })}`).then((body) => body.run),
  createRun: (taxPeriod) => json('POST', '/api/runs', { taxPeriod }).then((body) => body.run),

  // Every result of a run. Grouping and totals work on the whole set, so the
  // 500-row pages are read to the end.
  listAllResults: async (runId) => {
    let page = 1;
    let all = [];
    for (;;) {
      const body = await request(`/api/runs/${runId}/results${query({ page, pageSize: 500 })}`);
      all = all.concat(body.results);
      if (all.length >= body.total || body.results.length === 0) return all;
      page += 1;
    }
  },

  // The IMS action file. 409 open_decisions while any record would go out as N,
  // unless the trader has acknowledged them. Returns { blob, filename }.
  downloadImsActions: async (runId, { acknowledgeOpenDecisions = false } = {}) => {
    const response = await send(
      `/api/runs/${runId}/ims-actions.json${query({ acknowledgeOpenDecisions: acknowledgeOpenDecisions ? 'true' : null })}`
    );
    if (!response.ok) {
      const body = await readJson(response);
      throw new ApiError(body?.message ?? `${response.status} ${response.statusText}`, {
        status: response.status,
        code: body?.error ?? 'http_error',
        body
      });
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `ims-actions-run-${runId}.json`;
    return { blob: await response.blob(), filename };
  },

  // --- decisions -------------------------------------------------------------
  confirmResult: (resultId, confirmedAction) =>
    json('PATCH', `/api/results/${resultId}`, { confirmedAction }).then((body) => body.result),
  // The recommendation on each listed row, in one request.
  confirmRecommendations: (runId, resultIds) => json('POST', `/api/runs/${runId}/confirmations`, { resultIds }),
  dismissReset: (resultId) => json('POST', `/api/results/${resultId}/dismiss-reset`),

  // --- suppliers' side ---------------------------------------------------------
  listAlerts: (taxPeriod) => request(`/api/alerts${query({ taxPeriod })}`).then((body) => body.alerts),
  listCorrections: (taxPeriod) =>
    request(`/api/corrections${query({ taxPeriod })}`).then((body) => body.corrections),
  listSuppliers: (taxPeriod) => request(`/api/suppliers${query({ taxPeriod, limit: 200 })}`),
  setFilingScheme: (gstin, scheme) =>
    json('PUT', `/api/suppliers/${encodeURIComponent(gstin)}/filing-scheme`, { scheme }),
  setContact: (gstin, contact) =>
    json('PUT', `/api/suppliers/${encodeURIComponent(gstin)}/contact`, contact),

  // --- supplier email --------------------------------------------------------
  // { mail: { enabled, fromName, traderPhone, dailyLimit, sentToday }, threads }
  listMessages: () => request('/api/messages'),
  // { count, version, latest }: what the bells poll.
  unreadMessages: () => request('/api/messages/unread'),
  // { supplierGstin, documentRefs, subject, body, taxPeriod, context } -> thread
  sendMessage: (message) => json('POST', '/api/messages', message).then((body) => body.thread),
  markSupplierRead: (supplierGstin) => json('POST', '/api/messages/read', { supplierGstin })
};
