# xboard-jobs

Independent Cloudflare Worker root for Queue consumers, traffic accounting, notification delivery, TrafficStatsHub, and scheduled maintenance.

It owns the single `* * * * *` Cron Trigger and directly runs order, ticket, commission, traffic reset, reminder, statistics, and cleanup tasks. Mail and Telegram events share `notification-events`; mail is delivered through Maileroo or Brevo.

Traffic processing atomically updates authoritative user/server totals, event deduplication, pending checks, and one Outbox row in D1. The global `TrafficStatsHub` deduplicates `batch_id`, aggregates daily statistics, and materializes absolute values into the original `v2_stat*` tables. Failed Outbox delivery is replayed by Cron; retries must never use additive materialization or charge traffic twice.

`traffic-events` and `notification-events` retry at most five times before their dedicated DLQs. Jobs has Cache API enabled as a platform capability but deliberately does not cache Queue accounting, Cron locks, billing state, idempotency, or authoritative writes.

Configure `MAILEROO_API_KEY` or `BREVO_API_KEY` as a Worker Secret, or set the selected provider through the admin email settings.

Default admin seed: admin@admin.com / adminadmin.

Local verification:

```bash
npm install
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir ../../.tmp/xboard-jobs-dry-run
```
