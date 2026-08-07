# xboard-edge

Main Cloudflare Worker for the admin WebUI, admin and user APIs, payments, migration, subscription generation, API-path obfuscation, and the Service Binding entry to `xboard-server`.

The default admin seed is `admin@admin.com / adminadmin`. The admin shell is served from `/admin`; inner pages use hash routes such as `/admin#/server/machine`. Change the default password immediately after deployment.

## Runtime behavior

- D1 is authoritative. Normal business requests start a `first-primary` Session.
- Subscription requests use a separate `first-unconstrained` Session and regenerate from D1 on every request; subscription bodies do not use memory, KV, or Cache API.
- Repeatable admin/content read models may use isolate memory and Cache API. Login, authorization, balances, orders, traffic decisions, writes, and migration are never served from those caches.
- Email and Telegram tasks are published to `NOTIFICATION_EVENTS`; `xboard-jobs` dispatches them by event type.
- Eight fixed payment Providers are supported: AlipayF2F, BTCPay, Coinbase, CoinbaseBusiness, CoinPayments, EPay, MGate, and Stripe. Arbitrary PHP plugins are never executed.
- Valid timestamp/Base64URL obfuscated routes are rewritten to the existing `/api/v1/*` handlers. Keep `"/*/*"` in Static Assets `run_worker_first` or those routes will not reach the Worker.

## Migration

The authenticated wizard is available at `/<secure_path>/migration` and is linked under system settings. Original SQLite3 is required; Redis RDB/JSON is optional. Persistent rows are imported into D1, while supported Redis runtime values are restored as disposable state. Laravel queues, locks, sessions, verification codes, and rate-limit keys are skipped.

Exports support two formats: XBoard-CF SQLite3 keeps Cloudflare-specific columns such as server `next_reset_at`; original XBoard SQLite3 writes only upstream tables and columns. `v2_payment` is imported and exported without redacting Provider credentials. Unsupported Providers and ambiguous callback UUIDs remain stored but disabled. Internal payment transactions, runtime load history, and transient Queue state are not exported.

SMTP credentials and plugin configuration are not migrated. Configure Maileroo or Brevo after migration; mail templates and auditable order history are preserved.

## Local verification

```bash
npm install
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir ../../.tmp/xboard-edge-dry-run
```
