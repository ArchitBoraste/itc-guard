# Deploying ITC Guard

Fresh Ubuntu EC2 (t3.micro, 1 GB / 2 vCPU), Docker already installed, connected
over **SSM Session Manager**. From clone to a working HTTPS URL.

Everything below was run end to end against `docker-compose.prod.yml` locally
before being written down. Where a number appears, it was measured.

---

## Test it on your laptop first

The same compose file and the same Caddyfile run locally — only `SITE_ADDRESS`
changes, and a bare port tells Caddy not to request a certificate. Worth doing
before touching the server, because everything here fails fast and locally:

```bash
cp .env.prod.example .env.prod
```

Then set these four lines in `.env.prod` and leave the rest:

```ini
SITE_ADDRESS=:80          # bare port -> plain HTTP, no ACME
HTTP_PORT=8080            # host side, to avoid a privileged port
HTTPS_PORT=8443
DEMO_COOKIE_SECURE=false  # no TLS locally, so a Secure cookie would be dropped
```

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod exec api node src/db/migrate.js
open http://localhost:8080
```

Tear down with `docker compose -f docker-compose.prod.yml --env-file .env.prod down -v`.
The `-v` drops the local database volume; the project name is `itc-guard-prod`, so
this cannot touch the `docker-compose.yml` development stack or its data.

**Delete your local `.env.prod` before deploying, or keep a separate one.** The
server needs real generated secrets, and a laptop-grade password is the kind of
thing that gets copied up by accident.

---

## 0. Before you connect

**Security group** — inbound `80/tcp` and `443/tcp` from `0.0.0.0/0`. Port 22 is
not needed; SSM does not use it. `443/udp` is optional (HTTP/3); without it Caddy
serves over TCP and nothing notices.

**DNS** — an A record for your domain pointing at the instance's public IP.

> You need a real DNS name. A public CA will not issue a certificate for a bare
> IP, and **Let's Encrypt refuses `*.compute.amazonaws.com`**, so the EC2 hostname
> will not work either. If you have no domain, `<dashed-ip>.sslip.io` resolves to
> that IP and does get a certificate — `13-51-2-7.sslip.io` for `13.51.2.7`.

---

## 1. Connect

```bash
aws ssm start-session --target i-0123456789abcdef0
```

You land as `ssm-user`. Become `ubuntu`, which is the user Docker was installed
for:

```bash
sudo su - ubuntu
```

Check Docker answers without sudo, and that it will come back after a reboot:

```bash
docker ps && sudo systemctl enable --now docker
```

---

## 2. Add swap

Do this before anything else. A t3.micro has **no swap by default**, so the
kernel's only response to a momentary spike is to OOM-kill something. The stack
measures ~290 MB against ~1 GB, so swap should never be touched in normal running
— it is there so that a spike degrades into slowness instead of a dead container.

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

---

## 3. Clone and configure

```bash
git clone <your-repo-url> itc-guard && cd itc-guard
cp .env.prod.example .env.prod
```

Generate the three secrets — do not invent them by hand:

```bash
printf 'DB_ROOT_PASSWORD=%s\nDB_PASSWORD=%s\nDEMO_SESSION_SECRET=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -base64 24)" "$(openssl rand -hex 32)"
```

Open `.env.prod` and set, at minimum:

```ini
SITE_ADDRESS=itc.example.com     # your domain — this is what turns TLS on
DB_ROOT_PASSWORD=...             # from above
DB_PASSWORD=...                  # from above
DEMO_SESSION_SECRET=...          # from above
DEMO_COOKIE_SECURE=true          # true because the site is https
```

`.env.prod` is gitignored. Every other value has a working default; the file
documents each one.

---

## 4. Build and start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

The frontend build runs here, inside the image — it peaks at ~163 MB and takes a
couple of seconds, so it is safe on this box. First run also pulls MySQL and
Caddy and generates the demo fixtures into the API image; allow a few minutes.

Watch the API wait for MySQL rather than racing it:

```
Container itc-guard-prod-db-1  Waiting
Container itc-guard-prod-db-1  Healthy
Container itc-guard-prod-api-1 Starting
```

---

## 5. Create the schema

Once, on a new database:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec api node src/db/migrate.js
```

Expect `applied 10 migration(s)`. It is idempotent — safe to re-run, and it skips
what is already applied. An existing deployment is upgraded by hand: see
[Upgrading: migrations](#upgrading-migrations-by-hand) under Operations.

---

## 6. Verify

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

All four `Up`, with `db`, `api` and `web` `(healthy)`. Then, from your laptop:

```bash
curl -sI https://itc.example.com/ | head -1
curl -s  https://itc.example.com/health
curl -s  https://itc.example.com/api/session
```

`/api/session` should return `"state":"READY"` and set an `itcg_session` cookie.
If it says `PROVISIONING`, the warm pool is still filling — wait ~10 s and retry.

**Confirm the MySQL tuning actually took.** It is applied via a file MySQL will
silently ignore if its permissions are wrong, and the failure mode is a server
that runs fine on stock defaults until the box runs out of memory:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db \
  mysql -uroot -p"$(grep ^DB_ROOT_PASSWORD .env.prod | cut -d= -f2-)" \
  -e "SHOW VARIABLES WHERE Variable_name IN ('performance_schema','innodb_buffer_pool_size','log_bin','max_connections')"
```

Must read `performance_schema OFF`, `innodb_buffer_pool_size 100663296`,
`log_bin OFF`, `max_connections 40`. If it says `ON` / `134217728`, the config
was not read — check `docker compose ... logs db | grep -i world-writable`.

Finally, open the URL and click through Summary, Still fixable, Actions,
Suppliers, Upload, About.

---

## Memory: what was set and why

`free -h` on an idle t3.micro leaves roughly 760 MB after Ubuntu and the Docker
daemon. Measured with this configuration, pool warm, under a burst of six
simultaneous visitors:

| Service | Limit | Idle | Peak under load |
|---|---|---|---|
| db | 384M | 137 MiB | 205 MiB |
| api | 256M | 32 MiB | 66 MiB |
| caddy | 64M | 11 MiB | 11 MiB |
| web | 48M | 12 MiB | 12 MiB |
| **total** | **752M** | **~192 MiB** | **~294 MiB** |

The limits sum to more than the box has. That is deliberate: they are **ceilings,
not reservations**. Docker does not reserve memory, real usage is ~294 MB, and
the caps exist so that one runaway service is killed and restarted by
`restart: unless-stopped` instead of the kernel picking a victim and possibly
taking MySQL with it.

**MySQL is the whole problem, and `performance_schema` is most of it.** Stock
MySQL 8 sits at ~357 MiB before storing anything — 93% of its cap, i.e. an OOM
kill under the first real load. `deploy/mysql/small.cnf` brings it to 137 MiB:

- `performance_schema = OFF` — the single biggest saving, ~150–200 MB of
  instrumentation tables allocated at startup that nothing here reads.
- `innodb_buffer_pool_size = 96M` (from 128M) — the dataset at the org cap is a
  couple of hundred MB, so no realistic pool holds it all; 96M covers the working
  set of one visitor's org, reached by index.
- `disable_log_bin` — binary logging is on by default in MySQL 8. There is no
  replica and no PITR story for demo data, so it is pure write amplification.
- `max_connections = 40` (from 151) — the API pool is capped at 10 and is the
  only client. Per-connection buffers are reserved per connection.
- `innodb_flush_method = O_DIRECT` — stops InnoDB pages being cached twice, once
  by InnoDB and once by the OS.
- `sort/join/read_buffer` trimmed — allocated *per connection*, so defaults
  multiply.

**Will the Vite build fail at this memory ceiling? No** — this was measured, not
estimated. It peaks at **163 MB RSS** and completes in ~1.5 s, and still succeeds
under a hard 192 MB cap because V8 sizes its heap to the cgroup. Building on the
box is fine. (If you ever want to avoid it anyway: build elsewhere, `docker save`
the images, and `docker load` them here.)

### If the box struggles, in this order

1. `DEMO_MAX_ORGS` down (20 → 10). Each org is ~5 MB; fewer means less buffer
   pool pressure. Biggest effect, no downside for judging.
2. `DB_MEM_LIMIT=320M` and `innodb_buffer_pool_size = 64M` in
   `deploy/mysql/small.cnf` (this needs `--build` on the db service).
3. `DEMO_POOL_SIZE=1` — first visits then more often show the "preparing your
   demo data" screen instead of being instant.

---

## Operations

All commands assume `cd ~/itc-guard`. Define this once per session to save typing:

```bash
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'
```

| Task | Command |
|---|---|
| Status | `dc ps` |
| Logs (follow) | `dc logs -f api` |
| Memory right now | `docker stats --no-stream` |
| Restart one service | `dc restart api` |
| Apply an `.env.prod` change | `dc up -d api` |
| Deploy new code | see [Upgrading: migrations](#upgrading-migrations-by-hand) |
| Disk | `df -h && docker system df` |

### Upgrading: migrations by hand

`dc up -d --build` never migrates. When a deploy brings a new file in
`api/src/db/migrations/`, apply it from the NEW image before the stack switches to
it — the new code reads the new columns and tables, and every migration so far is
additive, so the old code keeps serving while it runs:

```bash
git pull
dc build api web
dc run --rm api node src/db/migrate.js
dc up -d
```

`migrate.js` applies only what is new, in filename order, and refuses to re-apply
a migration whose file changed since it ran. It prints each `apply`/`skip`.

Migrations to run by hand on a deployment older than branch `phase1-audit-fixes`:

| Migration | What it adds | Afterwards |
|---|---|---|
| `008_claimable_split.sql` | `match_results.claimable_itc`: an accepted value mismatch claims min(books, portal); existing rows are backfilled as claimed whole | Totals of runs made before it are unchanged until the period is re-run |
| `009_supplier_scheme_source.sql` | `suppliers.filing_scheme_source` (`INFERRED`/`USER`): a scheme the trader sets is never overwritten by inference | Visitor orgs seeded from now on have the 7 QRMP sample suppliers "set by you" |
| `010_supplier_gstin_aliases.sql` | `supplier_gstin_aliases`: a mistyped GSTIN counts under the supplier it belongs to | An existing org's typo "suppliers" go at its next run (any upload, re-run or "Reset my data") |
| `011_workspace_clock.sql` | `organizations.as_of_date`: one as-of date per workspace (NULL follows today in India); every run is computed against it | Existing runs keep the date they were computed for until the period is re-run or the workspace date is set (`PUT /api/workspace/clock`) |

Existing data is never rewritten by these. To see the fixes on the demo straight
away, reset the presenter's org (`dc exec api node /app/tools/demo-reset.js`);
visitor orgs pick them up on "Reset my data", and idle ones are reaped and reseeded
by the sweeper. Runs made before the upgrade cannot tell new records from a
neighbouring month's (`staleness.inputCountsKnown: false`) and report on stale rows
alone until re-run.

**Tuning the demo knobs.** `DEMO_POOL_SIZE`, `DEMO_MAX_ORGS`,
`DEMO_IDLE_MINUTES`, `DEMO_SWEEP_MINUTES` and `DEMO_SEED_CONCURRENCY` are all
read from the environment at access time, so changing one is: edit `.env.prod`,
then `dc up -d api`. No rebuild.

**Reset the presenter's own org** (org 1 — the one used for a scripted walkthrough,
never handed to a visitor):

```bash
dc exec api node /app/tools/demo-reset.js
```

Visitors reset their own data with the "Reset my data" button; that never touches
org 1 or anyone else's org.

**Reboot.** Nothing to do. `restart: unless-stopped` on all four services plus an
enabled Docker daemon brings the stack back. Verified: killing the API process
outright had it serving again in **4 seconds**.

> Note: `docker kill` does *not* trigger a restart — Docker records that as a
> manual stop and deliberately suppresses the policy. Do not use it to test this;
> it will look broken when it is not. A kernel OOM kill or a process crash does
> restart.

---

## Troubleshooting

**Caddy restart-looping, `Error: adapting config using caddyfile`** — a Caddyfile
syntax problem. `dc logs caddy | tail -5` names the line.

**No certificate / TLS errors** — check DNS resolves to this box
(`dig +short itc.example.com`), that 80 and 443 are open in the security group
(Let's Encrypt validates over port 80), and `dc logs caddy | grep -i acme`.
Certificates persist in the `caddy_data` volume, so do not delete it casually:
Let's Encrypt allows 5 certificates per domain per week and repeated rebuilds can
exhaust that.

**Everyone gets a new empty org on every page load** — `DEMO_COOKIE_SECURE=true`
while serving plain HTTP. A `Secure` cookie is silently dropped over HTTP, so
every request looks like a first visit. Either set it `false` or fix TLS.

**`demo_at_capacity` (503)** — `DEMO_MAX_ORGS` reached. Raise it, or lower
`DEMO_IDLE_MINUTES` so idle sessions are reclaimed sooner.

**`session_provisioning` (409)** — normal and self-clearing. That visitor's org is
still being seeded; the UI polls and takes itself out of the state.

**Disk filling** — container logs are capped (10 MB × 3 per service). The usual
culprit is old images: `docker image prune -a`.
