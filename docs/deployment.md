# Deployment

Fill this file during deployment.

## Resources

- D1 database: xboard-db
- KV namespace: xboard-kv
- Queues: traffic-events, mail-events, telegram-events, stat-events, node-sync-events
- Durable Object: NodeHub

## Smoke tests

```text
GET /health
POST /api/v2/admin/passport/auth/login
GET /api/v2/admin/config/fetch
GET /s/{token}
GET /api/v1/server/UniProxy/config
```

## Created Cloudflare resources

- Account: Kemi20@kemi20.cn (cd9de1eff822540d1c9a37bf9ae28931)
- D1 xboard-db: 03fee899-da56-4af3-b0ab-b36c5bec3dee
- KV xboard-kv: 044104eb282443f9894ab1611791f09b
- Queue traffic-events: a16393f64f144a2ba23ad97aafa5e0b3
- Queue mail-events: 9b149085cead4a418d49cb4dd54c6c48
- Queue telegram-events: 1ac3812af533407c8b8290fb488c5328
- Queue stat-events: f8a18a872bed4762966080d8a7c852dd
- Queue node-sync-events: 2f844ccea3024853b2ae49e4874caa8a

## Deployed smoke Workers

These scripts were uploaded through the Cloudflare MCP API because local Wrangler is not authenticated. They validate account resources, bindings, D1 access, KV/Queue binding shape, and workers.dev routing. Deploy the repository source from each Worker root with Wrangler after logging in to publish the full TypeScript implementation.

- xboard-edge: https://xboard-edge.kemi20.workers.dev
- xboard-subscription: https://xboard-subscription.kemi20.workers.dev
- xboard-server: https://xboard-server.kemi20.workers.dev
- xboard-jobs: https://xboard-jobs.kemi20.workers.dev
- xboard-cron: https://xboard-cron.kemi20.workers.dev

Smoke results:

- GET xboard-edge /health: passed
- POST xboard-edge /api/v2/admin/passport/auth/login with admin@admin.com / admin: passed
- GET xboard-edge /api/v2/admin/config/fetch: passed
- GET xboard-subscription /s/admin-default-token-change-me: passed, subscription-userinfo header returned
- GET xboard-server /health: passed
- GET xboard-jobs /: passed
- GET xboard-cron /: passed

Wrangler status:

- `npx wrangler whoami` reported unauthenticated in this environment.
- Full source deploy command after login: run `npm run deploy` inside each `workers/<name>` folder.

## GitHub automatic deployment

Cloudflare Workers Builds repository connection was created for `kemi-20/Xboard-cf`:

- Provider: GitHub
- Provider account: `kemi-20` (`72487102`)
- Repository id: `1281079598`
- Repository connection UUID: `5fcd808d-ee3b-48c1-9fea-44f472228f44`
- Branch: `master`

Creating Workers Builds trigger configurations through the Cloudflare API returned:

```text
12044: This account does not have access to Workers Previews
```

Because the account rejected Workers Builds trigger setup, repository-side automatic deploys are implemented with GitHub Actions in `.github/workflows/deploy-workers.yml`. Add the repository secret `CLOUDFLARE_API_TOKEN`; subsequent pushes to `master` deploy all five Worker roots automatically.

## Admin path

The default admin path is `/admin`. Seed data sets both `frontend_admin_path` and `secure_path` to `admin`.
