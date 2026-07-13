# XBoard CF

XBoard CF is a Cloudflare-native rewrite of XBoard for Workers, D1, KV, Queues, and Static Assets. It keeps the XBoard-style admin panel and compatible API surfaces, while removing the Laravel/PHP runtime requirement.

## What This Project Provides

- Admin Web UI at `/admin`
- Admin API and user API in `xboard-edge`
- Subscription API in `xboard-subscription`
- Node/server reporting API in `xboard-server`
- Legacy UniProxy and Tidalab node APIs, V2 machine mode, and WebSocket hot sync
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

## Node Compatibility Baseline

The node protocol implementation is pinned to these upstream revisions:

```text
cedar2025/Xboard      8e4864b4c7f6240e3ef08ecd7b59447e5d9dd363
cedar2025/Xboard-Node 0a29338e1f102a462363ce3527417029f89bab28
```

Supported node surfaces include:

```text
/api/v1/server/UniProxy/*
/api/v1/server/ShadowsocksTidalab/*
/api/v1/server/TrojanTidalab/*
/api/v2/server/*
/api/v2/server/machine/*
/ws
```

Official nodes may use the main panel URL. `xboard-edge` proxies these paths to `xboard-server` through a Cloudflare Service Binding while preserving status codes, bodies, ETags, 304 responses, and WebSocket upgrades.

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
