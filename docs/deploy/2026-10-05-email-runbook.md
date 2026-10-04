# Runbook: v2-curiousparc → v2.1-email on itcguard.duckdns.org (5 Oct 2026)

Adds supplier email: send from the app (SMTP), replies read back (IMAP), optional
Gemini check of each reply. One additive migration (`016_supplier_email.sql`: two new
tables and a nullable column), so the rollback needs no database restore. Run as root in
`/root/itc-guard`, one block at a time. Downtime: the `dc up -d` in step 4, under a minute.

## 0. Shell

```bash
cd /root/itc-guard
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'
git status --short && git describe --tags --always    # expect nothing, then v2-curiousparc
```

## 1. Code

```bash
git fetch --tags
git checkout v2.1-email
```

## 2. Env: append to `.env.prod`, then fill in the values

Names and placeholders only. Gmail needs an **app password** (Google account → Security →
2-Step Verification → App passwords) and IMAP on (Gmail → Settings → Forwarding and
POP/IMAP). No spaces in the allowlist.

```bash
cat >> .env.prod <<'EOF'

# --- Supplier email (v2.1) ---
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=<the trader's gmail address>
SMTP_PASS=<16-character app password>
IMAP_HOST=imap.gmail.com
EMAIL_ALLOWLIST=<address1>,<address2>,<address3>
GEMINI_API_KEY=<key, or leave blank for "Not checked">
GEMINI_MODEL=gemini-3.5-flash-lite
EOF
nano .env.prod      # replace every <...>
chmod 600 .env.prod
```

## 3. Build and migrate (v2 keeps serving)

```bash
dc build api && dc build web
STAMP=$(date +%Y%m%d-%H%M); mkdir -p ~/backups
dc exec -T db sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE"' 2>/dev/null | gzip > ~/backups/pre-email-$STAMP.sql.gz && ls -lh ~/backups/pre-email-$STAMP.sql.gz
dc run --rm api node src/db/migrate.js
```

Check: `apply 016_supplier_email.sql`, every other line `skip`.

## 4. Switch

```bash
dc up -d
dc ps
```

## 5. Health

```bash
sleep 20
curl -s https://itcguard.duckdns.org/health; echo
dc logs api --since 2m | grep -E 'listening|\[mail\]'
dc exec api node /app/tools/mail-selftest.js <an allowlisted address>
```

Check: `/health` is `{"ok":true,"db":true}`; the log says `[mail] polling the inbox every
30 s` and no `poll failed`; the self-test prints `ok` for SMTP, IMAP and Gemini and sends
one `[ITC Guard #…] Self-test` mail to that address. Then in a browser:
upload the demo-local August register and IMS (as of 11 Sep), IMS decisions → NS-612 →
Email opens a dialog, not your mail app.

If SMTP fails, the app still works: Email falls back to a mailto link once
`SMTP_HOST` is blanked and `dc up -d` is re-run.

## Rollback to v2-curiousparc

Migration 016 only adds; v2-curiousparc ignores it, so the database stays as it is.

```bash
cd /root/itc-guard
git checkout v2-curiousparc
dc build api && dc build web
dc up -d
sleep 20; curl -s https://itcguard.duckdns.org/health; echo
```

The email lines in `.env.prod` are ignored by the v2 compose file and can stay.
