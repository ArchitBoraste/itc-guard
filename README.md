# ITC Guard

GST Input Tax Credit reconciliation for small traders. Compares a trader's purchase
register against IMS / GSTR-2B and outputs recommended IMS actions (Accept / Reject /
Pending) with rupee impact, plus a preventive mode that warns before the filing cut-off.

Hackathon prototype — Omnikon 2026, Omni_FinTech_13.

---

## Stack

Node 20 · Express 4 · React 18 + Vite · MySQL 8 · Docker Compose.
Plain JavaScript, ESM only. Raw SQL via `mysql2/promise` — no ORM. Money is integer paise.

## Layout

```
api/                       Express API (ESM, plain JS)
  src/config.js            env -> config
  src/app.js               express app factory (db ping injected)
  src/index.js             server entrypoint
  src/routes/api.js        the /api surface + stub auth
  src/services/            orchestration (db + IO allowed)
    ingest.js              upload -> preview -> commit, idempotent upserts
    reconcile.js           load a period, run the engine, persist the run
    totals.js              run totals in paise, incl. credit-note signs
    supplierStats.js       supplier master + per-period filing behaviour
    imsActions.js          run -> IMS upload JSON
    identity.js            idempotency keys for ingested rows
  src/adapters/            portal/PR parsers — the ONLY place portal field
                           names (ctin, inum, txval, srcfilstatus...) appear
  src/matching/            PURE matching engine — no db, no fs, no network
  src/db/pool.js           mysql2/promise pool
  src/db/tx.js             transaction + chunked insert helpers
  src/db/migrate.js        migration runner
  src/db/migrations/       numbered .sql files
  test/                    vitest (unit, accuracy, integration)
web/                       React 18 + Vite front end
tools/                     dev tooling (fixtures, weight sweep, demo seed)
docs/                      IMS / 2B / purchase-register schemas, domain reference
docker-compose.yml
```

## Setup — Docker (recommended)

```bash
cp .env.example .env
```

```bash
docker compose up --build
```

Then apply the schema (the API container does not migrate on boot):

```bash
docker compose exec api npm run migrate
```

- API → http://localhost:3000/health
- Web → http://localhost:5173
- MySQL → `localhost:3307` (see the port note below)

### MySQL port

Host port 3306 is assumed taken by a native MySQL install, so compose maps the container's
3306 to **3307** on the host. Inside the compose network the API still connects to the `db`
service on **3306** — only the host mapping changes. `DB_PORT=3307` in `.env.example` is
therefore the value for running the API *on the host*; `docker-compose.yml` overrides it to
3306 for the container.

## Setup — local (API on the host, MySQL in Docker)

```bash
docker compose up -d db
```

```bash
cd api && npm install && npm run migrate && npm run dev
```

```bash
cd web && npm install && npm run dev
```

The Vite dev server proxies `/api/*` to the API, so the front end calls `/api/health`.

## Commands

| Where | Command | Does |
|---|---|---|
| `api/` | `npm run dev` | API with `--watch` |
| `api/` | `npm run migrate` | apply pending migrations |
| `api/` | `npm test` | vitest (integration tests skip with no db) |
| `web/` | `npm run dev` | Vite dev server on 5173 |
| root | `npm run gen:fixtures` | regenerate `fixtures/` |
| root | `npm run seed:demo` | load a fixture period end to end for org 1 |
| root | `npm run sweep:weights` | grid-search matching weights vs ground truth |
| root | `docker compose up --build` | all three services |
| root | `docker compose down -v` | stop and drop the db volume |

### Demo seed

```bash
npm run seed:demo -- 2026-03 --reset
```

Uploads, commits, reconciles and prints the bucket counts, the run totals in paise
and rupees, and the identity check. `--all` does every fixture period.

## Health check

```bash
curl http://localhost:3000/health
```

```json
{ "ok": true, "db": true }
```

`db` is the result of a `SELECT 1`. If the database is unreachable the endpoint returns
503 with `{ "ok": false, "db": false }`.

## Migrations

`api/src/db/migrations/*.sql` are plain SQL, applied in filename order. Each applied file
is recorded in `schema_migrations` with a sha256 of its contents, so re-running is a no-op
and editing an already-applied migration is an error — add a new numbered file instead.

Schema conventions:

- Money columns are `BIGINT` **integer paise**. Never floats for currency.
- Dates are `DATE`, read back as ISO `yyyy-mm-dd` strings.
- `tax_period` is `CHAR(7)` `'YYYY-MM'`.
- Every tenant-owned table carries `org_id` and every query filters on it.
  `organizations.id` *is* the org_id.
- `expected_invoices` and `portal_records` both carry the matcher's blocking index
  `(org_id, supplier_gstin, invoice_no_norm, tax_period)`.

Tables: `organizations` `users` `uploads` `expected_invoices` `expected_rate_lines`
`portal_records` `portal_rate_lines` `record_changes` `runs` `match_results` `suppliers`
`supplier_periods` `supplier_risk`.

## Reference docs

Read these before touching `api/src/adapters/**`:

- [docs/ims-json-schema.md](docs/ims-json-schema.md) — IMS read + write JSON
- [docs/gstr2b-schema.md](docs/gstr2b-schema.md) — GSTR-2B JSON and GSTN's own matcher
- [docs/purchase-register-schema.md](docs/purchase-register-schema.md) — both PR formats
- [docs/gst-lifecycle-reference.md](docs/gst-lifecycle-reference.md) — domain background

## API

Stub auth: every request is org 1. No login yet.

| Method | Path | Does |
|---|---|---|
| `POST` | `/api/uploads` | multipart `file` + `kind=PURCHASE_REGISTER\|IMS\|GSTR2B` |
| `GET` | `/api/uploads/:id/preview` | detected format + first 20 canonical rows |
| `POST` | `/api/uploads/:id/commit` | `{ columnMap? }` -> upsert rows |
| `POST` | `/api/runs` | `{ taxPeriod, mode, asOfDate? }` -> run + summary |
| `GET` | `/api/runs?taxPeriod=` | the current run for a period |
| `GET` | `/api/runs/:id` | summary, bucket counts, totals |
| `GET` | `/api/runs/:id/results` | `?bucket=&page=&pageSize=` |
| `PATCH` | `/api/results/:id` | `{ confirmedAction }` |
| `GET` | `/api/runs/:id/ims-actions.json` | the portal upload JSON |
| `GET` | `/api/suppliers` | list with stats |
| `GET` | `/api/suppliers/:gstin` | period history |

`recommended_action` and `confirmed_action` are stored separately. The IMS action
JSON emits `confirmed_action` where set, otherwise `recommended_action`.
`PATCH /api/results/:id` returns 409 for an action the record's blocked flags
forbid (e.g. `PENDING` where `ispendactblocked` is `Y`).

## Money

Integer paise end to end, `BIGINT` columns, no floats and no intermediate
division. Formatting happens at the UI boundary only.

**Credit notes reduce ITC.** Every source reports note amounts as positive
numbers, so the sign is applied in `services/totals.js`. On the 2026-03 fixture,
getting this wrong would inflate claimable ITC by ₹6,73,655.78.

Run totals, and which buckets feed each:

```
claimable  = MATCHED + SUGGESTED confirmed as ACCEPT
atRisk     = VALUE_MISMATCH + MISSING_IN_BOOKS + unconfirmed SUGGESTED
             + MISSING_IN_PORTAL still inside the cut-off
             + anything confirmed REJECT/PENDING
deferred   = MISSING_IN_PORTAL after the cut-off
ineligible = INELIGIBLE
nonIms     = NON_IMS — informational, NOT part of expected
```

Two identities hold exactly, asserted in the integration test:

```
expectedTotalItc = claimable + atRisk + deferred + ineligible
expectedTotalItc + nonIms = grandTotalItc
```

NON_IMS sits outside `expected` deliberately: reverse-charge credit is
self-assessed rather than accepted in IMS, and ISD/import records have no
purchase-register counterpart and no IMS action. It is reported separately so
nothing goes missing.

## Idempotency

**Runs replace, they do not version.** One current run per `(org_id, tax_period)`,
enforced by `uq_runs_org_period`. Re-running updates that row and rebuilds its
`match_results` in one transaction, so row counts stay constant. A
`confirmed_action` survives the rebuild.

**Re-uploading a source updates rows.** `identity_key` is a sha256 over source,
section, supplier GSTIN, doc type, normalised invoice number, invoice date, port
code and an ordinal — deliberately excluding amounts, so an amended record is
recognised as the same row with a changed `content_hash` (`CHANGED_AFTER_REVIEW`)
rather than as a new document. The spec's proposed key without the date collides
37 times across the fixtures, which would silently overwrite one of a duplicated
invoice pair.

## Status

Phases 0-4 done: skeleton, fixtures, adapters, matching engine, persistence and
API. The matching engine scores 100% macro precision/recall/F1 against
`fixtures/ground_truth.json` across all six periods (2,461 documents).

Not built yet: the web UI beyond a health check, supplier risk scoring
(`supplier_risk` is migrated but unpopulated), and the WhatsApp/chase message
generation.
