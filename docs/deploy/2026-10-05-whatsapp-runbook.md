# Runbook: v2.1-email → v2.2-whatsapp on itcguard.duckdns.org (5 Oct 2026)

Adds supplier WhatsApp through Meta's WhatsApp Cloud API: send from the app, replies and
delivery ticks back by webhook, the same Gemini check and bell as email. One additive
migration (`017_message_channels.sql`: a column with a default on `message_threads`, a
new `message_sends` table backfilled from the email threads), so the rollback needs no
database restore. Run as root in `/root/itc-guard`, one block at a time.

Downtime: from `dc stop api` in step 4 to `dc up -d` in step 5, about a minute. The API
is stopped for the migration so no email thread is written between the backfill and
the switch (it would have no row in `message_sends`).

## 0. Shell

```bash
cd /root/itc-guard
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'
git status --short && git describe --tags --always    # expect nothing, then v2.1-email
```

## 1. Backup

```bash
STAMP=$(date +%Y%m%d-%H%M); mkdir -p ~/backups
dc exec -T db sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE"' 2>/dev/null | gzip > ~/backups/pre-whatsapp-$STAMP.sql.gz && ls -lh ~/backups/pre-whatsapp-$STAMP.sql.gz
cp .env.prod ~/backups/env.prod.pre-whatsapp-$STAMP && chmod 600 ~/backups/env.prod.pre-whatsapp-$STAMP
```

Check: the dump is not a few hundred bytes (that would be an error message, gzipped).

## 2. Code

```bash
git fetch --tags
git checkout v2.2-whatsapp
```

## 3. Env: append to `.env.prod`, then fill in the values

Names and placeholders only; the values are the ones in your laptop's `.env`. From the
Meta app: **WhatsApp → API Setup** (token, phone number ID, WhatsApp Business Account
ID) and **App settings → Basic** (app secret). The verify token is any string you
choose; the same one goes into Meta in step 6. No spaces in the allowlist.

```bash
cat >> .env.prod <<'EOF'

# --- Supplier WhatsApp (v2.2) ---
WHATSAPP_TOKEN=<access token: a System User token, not the 24-hour one>
WHATSAPP_PHONE_NUMBER_ID=<phone number ID>
WHATSAPP_BUSINESS_ACCOUNT_ID=<WhatsApp Business Account ID>
WHATSAPP_APP_SECRET=<app secret>
WHATSAPP_VERIFY_TOKEN=<verify token you choose>
WHATSAPP_TEMPLATE_NAME=<template name>
WHATSAPP_TEMPLATE_LANG=<template language code, e.g. en_US>
WHATSAPP_FIRST_MESSAGE=<text until the template is approved, then template>
WHATSAPP_ALLOWLIST=<digits with country code, comma-separated>
EOF
nano .env.prod      # replace every <...>
chmod 600 .env.prod
```

**The token.** The token on the API Setup page expires after about 24 hours, and every
send then fails with "WhatsApp did not accept this server's access token". For the
demo, use a System User token (Business settings → Users → System users → Generate
token, with `whatsapp_business_messaging` and `whatsapp_business_management`), or
regenerate the temporary one on the morning of the demo and run step 5 again.

## 4. Build, stop the API, migrate (the old API serves until the stop)

```bash
dc build api && dc build web
dc stop api
dc run --rm api node src/db/migrate.js
```

Check: `apply 017_message_channels.sql`, every other line `skip`. If the migration
fails, `dc start api` brings v2.1 back on the untouched database while you look.

## 5. Switch and check

```bash
dc up -d
dc ps
sleep 20
curl -s https://itcguard.duckdns.org/health; echo
dc logs api --since 2m | grep -E 'listening|\[mail\]|\[whatsapp\]'
VT=$(grep '^WHATSAPP_VERIFY_TOKEN=' .env.prod | cut -d= -f2-)
curl -s "https://itcguard.duckdns.org/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$VT&hub.challenge=itcg-ok"; echo
unset VT
curl -s -o /dev/null -w 'unsigned POST: %{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://itcguard.duckdns.org/api/webhooks/whatsapp
```

Check: `/health` is `{"ok":true,"db":true}`; the challenge line prints `itcg-ok` (Caddy
routes `/api/webhooks/*` to the API and the verify token matches); the unsigned POST is
`401`. A `403` on the challenge means the verify token differs; a `503` on the POST
means `WHATSAPP_APP_SECRET` is blank.

Optional, sends one real message (MS-878's) to the first allowlisted number. In text
mode it arrives only if that phone messaged the business number in the last 24 hours:

```bash
dc exec api node /app/tools/whatsapp-selftest.js
```

## 6. Meta: point the webhook at the site

In the Meta app (developers.facebook.com → your app):

1. **WhatsApp → Configuration → Webhook → Edit.**
2. Callback URL: `https://itcguard.duckdns.org/api/webhooks/whatsapp`
3. Verify token: the `WHATSAPP_VERIFY_TOKEN` value from `.env.prod`.
4. **Verify and save.** Meta calls the GET from step 5; it must say verified.
5. **Webhook fields → Manage → `messages` → Subscribe.** (This one field carries both the
   replies and the sent / delivered / read / failed statuses.)

If Verify fails: run the challenge `curl` from step 5 again. If it passes but no reply
or tick ever arrives, subscribe the app to the business account once (reads the values
from `.env.prod` without printing them):

```bash
WABA=$(grep '^WHATSAPP_BUSINESS_ACCOUNT_ID=' .env.prod | cut -d= -f2-)
TOKEN=$(grep '^WHATSAPP_TOKEN=' .env.prod | cut -d= -f2-)
curl -s -X POST "https://graph.facebook.com/v26.0/$WABA/subscribed_apps" -H "Authorization: Bearer $TOKEN"; echo
unset WABA TOKEN
```

Expect `{"success":true}`.

## 7. End to end: send from the site, reply from the phone, the bell lights up

Upload from the laptop's `fixtures/demo-local/` (Mahavir Sales' phone there is the
allowlisted number; the image ships placeholder contacts only).

1. From your phone, send any message to the WhatsApp business number (opens the 24-hour
   window; needed while `WHATSAPP_FIRST_MESSAGE=text`).
2. Open https://itcguard.duckdns.org in a private window (a fresh workspace). Set the
   date to **11 Sep 2026**.
3. Upload `aug/purchase_register_aug26.xlsx`, then `aug/ims_aug26_as_of_11sep.json`, then
   Reconcile.
4. **IMS decisions → Needs a decision → MS-878 (Mahavir Sales)** → open the row. Under
   the message, **WhatsApp**. The dialog shows To `+91 93567 42616` and "The full message
   as free text…" with the text. **Send**. The panel says "Sent on WhatsApp <date, time>"
   and the thread line under the message shows `✓ Sent`.
5. On the phone the message arrives. Within a few seconds the tick reads `✓✓ Delivered`,
   then `✓✓ Read` once you open it (the screen refreshes every 20 s).
6. Swipe-reply on the phone: "Will file GSTR-1A for the 900 by 9 Oct".
7. Within 20 s: the top-bar bell shows **1**; Mahavir's row has a bell with a dot; the
   reply card reads "Replied on WhatsApp …", **Will fix**, and **Promised by 9 Oct 2026**
   (the Gemini check; "Not checked" if `GEMINI_API_KEY` is blank). Opening the bell
   marks it read.

If step 4 says "WhatsApp only allows a free message within 24 hours of the supplier's
last message…", do step 1 again. Any other refusal names its cause (number not on the
test number's list, token, rate limit); "Open in WhatsApp instead" in the dialog still
works.

Once Meta approves the template: set `WHATSAPP_FIRST_MESSAGE=template` in `.env.prod`
and `dc up -d api`. The first message on a thread is then the template, and no
phone-first step is needed.

## Rollback to v2.1-email

Migration 017 only adds; v2.1-email ignores `message_sends` and writes email threads
with the column's default, so the database stays as it is. Unhook Meta first: v2.1
would answer each webhook call as a new visitor and create an empty workspace for it.

1. Meta app → WhatsApp → Configuration → Webhook fields → `messages` → **Unsubscribe**.
2. Then:

```bash
cd /root/itc-guard
git checkout v2.1-email
dc build api && dc build web
dc up -d
sleep 20; curl -s https://itcguard.duckdns.org/health; echo
```

The `WHATSAPP_*` lines in `.env.prod` are ignored by the v2.1 compose file and can stay.
WhatsApp threads already sent stay in the database; v2.1 lists them like email threads
("Emailed … to +91…") until a workspace is cleared. To undo the migration as well,
restore `~/backups/pre-whatsapp-$STAMP.sql.gz` (anything written since is lost).
