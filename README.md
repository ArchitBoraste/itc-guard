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
| `api/` | `npm test` | vitest — integration tests FAIL without a db, see below |
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

## Running the tests

```bash
cd api && npm test
```

Unit suites (adapters, matching, totals) need nothing. The **integration suites
need a live MySQL and they FAIL rather than skip when one is missing** — a green
run with twenty silent skips reads as "verified" and is not.

```bash
docker compose up -d db
cd api && npm run migrate && npm test
```

### The environment variable trap

`.env` is loaded by an absolute path derived from the module's own URL
(`src/config.js`, and `test/setup/env.js` for vitest), so it resolves the same
whether you run from the repo root, from `api/`, or from `/app` in the container.

Loading uses **`override: false`**: a real environment variable beats the file.
That is required — Docker Compose injects `DB_HOST=db` / `DB_PORT=3306` for the
api container and must win over the host-facing values in the repo-root `.env`.

The cost is that **any unrelated `DB_*` left in your shell also wins**, silently
pointing the app at a different database. That is not hypothetical: a stale
`DB_NAME` from another project redirected this app for an entire session, and
`npm run migrate` then created this schema inside that other database.

Every entry point therefore prints what it resolved, and where each value came
from:

```
[test env] database itc@127.0.0.1:3307/itc_guard  [from env file]
[db] connected itc@127.0.0.1:3307/itc_guard  [from env file]
[db] migrating itc@127.0.0.1:3307/itc_guard  [from env file]
```

`[all from environment]` on a machine where you expected the file is the warning
sign. Check with:

```bash
env | grep ^DB_
```

```powershell
Get-ChildItem Env:DB_*
```

The integration suites go further: they verify the target actually holds the ITC
Guard schema, so a reachable-but-wrong database fails with the target named in the
message rather than producing confusing errors.

Set `ITC_QUIET_ENV=1` to silence the per-run banner.

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

`npm run migrate` prints the database it is about to modify before it touches
anything. It is the one command that CREATEs tables, so being pointed at the wrong
database by a stale `DB_NAME` is how this schema ends up somewhere it should not
be.

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

**A total can legitimately be negative.** 2026-04 deferred is −₹5,577.37: an
unreported credit note (−₹28,427.65) netted against an unreported invoice
(+₹22,850.28). The net describes neither, so `GET /api/runs/:id` also returns
`totalsBreakdown`, splitting every total into `creditNotes` / `otherDocuments` /
`byDocType`. Render the components, not the net — and never take an absolute
value to make a total look tidy, which would inflate the claim.

NON_IMS sits outside `expected` deliberately: reverse-charge credit is
self-assessed rather than accepted in IMS, and ISD/import records have no
purchase-register counterpart and no IMS action. It is reported separately so
nothing goes missing.

## Idempotency

**Runs replace, they do not version.** One current run per `(org_id, tax_period)`,
enforced by `uq_runs_org_period`. Re-running updates that row and rebuilds its
`match_results` in one transaction, so row counts stay constant.

**A `confirmed_action` survives the rebuild only while it still applies.** It is
revalidated against the portal `content_hash` and bucket it was made about. If the
supplier corrects the value, a confirmed REJECT is dropped and the result is
flagged `CONFIRMATION_RESET` — otherwise the upload would reject an invoice the
trader now agrees with, costing them a month of credit. IMS behaves the same way:
editing a saved record resets the recipient's action.

**Ordinals are derived from the data, not from arrival order.** Two invoices that
differ only in amount are separated by `identity_seq`, assigned after sorting by
value — so re-uploading the same file with its rows shuffled produces the same
keys and does not insert duplicates.

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
