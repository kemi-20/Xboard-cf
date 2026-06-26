# XBoard CF

XBoard CF is a Cloudflare-native rewrite of XBoard for Workers, D1, KV, Queues, and Static Assets. It keeps the XBoard-style admin panel and compatible API surfaces, while removing the Laravel/PHP runtime requirement.

## What This Project Provides

- Admin Web UI at `/admin`
- Admin API and user API in `xboard-edge`
- Subscription API in `xboard-subscription`
- Node/server reporting API in `xboard-server`
- Queue consumer in `xboard-jobs`
- Scheduled maintenance worker in `xboard-cron`
- D1 database schema and seed files
- KV-backed cache/session/version state

The site root `/` intentionally returns only:

```text
200
```

The admin panel is served from:

```text
/admin
```

Admin inner pages use hash routes, for example:

```text
/admin#/server/machine
```

## Default Administrator

The default super administrator is:

```text
Email: admin@admin.com
Password: adminadmin
```

Change this password immediately after first login.

## Cloudflare Resources

Create these resources before deployment:

```text
D1 database: xboard-db
KV namespace: xboard-kv
Queues: traffic-events, mail-events, telegram-events, stat-events, node-sync-events
Durable Object: NodeHub
```

Bindings used by the Workers:

```text
D1 binding: XBOARD_DB
KV binding: XBOARD_KV
Static Assets binding for xboard-edge: ASSETS
```

## Worker Folders

Each Worker is independently deployable from its own root folder:

```text
workers/xboard-edge
workers/xboard-subscription
workers/xboard-server
workers/xboard-jobs
workers/xboard-cron
```

Cloudflare Workers Builds can be connected directly to this GitHub repository. Use branch `master`, and set each Worker root directory to its corresponding folder.

## Initialize D1

Run the schema and seed:

```bash
wrangler d1 execute xboard-db --file schema/d1.sql
wrangler d1 execute xboard-db --file schema/seed.sql
```

To update or recreate the default administrator:

```bash
npm run seed:admin
```

## Deploy A Worker Manually

Example for `xboard-edge`:

```bash
cd workers/xboard-edge
npm install
npm run typecheck
npm test
npm run deploy
```

Repeat for each Worker folder if you are not using Cloudflare Workers Builds.

## Payment Status

Real payment, commission payout, gift-card redemption, and order payment flows are intentionally disabled for now. Compatibility tables and placeholder API responses exist so the admin UI can load without crashing.

## Upstream Attribution

This project references the original XBoard ecosystem:

- https://github.com/cedar2025/Xboard
- https://github.com/cedar2025/xboard-admin-dist
- https://github.com/cedar2025/xboard-user
- https://github.com/cedar2025/Xboard-Node

The original XBoard project is MIT licensed. Keep upstream attribution when copying assets or implementation details.
