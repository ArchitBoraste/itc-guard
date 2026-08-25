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
    preventive.js          pre-cut-off alerts, risk banding, chase messages
    supplierRisk.js        persists the band per period to supplier_risk
    imsActions.js          run -> IMS upload JSON
    identity.js            idempotency keys for ingested rows
  src/adapters/            portal/PR parsers — the ONLY place portal field
                           names (ctin, inum, txval, srcfilstatus...) appear
  src/matching/            PURE matching engine — no db, no fs, no network
  src/risk/score.js        serves ml/model.json: standardise, dot, sigmoid
  src/db/pool.js           mysql2/promise pool
  src/db/tx.js             transaction + chunked insert helpers
  src/db/migrate.js        migration runner
  src/db/migrations/       numbered .sql files
  test/                    vitest (unit, accuracy, integration)
web/                       React 18 + Vite front end (plain JS, one stylesheet)
  src/App.jsx              shell, hash routing, run + results state
  src/api.js               fetch wrapper; ApiError carries status + code
  src/index.css            the whole stylesheet — no component library
  src/lib/money.js         integer paise -> Indian-grouped rupees
  src/lib/vocab.js         bucket/action codes -> plain English; action gating
  src/lib/calendar.js      cut-off, 2B generation and GSTR-3B dates
  src/components/          banners, side-by-side compare, score popover, states
                           ErrorBoundary.jsx — the app's only class component
  src/screens/             Upload, Summary, Alerts, Actions, Suppliers
  test/                    vitest + jsdom + @testing-library/react
tools/                     dev tooling (fixtures, weight sweep, demo seed)
ml/                        offline training. train.py fits the supplier risk
                           model; model.json is COMMITTED and read by Node.
                           No Python runs at serve time.
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
| root | `npm run demo:reset` | wipe org 1 and rebuild the presentable demo state |
| root | `npm run sweep:weights` | grid-search matching weights vs ground truth |
| root | `npm run ml:export` | seed org 10 from fixtures, export `ml/training-data.csv` |
| root | `python ml/train.py` | fit the risk model, print metrics, write `ml/model.json` |
| root | `docker compose up --build` | all three services |
| root | `docker compose down -v` | stop and drop the db volume |

### Demo seed

```bash
npm run seed:demo -- 2026-03 --reset
```

Uploads, commits, reconciles and prints the bucket counts, the run totals in paise
and rupees, and the identity check. `--all` does every fixture period.

### Demo reset

```bash
npm run demo:reset
```

One command, one known state, safe to run between practice runs and immediately
before presenting. **It wipes org 1** — that is its purpose, and it prints the
database it is about to clear first. Then it rebuilds:

1. March and April 2026, loaded through the real upload path and reconciled.
2. The largest clean invoice in April confirmed as **Accept** — a decision the
   trader made and would have filed.
3. That same invoice revised downward by the supplier in **both** the IMS and 2B
   downloads, and re-ingested. Both, because the engine merges the same document
   seen in each source into one result keyed partly on money: revising only IMS
   un-merges the pair, the confirmation is orphaned rather than reset, and the
   demo shows nothing.
4. April re-run, which drops the confirmation and flags `CONFIRMATION_RESET`.

It then verifies what it built — exactly one invalidated decision on the change
feed, and a run that is not stale — and refuses to report success otherwise,
because a demo that is subtly not in the state it claims is worse than one that
failed loudly.

The invoice is chosen from the data by a deterministic query, not hard-coded:
`fixtures/` is generated and gitignored, so a fixed invoice number would break the
first time anyone runs `gen:fixtures`.

### Re-running a period

Every period with a run carries a persistent **Re-run reconciliation** button on
Summary. The stale banner on Actions offers the same rebuild, but only once a run
has NOTICED it is out of date — which covers new portal data and nothing else.
After an engine or wording change there is nothing to notice, and uploading a file
to see your own change is a strange requirement. Either path keeps the run's own
mode, as-of date and filing scheme: those decide whether a mismatch is a free
supplier fix or a reject.

## Running the tests

The front end has its own suite. It runs in the web container, which is where its
node_modules live:

```
docker compose exec web npm test
```

It covers the upload panel (a rejected file can be dismissed without unmounting
the app) and the error boundary. A dependency change needs `docker compose build
web`; `test/` and `vitest.config.js` are bind-mounted, so test edits do not.


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

### Test data isolation

`stubAuth` serves every API request as **org 1**, and `npm run seed:demo` writes
there. So org 1 is the running application's data, and no suite may touch it.

Each DB-backed suite owns an id from `TEST_ORGS` in `api/test/helpers/db.js`:

| Suite | org_id | GSTIN |
|---|---|---|
| the application | 1 | `27AABCS1429F1Z8` |
| `ordinalStability.test.js` | 2 | `27AABCS1429F2Z7` |
| `staleConfirmation.test.js` | 3 | `27AABCS1429F3Z6` |
| `negativeTotals.test.js` | 4 | `27AABCS1429F4Z5` |
| `reconcile.test.js` | 5 | `27AABCS1429F5Z4` |

`ensureOrg()` and `resetOrg()` **throw** if handed org 1, so the reservation is
enforced rather than merely documented — a suite that reaches for it fails on its
first setup call instead of quietly deleting the demo.

Note that a suite's own GSTIN is not the one the fixture files were generated for.
Assertions about what an adapter read out of a file use `FIXTURE_TRADER_GSTIN`
(from `ground_truth.json`), not the suite's org GSTIN; conflating the two makes a
test pass by coincidence.

DB-backed files run one at a time (`fileParallelism: false`). Separate org_ids stop
them fighting over rows, but they bulk-insert into the same tables and InnoDB takes
gap locks on shared indexes regardless of org_id — in parallel they deadlocked
about one run in three, and the aborted suite took 7 real tests down with it.

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
| `GET` | `/api/org` | the trader's own GSTIN, plus which sample periods exist |
| `POST` | `/api/demo/seed` | `{ taxPeriod? }` -> loads a fixture period end to end |
| `POST` | `/api/uploads` | multipart `file` + `kind=PURCHASE_REGISTER\|IMS\|GSTR2B` |
| `GET` | `/api/uploads/:id/preview` | detected format + first 20 canonical rows |
| `GET` | `/api/uploads/:id/columns` | header row + auto-mapping, for unrecognised files |
| `POST` | `/api/uploads/:id/commit` | `{ columnMap? }` -> upsert rows |
| `POST` | `/api/runs` | `{ taxPeriod, mode, asOfDate? }` -> run + summary |
| `GET` | `/api/runs` | every reconciled period, newest first |
| `GET` | `/api/runs?taxPeriod=` | the current run for a period |
| `GET` | `/api/runs/:id` | summary, bucket counts, totals |
| `GET` | `/api/runs/:id/results` | `?bucket=&page=&pageSize=` |
| `PATCH` | `/api/results/:id` | `{ confirmedAction }` |
| `GET` | `/api/runs/:id/ims-actions.json` | the portal upload JSON |
| `GET` | `/api/runs/:id/ims-actions-summary` | what is in that file, before downloading it |
| `GET` | `/api/changes?runId=` | what moved on the portal since the last download |
| `GET` | `/api/periods` | what each period holds, and whether it can be reconciled |
| `GET` | `/api/suppliers` | list with stats |
| `GET` | `/api/suppliers/:gstin` | period history |

A `VALUE_MISMATCH` explanation and its portal remark are built from the fields
that actually differ — the same two `classify()` tests, measured with the same
tolerance — so a taxable-only mismatch names the taxable value rather than
quoting a zero tax delta. The remark goes to GSTN as the stated reason for a
rejection, so it names both sides of every differing field and is **ASCII**: the
IMS schema documents 250 characters and nothing about the character set, and a
rupee sign the offline utility refuses would fail the whole upload. The wire
layer transliterates as a last check (`toAsciiRemarks`).

`recommended_action` and `confirmed_action` are stored separately. The IMS action
JSON emits `confirmed_action` where set, otherwise `recommended_action`.
`PATCH /api/results/:id` returns 409 for an action the record's blocked flags
forbid (e.g. `PENDING` where `ispendactblocked` is `Y`).

## Web UI

`http://localhost:5173`. Vite proxies `/api` and `/health` to the API container;
the `/api` prefix is passed through rather than stripped, because the API mounts
its router at `/api`.

Four screens, plus one banner that never leaves the top of the page.

**Upload** — three drop zones. Each shows the detected format and row count once
committed. The column-mapping step appears **only** when detection fails, and only
for CSV: a CSV header is row 1 by definition, whereas an arbitrary `.xlsx` puts its
header at an unknown row and guessing wrong would read a data row as the titles.
With nothing loaded, a **Load sample data** button seeds a fixture period through
the real upload path, so the app is never a dead empty screen.

The mapping form arrives pre-filled. `describeColumns` returns two things: `mapped`,
which is exact and comes from the template alias table, and `suggested`, which
matches the trader's own column titles against a synonym table (`Party GSTIN`,
`Bill No`, `Bill Date`, `Net Amount`) after normalising away case, spacing and
punctuation. Pairs are assigned one-to-one by score, so `Bill Date` goes to the
document date rather than being stolen by the document number. Suggestions are
labelled **guessed** in the form and the label clears when the user changes the
field. Anything the matcher is not confident about is left unset rather than filled
with a plausible wrong answer, because a mis-mapped column silently corrupts every
row in the file. The two tables are kept apart deliberately: `detectFormat` reads
only the exact one, so a fuzzy hit can never make an unrecognised file be parsed as
a GSTN template.

**Summary** — expected / claimable / at risk / deferred, plus a card per bucket.

A total whose net HIDES its components leads with the components instead. 2026-04's
deferred total nets to −₹5,577 out of an unreported credit note of −₹28,428 and an
unreported invoice of +₹22,850; shown as one small negative number it reads like a
rounding artefact and the trader misses two real problems worth ₹51,278 between
them. The split takes over when the net has gone negative or collapsed to less than
half the larger side — not merely whenever credit notes exist, or every card would
cry wolf.

**Actions** — the core screen. Grouped by recommended action, with both sides of
every document side by side and the differing fields marked. The score breakdown is
a click away in a popover. Every row can be overridden, and an overridden row says
so; rows left as recommended say that too.

Controls are gated so the API's 409s are unreachable: `PENDING` is disabled where
the portal blocks it (with the reason on hover), and a record that never entered
IMS — reverse charge, ISD, imports — gets no action buttons at all, because there
is nothing there to accept or reject. Rejecting a whole group takes a second click.

**Suppliers** — filing history per supplier with a days-late sparkline, drawn
against *that supplier's* own cut-off (the 11th monthly, the 13th for QRMP).

**The deemed-acceptance banner** is sticky on every screen. It shows days to
GSTR-3B and two numbers that are deliberately not merged: everything unactioned in
IMS (what deemed acceptance will actually claim) and the slice of it the engine does
not recommend accepting (the real exposure). One number alone is either alarmist or
complacent. A second banner appears when migration 003 has dropped a confirmation
because the supplier amended the record it was about — a decision the trader made
has been invalidated, and that is not a row-level detail.

**Error boundaries.** React unmounts the entire tree when a render throws, so one
bad property access takes the whole page to white — and the nav bar with it, which
leaves no way out. There are two boundaries: one around the routed screen, keyed on
the route so navigating away remounts it and clears the error by itself, and one
around the whole app as a backstop. Both show the actual message and offer a reload.

Money arrives as integer paise and is formatted by integer arithmetic on paise and
digit grouping on the decimal string, so no float ever reaches a rupee figure. Paise
are never displayed.

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

**Committing a source re-runs that period's existing run.** Results are stored,
but every read joins the books and portal rows LIVE — so new data without a
rebuild renders current figures under a month-old verdict: taxable 7,17,915 vs
7,12,915, both flagged different, under "Agrees with the portal", score 1.00,
recommending Accept. The rebuild keeps the run's own mode, as-of date and filing
scheme, because those decide the recommendation. A period with no run yet is left
alone — that is the Reconcile button's decision, not an upload's.

**A result records the portal `content_hash` it was computed from.** When that no
longer matches the record, the row is `stale`: the API refuses to confirm it (409
`stale_run`) and the UI greys out its controls. This is the guard that holds when
the rebuild did not run — it failed, or a tool loaded rows outside the request
cycle. A run that predates the column reports `UNVERIFIABLE` rather than
"current"; not knowing is not the same as being fine, and one re-run settles it.

A **withdrawn** record (`portal_records.absent_since`) is kept separate from
staleness on purpose. Both are un-actionable, but re-running fixes one and can
never fix the other, so a withdrawn row must not carry a "re-run the
reconciliation" prompt that will never clear.

**A `confirmed_action` survives the rebuild only while it still applies.** It is
revalidated against the portal `content_hash` and bucket it was made about. If the
supplier corrects the value, a confirmed REJECT is dropped and the result is
flagged `CONFIRMATION_RESET` — otherwise the upload would reject an invoice the
trader now agrees with, costing them a month of credit. IMS behaves the same way:
editing a saved record resets the recipient's action.

## Sync diffing

Every re-upload of a source is diffed against the last one, per `identity_key`,
**strictly within the same source**: uploading only IMS must never report the
GSTR-2B rows as deleted. `record_changes` gets `AMENDED` (the `content_hash`
moved), `DISAPPEARED` (a supplier withdrew a saved record), `REAPPEARED`,
`STATUS_CHANGE` (`SAVED` -> `FILED`) and `NEW`. A record that is amended *and*
filed in one upload emits both rows — only the amendment was still free to fix.

A **first** upload of a period reports nothing, and re-uploading identical bytes
reports nothing. That is the point: a feed that cries wolf on 400 unchanged rows
is worse than no feed, and it is what the negative cases in
`test/integration/syncDiff.test.js` exist to hold.

`AMENDED` is `CHANGED_AFTER_REVIEW` renamed — the same hash test under a name that
does not claim a review happened. The old value is still read and never written.
`CONFIRMATION_RESET` is a different thing and stays: `AMENDED` is what the portal
did, `CONFIRMATION_RESET` is what that did to a decision, and the latter also
fires on a bucket move with no portal change at all.

`GET /api/changes?runId=` returns the feed, newest first, with the changed fields
and the rupee delta, plus whether the change invalidated a decision. The Actions
screen splits it in two: an alert panel for changes that undid a confirmed
decision, and a quiet collapsed list for records nobody had reviewed yet.

**Ordinals are derived from the data, not from arrival order.** Two invoices that
differ only in amount are separated by `identity_seq`, assigned after sorting by
value — so re-uploading the same file with its rows shuffled produces the same
keys and does not insert duplicates.

**Re-uploading a source updates rows.** `identity_key` is a sha256 over source,
section, supplier GSTIN, doc type, normalised invoice number, invoice date, port
code and an ordinal — deliberately excluding amounts, so an amended record is
recognised as the same row with a changed `content_hash` (`AMENDED`) rather than
as a new document. The spec's proposed key without the date collides
37 times across the fixtures, which would silently overwrite one of a duplicated
invoice pair.

## Supplier risk model

A logistic regression, fitted offline in Python and served from Node. There is no
Python at runtime: `ml/train.py` writes `ml/model.json`, that file is committed,
and `api/src/risk/score.js` standardises, dots and sigmoids it in about twenty
lines.

```bash
npm run ml:export      # seeds org 10 from fixtures, writes ml/training-data.csv
python ml/train.py     # prints metrics and coefficients, writes ml/model.json
```

**Label.** One row per (supplier, period): did that supplier's invoices reach that
period's GSTR-2B, correct and on time? Features are computed over the periods
*before* the label period — filing late in a month is most of that month's label,
so features spanning it would let the model read the answer off its own input.

**Bands.** `LOW < 0.15`, `MEDIUM 0.15–0.40`, `HIGH > 0.40`, then two guards from
phase 7 that the model cannot overrule, because they are claims about how much is
*known* rather than about probability:

- no filing history at all → MEDIUM, never LOW. Absence of data is not evidence of
  reliability.
- HIGH needs 3+ observed periods. A supplier seen once who filed a day late must
  not top the chase list.

The probability is never shown on screen. `topFactors` — the three features that
moved this supplier's score furthest from average — are rendered as the same kind
of plain sentence phase 7 used: *"filed late in 4 of the last 6 months"*. A trader
can disagree with that. They cannot disagree with `0.61`.

### Limitations — read this before trusting a band

**The training data is synthetic.** Every row comes from
`tools/generate-fixtures.js`, which builds the corpus from rules we wrote. The
model has largely learned our own generator. The metrics below are evidence about
that generator and nothing else — no part of this has seen a real GST filing, and
none of it should be presented to a trader, an investor or a judge as evidence
that the model works on real data.

**The sample is small.** 200 supplier-months, 43 of them failures, across 40
suppliers and 5 label periods. One held-out period is about 40 suppliers with
roughly 8 failures in it. Differences of a few points in the figures below are
noise.

**Metrics, held out rather than fitted:**

| | ROC AUC | Avg precision |
|---|---|---|
| Held-out period 2026-07 — logistic regression | 0.935 | 0.742 |
| Held-out period 2026-07 — phase 7 hand-weighted score | 0.900 | 0.614 |
| Leave-one-period-out pooled — logistic regression | 0.897 | 0.680 |
| Leave-one-period-out pooled — phase 7 hand-weighted score | 0.795 | 0.464 |

The model ranks better than the heuristic on data it never saw, on both splits,
which is the only reason it is served. Cross-validation is grouped by **period**,
not by row: a random split would put the same supplier's March and April rows on
both sides, and their features overlap heavily, so the score would be measuring
memory of that supplier rather than prediction.

**Three of the seven requested features could not be learned from this corpus,**
and `train.py` drops them rather than fitting a meaningless coefficient:

| Feature | Why it was dropped |
|---|---|
| `gstr3b_filed_ratio` | Not derivable from anything the app ingests. GSTR-2B carries `cfs`, and `docs/gstr2b-schema.md` records that whether `cfs` means GSTR-1 or GSTR-3B is **unverified**; the fixture generator hard-codes it to `Y` on every record regardless. Exported as an empty column, never as `0` — unknown is not the same as zero. |
| `amendment_rate` | The generator declares `b2ba`/`cdnra`/`ecoma` and never populates them, so it is `0` on all 200 rows. |
| `filed_ratio_6m` | Every supplier in the fixtures reaches 2B every month, so it is `1` on all 200 rows. |

That last one has a consequence worth stating on its own, because no held-out
metric can reveal it: **the model is blind to a supplier who stops reporting
altogether.** It has no coefficient for `filed_ratio_6m`, so a supplier who reached
2B in one month of six scores 0.03 — LOW — identically to a perfect one. The
held-out period contains no such supplier either, which is precisely why the
metrics look fine.

The fix is not to pretend otherwise. `model.json` records the constant value each
dropped feature had, and `outOfDistribution()` in `risk/score.js` compares a
supplier against it: when their value differs, the model has no term for what they
are doing, and `preventive.js` falls back to the phase 7 hand-weighted scorer for
that supplier. The heuristic reads the fact directly and bands them HIGH. The
fallback is not dead code — it also runs whenever `model.json` is missing.

## Status

Phases 0-6 done: skeleton, fixtures, adapters, matching engine, persistence, API,
the web UI and sync diffing. The matching engine scores 100% macro precision/recall/F1 against
`fixtures/ground_truth.json` across all six periods (2,461 documents).

Phase 7 added the pre-cut-off workflow — risk-ranked alerts, per-supplier cut-offs
and returned chase text. Phase 8 replaced the hand-weighted risk score with a
logistic regression trained offline; `supplier_risk` is now populated per period.
**Read the limitations below before believing any of it.**

`npm test` is safe to run against a live demo: every DB-backed suite works in its
own org and org 1 is reserved for the app. See **Test data isolation**.
