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
  src/routes/              HTTP routes
  src/services/            orchestration (db + IO allowed)
  src/adapters/            portal/PR parsers — the ONLY place portal field
                           names (ctin, inum, txval, srcfilstatus...) appear
  src/matching/            PURE matching engine — no db, no fs, no network
  src/db/pool.js           mysql2/promise pool
  src/db/migrate.js        migration runner
  src/db/migrations/       numbered .sql files
  test/                    vitest
web/                       React 18 + Vite front end
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
| `api/` | `npm test` | vitest |
| `web/` | `npm run dev` | Vite dev server on 5173 |
| root | `docker compose up --build` | all three services |
| root | `docker compose down -v` | stop and drop the db volume |

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

## Status

Skeleton only — no business logic yet. Adapters, the matching engine, recommendations and
the IMS export are not implemented.
