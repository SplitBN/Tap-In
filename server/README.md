# Tap In backend

Cloudflare Worker + D1 (free tier). Holds the durable copy of each user's data (local-first sync) and sends push reminders.

- `src/index.ts`: auth (invite → device token + recovery key, pairing codes), `/sync/push`, `/sync/pull`, push subscription routes
- `src/reminders.ts`: cron every minute → supplement and weigh-in reminders via Web Push (RFC 8291/8292)
- `schema.sql`: D1 schema. Records are stored as JSON per user/table/id, so app features never need a server migration.

## One-time setup (≈10 minutes)

```bash
cd server
npm install
npx wrangler login                       # opens the browser: sign in / sign up to Cloudflare (free)
npx wrangler d1 create tap-in            # copy the database_id it prints into wrangler.toml
npm run db:init                          # create the tables in the remote D1
node scripts/vapid.mjs                   # prints a VAPID key pair for push
npx wrangler secret put VAPID_PUBLIC_KEY   # paste the public key
npx wrangler secret put VAPID_PRIVATE_KEY  # paste the private key
npx wrangler secret put BOOTSTRAP_INVITE   # any long random string: your own first sign-up code
npm run deploy                           # prints https://tap-in.<your-subdomain>.workers.dev
```

Then set `DEFAULT_API` in `src/lib/sync.ts` (app) to that URL, push, and in the app: Settings → Back up & sync → New account → your bootstrap invite.

Secrets (`VAPID_PRIVATE_KEY`, `BOOTSTRAP_INVITE`) live only in Cloudflare (`wrangler secret`) and in a local `.dev.vars` for `wrangler dev` — never in the repo (the repo is public).

## Local development

```bash
npm run db:init:local
printf 'BOOTSTRAP_INVITE="DEV-INVITE-123"\n' > .dev.vars
npx wrangler dev --port 8787             # app: Settings → Server: http://localhost:8787
```

## Security notes

- No passwords: device tokens (256-bit), recovery keys (192-bit) and pairing codes (50-bit, 10-minute, single use) are random, so a fast SHA-256 is enough and fits the free tier's CPU budget. Only hashes are stored.
- Sign-up requires an invite; each invite works once.
- CORS allows only `ALLOWED_ORIGINS`.
- Sync is last-write-wins per record using the client's `updatedAt`. Retries are idempotent.
