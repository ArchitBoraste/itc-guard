# ITC Guard

**A small shop pays tax on what it buys, and gets that money back only if its supplier
files the paperwork correctly and on time. When the supplier gets it wrong, the shop
loses the money — and usually finds out too late to do anything about it.**

ITC Guard reads the shop's own purchase records, compares them against what the tax
portal is actually showing, and produces a list of decisions with a rupee figure against
each one. It does that early enough in the month that a supplier's mistake can still be
corrected for free, and it writes the file the portal needs to record those decisions.

Hackathon prototype — Omnikon 2026, team Omni_FinTech_13. Nothing here has been run
against a real tax filing. See [Current status and limitations](#current-status-and-limitations).

---

## The problem

Under GST, a trader pays tax to their suppliers on every purchase and reclaims it from
the government. That reclaim — **input tax credit** — only works if the supplier reports
the invoice correctly on the government portal. If the supplier types ₹42,700 where they
meant ₹47,200, or files a week late, or never files at all, the trader silently loses
that money.

Three things make it worse than an ordinary data-matching problem:

- **Silence counts as agreement.** Anything the trader does not explicitly reject on the
  portal is *deemed accepted* when they file. A wrong invoice nobody looked at becomes a
  credit they claimed and are liable for.
- **The window closes.** Before the supplier files their return, a mistake is a phone
  call — they edit the draft, and nothing is lost. After they file, the fix legally
  reaches the trader's account in the *next* month. Same error, one week later, a month
  of cash flow gone.
- **The government's own matching tool cannot find these.** It matches only invoices
  whose every field already agrees exactly. Precisely the broken ones fall out of it.

A large company has an accounts team for this. A shop with four hundred invoices a month
has one person and a spreadsheet.

## What the tool does

Three files go in — all three are downloads the trader already has:

| File | What it is |
|---|---|
| Purchase register | The shop's own record of what it bought. Excel or CSV. |
| IMS download | What suppliers have entered on the portal, including drafts they have not filed yet. |
| GSTR-2B download | The month's locked snapshot — the legal basis for the claim. |

One action list comes out. Every document is placed in a bucket, given a recommended
action, and priced:

```
ACCEPT           this agrees with your books
REJECT           this is on the portal and not in your books
CHASE SUPPLIER   the amounts differ and the supplier can still fix it for free
VERIFY           we found a likely match but not a certain one — you decide
DEFERRED         the supplier never reported it; the credit moves to next month
```

Every row shows both sides of the document side by side with the differing fields
marked, and a score breakdown saying why the engine paired them. Nothing is
auto-rejected: a wrong rejection costs the trader a month of credit and raises the
supplier's liability, so a grey-zone match asks for a human.

Then it writes **`ims-actions.json`** — the exact upload format GSTN's own IMS offline
utility produces, so the trader's decisions go back to the portal as a file rather than
as four hundred clicks.

And before any of that, the **Not filed yet** screen: from the 1st of the month it lists
the purchases the supplier has not filed yet — not on the portal at all, or sitting there
as a draft they can still change — against each supplier's own cut-off, with a short
message to send them. Before the cut-off a phone call fixes it for free; after it,
correcting it needs a GSTR-1A amendment and the credit slips a month, and **Corrections**
follows it into the next month until it arrives. The suppliers never need an account, a
login, or to know the tool exists.

## Why the government's own tool cannot do this

GSTN publishes a *GSTR-2B Matching Offline Tool* (v2.9). We unpacked it. Its entire
matcher is two SQL views:

- **ExactMatch** — an inner join requiring *every* field equal: supply type, GSTIN,
  document number, document type, document date, taxable value, and every tax head.
- **ProbableMatch** — the "fuzzy" tier. It allows exactly **one** of GSTIN *or* document
  type to differ. Document number, date, taxable value and every tax head must still be
  **exactly** equal.

That is the whole algorithm. It follows that the five most common real defects are
structurally unmatchable by it:

| The supplier's mistake | GSTN tool v2.9 | ITC Guard |
|---|---|---|
| Number written differently — `INV/2024/0891` vs `INV-2024-891` | no match | matched — numbers are normalised before comparison |
| Amount off by a rupee or two, from rounding | no match | matched — tolerance of ₹1 or 0.5% |
| Invoice date off by a day | no match | matched — date proximity is scored, not required |
| Transposed digit — ₹47,200 entered as ₹42,700 | no match | matched, and flagged `VALUE_MISMATCH` with the ₹4,500 delta |
| Wrong supplier GSTIN typed | only if the number, date and *every* tax head are exactly equal | matched on number and value, flagged `GSTIN_MISMATCH` |

Everything the official tool cannot match lands in an unmatched pile for someone to
eyeball. That pile is the product.

The two tools deliberately share a vocabulary — the same field names, the same document
types, the same section codes — so the results are directly comparable. The difference is
normalisation, tolerance, and being able to say *why*.

## Quick start

Docker is the only prerequisite. From the repository root:

```bash
npm run demo
```

That brings up the three containers, waits for MySQL to actually be ready, applies
migrations, and rebuilds a known demo state. It prints a URL — **http://localhost:5173**
— and deliberately does not open a browser.

It is safe to run twice, and safe to run thirty seconds before presenting: every step is
either a no-op when already done or a full wipe-and-rebuild. If Docker is not running it
says so in one sentence and stops.

To stop everything: `docker compose down`.

## Sample files

`samples/2026-04/` holds one tax period's three files, committed so there is something to
look at without running the generator. They are the same files the **Load sample period**
button feeds through the app.

| File | What it is | Where a trader gets the real one |
|---|---|---|
| `purchase_register.xlsx` | The trader's own books — every inward document they recorded for the month, one row per invoice × tax rate. GSTN template v2.4. | Exported from their accounting software (Tally, Busy, Zoho Books, Marg). GSTN's own v2.4 template ships inside the GSTR-2B offline matching tool, and every package can export to something close to it. |
| `ims.json` | What suppliers have put into the **Invoice Management System** — including records they have only *saved* and not yet filed. This is the source that exists before the cut-off. | gst.gov.in → Returns → Invoice Management System (IMS) → Download, or through the IMS offline utility. Available from the moment a supplier saves; there is no waiting for a generation date. |
| `gstr2b.json` | The month's **GSTR-2B** — the static, filed-only statement of the credit available. Ten sections, including the reverse-charge, ISD and import records that never pass through IMS. | gst.gov.in → Returns Dashboard → GSTR-2B → Download JSON. Generated on the **14th** of the month after the tax period and never changes afterwards. |

The other five periods are generated rather than committed — `npm run gen:fixtures` writes
all six into `fixtures/`, which is gitignored. `samples/` is not: the `fixtures/` ignore
rule matches a directory of that name, not this one.

The data is synthetic end to end. No real GSTIN, invoice or filing appears in any of it —
see **Limitations** below.

## Architecture

```
purchase register ─┐
IMS download ──────┼─► adapters ─► canonical shapes ─► matching engine ─► buckets
GSTR-2B download ──┘   (the only     (ExpectedInvoice   (pure: no db,      + recommended
                        place portal   PortalRecord)     no fs, no net)     actions
                        field names                            │
                        appear)                                ▼
                                                    persisted run ─► React UI
                                                          │           (5 screens)
                                                          ▼
                                                    ims-actions.json
                                                    (portal upload format)
```

- **`api/src/adapters/`** — the only code that knows portal field names (`ctin`, `inum`,
  `txval`, `srcfilstatus`). Everything downstream sees canonical shapes and integer paise.
- **`api/src/matching/`** — the scoring engine. Pure: no database, no filesystem, no
  network, enforced by a test. This is where the five defect classes above are handled.
- **`api/src/services/`** — orchestration. Ingest, reconcile, totals, preventive alerts,
  supplier statistics, the IMS action writer.
- **`api/src/risk/`** — serves a logistic regression fitted offline in Python. `ml/train.py`
  writes `ml/model.json`, that file is committed, and Node reads it. No Python at runtime.
- **`web/src/screens/`** — Upload, Overview, IMS decisions, Not filed yet, Corrections,
  Suppliers, Help. React 18, design tokens as CSS variables, IBM Plex self-hosted, no
  component library.
- **MySQL 8**, raw SQL, no ORM. Money is `BIGINT` integer paise end to end.

Plain JavaScript throughout, ESM only. Node 20 · Express 4 · React 18 + Vite · MySQL 8 ·
Docker Compose.

## Test status

**666 API tests and 135 front-end tests**, all passing. The count is not the point; what
they hold is:

| Suite | What it actually verifies |
|---|---|
| `matching/purity` | The engine imports no database, filesystem or network module. The scoring logic can be reasoned about in isolation, and is. |
| `matching/accuracy` | The engine measured against `fixtures/ground_truth.json` — 2,461 labelled documents across six periods, per bucket, precision and recall. Currently 100% macro on all six. |
| `adapters/*` | Both purchase-register formats, both portal formats, every section, and the IMS upload writer round-tripping through the schema the offline utility expects. |
| `services/totals` | Credit notes carry a negative sign. On the 2026-03 fixture, getting that wrong would inflate claimable credit by ₹6,73,655.78. Two accounting identities are asserted exactly. |
| `integration/syncDiff` | Re-uploading the same file reports no changes; uploading only IMS never reports the 2B rows as deleted; an amended record is the same document with new amounts, not a new document. |
| `integration/staleConfirmation` | A confirmed decision is dropped when the supplier amends the record it was about, and the API returns 409 rather than accepting it. Through the real HTTP route, against MySQL. |
| `integration/ordinalStability` | Re-uploading a file with its rows shuffled produces the same keys and inserts no duplicates. |
| `risk/score` | The model's arithmetic against fitted coefficients, and the out-of-distribution check that hands a supplier back to the fallback scorer. |
| `web/errorBoundary` | A component that throws does not white-screen the app, and the navigation survives it. |
| `web/uploadScreen`, `web/staleRun` | A rejected file can be dismissed without unmounting the app; a stale row cannot be accepted however clean its verdict looks. |

Integration suites **fail rather than skip** when MySQL is missing. A green run with
twenty silent skips reads as "verified" and is not.

```bash
cd api && npm test                    # needs MySQL up
docker compose exec web npm test      # front end
```

## Current status and limitations

Read this before believing any number in this repository.

**Accuracy is measured against synthetic ground truth, and has never been validated on a
live filing.** The 100% macro precision/recall figure is real, and it is a measurement
against `fixtures/ground_truth.json` — a corpus this project generated, whose answers
this project also wrote. It says the engine does what we specified. It says nothing about
how a real trader's register compares against a real GSTR-2B, because we have never seen
one. Getting real, anonymised files in front of this is the single highest-value thing
left to do.

**Recommendations use the ORGANISATION's filing scheme, not each supplier's.**
`preventiveAlerts()` reads `suppliers.filing_scheme` and gives every supplier their own
cut-off — the 11th for a monthly GSTR-1 filer, the 13th for QRMP. `recommendAction()`
does not: it takes one `filingScheme` from context, which `runReconciliation()` fills
from `organizations.filer_type`, and applies it to every supplier in the run. So the same
supplier can be judged against two different dates depending on which screen is asking.
There is a second half to it inside a single run: `computeRunTotals()` *is* handed a
per-supplier `schemeFor`, so for a QRMP supplier the AT_RISK/DEFERRED total and the
CHASE_SUPPLIER/DEFERRED label could disagree with each other.

This is latent rather than live — all 108 generated suppliers are MONTHLY, so every
cut-off is the 11th either way and the screens agree by a property of the fixtures rather
than by construction. It becomes real the moment a QRMP supplier appears. The fix is to
thread `schemeFor` through `matchReconcile()` into `recommendAction()`, the way
`computeRunTotals()` already receives it. **Known future work, deliberately not done
before the demo.**

**The supplier risk model was trained on data our own generator produced.** 200
supplier-months from `tools/generate-fixtures.js`. It has largely learned our generator's
rules. Its held-out scores (ROC AUC 0.935 on an unseen period, 0.897 pooled) beat the
hand-weighted heuristic on both splits, which is the only reason it is served — but they
are evidence about the generator, not about GST filing behaviour.

**Three of the seven requested risk features could not be learned and were dropped.**
Training refuses to fit a meaningless coefficient:

- `gstr3b_filed_ratio` — not derivable from anything the app ingests. 2B carries a `cfs`
  flag, and whether it means GSTR-1 or GSTR-3B is unverified.
- `amendment_rate` — the generator declares the amendment sections and never populates
  them, so it is 0 on all 200 rows.
- `filed_ratio_6m` — every generated supplier reaches 2B every month, so it is 1 on all
  200 rows.

The last has a consequence no held-out metric can reveal: **the model is blind to a
supplier who stops reporting altogether.** That case is caught by an out-of-distribution
check that hands the supplier back to the hand-weighted scorer, not by the model.

**Uploaded files are stored in the database as a `LONGBLOB`.** A prototype shortcut.
Real object storage is the correct answer and was out of scope; as it stands, a few
hundred large registers would bloat the database and every backup of it.

**A record the supplier withdraws keeps its confirmation, deliberately.** When a
`DISAPPEARED` record still carries a decision the trader made, the change feed reports it
loudly as an invalidated decision rather than silently dropping the confirmation.
Clearing it inside the matcher would move rupee totals, which is a bigger change than a
correct alert. The trader sees it; the number does not move under them.

**The demo seeds two tax periods, so no supplier can reach a HIGH risk band.** HIGH
requires three or more observed periods — one late month is not a pattern — so the
demo tops out at MEDIUM. That is the guard working, not a bug, but it means the risk
screen shows a narrower range than the model can produce. Seeding 6–12 periods of filing
history is deferred work and is what the Suppliers screen needs to show its full range.

**Also not built, deliberately:** no login (every request is one stubbed trader), no
multi-user or roles, no GSP/portal API integration (files move by hand, which is what
the offline utility is for), no OCR, no email or WhatsApp sending (the app writes the
message text; the trader sends it), no rate limiting, no audit log, no GSTR-2A parsing.

---

# Engineering reference

Everything below is for someone working on the code.

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
  src/styles/              tokens.css (design tokens) and app.css — no component library
  src/lib/money.js         integer paise -> Indian-grouped rupees
  src/lib/issues.js        engine codes -> the one name for each issue and recommendation
  src/lib/decisionTabs.js  which IMS decisions tab a record is in
  src/lib/overview.js      Overview's four figures and "What we found"
  src/lib/calendar.js      cut-off, 2B generation and GSTR-3B dates
  src/components/          Sidebar, TopBar, StatTile, Chip, DataTable, SegmentedDecision,
                           MessagePanel, ConfirmDialog, ...
                           ErrorBoundary.jsx — the app's only class component
  src/screens/             Upload, Overview, Decisions, NotFiled, Corrections, Suppliers, Help
  test/                    vitest + jsdom + @testing-library/react
tools/                     dev tooling
  demo.js                  `npm run demo` — compose up, migrate, demo:reset, print URL
  demo-reset.js            wipe org 1 and rebuild the presentable state
  generate-fixtures.js     the whole synthetic corpus, from one seed
  seed-demo.js             load one fixture period end to end
  sweep-weights.js         grid-search matching weights vs ground truth
  export-training-data.js  seed org 10, write ml/training-data.csv
ml/                        offline training. train.py fits the supplier risk
                           model; model.json is COMMITTED and read by Node.
                           No Python runs at serve time.
docs/                      IMS / 2B / purchase-register schemas, domain reference
docker-compose.yml
```

## Setup — one command

```bash
npm run demo
```

`tools/demo.js` does the whole sequence: checks Docker is actually running, copies
`.env.example` to `.env` if there is no `.env`, `docker compose up -d --build`, waits for
the MySQL healthcheck (up to four minutes — a cold `down -v` has to initialise the data
directory), applies migrations in the container, generates `fixtures/` if they are
missing, runs `demo:reset`, then confirms the API and the Vite server both answer before
printing the URL.

It never opens a browser. On a projector, a window opening on the wrong screen is not
something you can undo.

Every failure path names what to do about it, because the failure that matters is the one
that happens in front of an audience. Docker not running, Compose v1 instead of v2, a
port already taken, a MySQL data directory from an older image, a stale `DB_*` in the
shell — each has its own message.

The only host prerequisite is Docker. `api/node_modules` is installed on first run if it
is missing: `demo-reset.js` runs on the host and imports the API's own services, and the
container image does not carry `tools/`.

## Setup — Docker by hand

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
| root | `npm run demo` | **the demo.** up, migrate, reset, print the URL |
| root | `npm run gen:fixtures` | regenerate `fixtures/` |
| root | `npm run gen:demo` | regenerate the live demo's files in `fixtures/demo/` ([script](docs/demo/DEMO-SCRIPT.md)) |
| root | `npm run verify:demo` | replay the demo story in a fresh workspace and check every step |
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

What `npm run demo` calls once the stack is up. Run it on its own when the containers are
already running and only the data needs rebuilding — it is the fast path between practice
runs.

One known state, safe to run between practice runs and immediately
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

Every period with a run carries a persistent **Re-run** button on Overview. The top
bar offers the same rebuild, but only once a run has NOTICED it is out of date —
which covers new portal data and nothing else.
After an engine or wording change there is nothing to notice, and uploading a file
to see your own change is a strange requirement. Either path keeps the run's own
mode, as-of date and filing scheme: those decide whether a mismatch is a free
supplier fix or a reject.

## Running the tests

666 API tests and 135 front-end tests. What each suite holds is tabulated under
[Test status](#test-status); this section is about running them.

The front end has its own suite. It runs in the web container, which is where its
node_modules live:

```
docker compose exec web npm test
```

`test/` and `vitest.config.js` are bind-mounted, so test edits need no rebuild; a
dependency change needs `docker compose build web`.

The API suite does **not** run in its container — `api/.dockerignore` excludes `test/`,
so the image has no tests in it. Run it on the host, against the containerised MySQL.


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
| `GET` | `/api/session` | the visitor's workspace; creates an empty one on a per-visitor deployment |
| `GET` | `/api/workspace/clock` | `?taxPeriod=` -> the workspace's as-of date, and that period's deadlines with days left |
| `PUT` | `/api/workspace/clock` | `{ asOfDate \| null }` -> sets the date (null: today) and re-evaluates every run |
| `POST` | `/api/workspace/clear` | Clear all data: the caller's workspace back to empty (per-visitor deployments) |
| `DELETE` | `/api/uploads/:id` | removes an upload and the rows it owns, rebuilds the runs |
| `POST` | `/api/runs` | `{ taxPeriod, mode }` -> run + summary, as of the workspace date |
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
| `PUT` | `/api/suppliers/:gstin/filing-scheme` | `{ scheme: MONTHLY \| QRMP \| null }` |
| `PUT` | `/api/suppliers/:gstin/contact` | `{ contactPerson, phone, email }` |

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

Seven screens in a navy sidebar, built from one set of tokens (`web/src/styles/tokens.css`)
and a small set of shared components (Sidebar, TopBar, PageHeader, StatTile, Chip,
DataTable, SegmentedDecision, MessagePanel, EmptyState). The design handoff is
`docs/design/README.md`; screenshots of the built app are in `docs/design/after/`.

**Top bar** — the tax period, the workspace's **As of** date (it moves the workspace clock,
`PUT /api/workspace/clock`, and every period is re-run against it) and the next deadline:
the supplier cut-off until it passes, then GSTR-3B. A run that is out of date shows a
quiet **Re-run** there, not a banner.

**Upload** — the default screen, and where an empty workspace lands. Three cards: the
purchase register (documents, suppliers, note types, contacts on file), IMS (records,
the download's date, filed against saved) and GSTR-2B, locked until the 14th. A refused
file says why on its card. An unrecognised register opens the column mapper, pre-filled
from the trader's own column titles (guesses are labelled as such), with the optional
contact and filing-frequency columns. Reconcile once; after that every upload rebuilds
the period and the button reads "See results". Upload history with Remove, the demo
files, and **Clear all data**.

**Overview** — Credit in your books, Ready to claim, Needs your decision and Not filed by
suppliers, which add up to the books total, with a bar showing the split. "Before 20 Sep"
lists only the steps with something to do. "What we found" lists every item that is not a
clean filed match, an earlier month's late arrival marked "From August".

**IMS decisions** — Ready to accept / Needs a decision / Decided / Overridden. Accept,
Reject or Pending per record (Pending never offered where the portal blocks it), "Accept
all" for the clean matches, and each row opens to books against portal, one line of why,
and a message to the supplier with Copy, WhatsApp and Email. The IMS file downloads from
the footer; while records are not decided the API answers 409 and the screen says how
many, by kind, before handing it over.

**Not filed yet** — documents the supplier has not filed, or only saved, under a cut-off
card that reads each supplier's own cut-off (the 11th monthly, the 13th quarterly):
still free to fix, passed (ask for GSTR-1A), or both.

**Corrections** — what last month asked suppliers to fix, and whether it has arrived:
where it was found and the credit it brings, or how long it has waited and the
supplier's next chance, with a reminder to send.

**Suppliers** — contact (or "Not in your purchase register" and Add contact), filing
scheme with "(assumed)" or "set by you" and an edit control, this period's issue, tax and
risk; a row opens to the reasons for its risk.

**Help** — one line per screen, the monthly calendar, and that each visitor's workspace
is private.

Every message to a supplier is built on the server (`api/src/services/supplierMessages.js`)
and only ever copied or opened in the trader's own app: nothing is sent from ITC Guard.

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
pip install -r ml/requirements.txt
python ml/train.py     # prints metrics and coefficients, writes ml/model.json
```

Without Python on the host, the same in a throwaway container:

```bash
docker run --rm -v "$PWD/ml:/ml" -w /ml python:3.12-slim sh -c "pip install -q -r requirements.txt && python train.py"
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
