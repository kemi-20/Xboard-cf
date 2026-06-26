# XBoard Cloudflare-Native

This repository is a Cloudflare-native rewrite scaffold for XBoard. It targets Cloudflare Workers, D1, KV, Queues, and Durable Objects instead of the original Laravel/PHP runtime.

## Default super administrator

The default seed creates:

```text
Email: admin@admin.com
Password: admin
```

Change this password immediately after first login.

## Cloudflare resources

```text
D1: xboard-db
KV: xboard-kv
Queues: traffic-events, mail-events, telegram-events, stat-events, node-sync-events
Durable Object: NodeHub
```

Every Worker is independently deployable from its own root folder:

```text
workers/xboard-edge
workers/xboard-subscription
workers/xboard-server
workers/xboard-jobs
workers/xboard-cron
```

The admin panel is always exposed at:

```text
/admin
```

## Initialize D1

```bash
wrangler d1 execute xboard-db --file schema/d1.sql
wrangler d1 execute xboard-db --file schema/seed.sql
npm run seed:admin
```

## Deploy one Worker

```bash
cd workers/xboard-edge
npm install
npm run typecheck
npm test
npm run deploy
```

Repeat for each Worker folder. Replace placeholder D1/KV IDs in every `wrangler.toml` after Cloudflare resource creation.

## Automatic deploys from Cloudflare Workers Builds

The five Workers are connected to this GitHub repository through Cloudflare Workers Builds. Each trigger watches `master` and deploys from its own root directory:

```text
xboard-edge          -> workers/xboard-edge
xboard-subscription  -> workers/xboard-subscription
xboard-server        -> workers/xboard-server
xboard-jobs          -> workers/xboard-jobs
xboard-cron          -> workers/xboard-cron
```

Cloudflare runs this build/deploy flow for each Worker:

```bash
npm ci && npm run typecheck && npm test
npx wrangler deploy
```

## Payment status

Payment, commission, gift-card, and real order payment flows are intentionally disabled for now. Compatibility tables and API placeholders are present so the admin UI does not crash.

## Upstream references and attribution

This rewrite uses these upstream projects as compatibility references:

- https://github.com/cedar2025/Xboard
- https://github.com/cedar2025/xboard-admin-dist
- https://github.com/cedar2025/xboard-user
- https://github.com/cedar2025/Xboard-Node

The original XBoard project is MIT licensed. Keep upstream notices when copying assets or implementation details from those repositories.
