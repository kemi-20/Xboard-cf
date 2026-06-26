# README For Agents

This file is intentionally detailed. It is written for any future coding agent that needs to continue work on this repository without guessing why the project looks the way it does.

The filename is `README_FOR_AGNET.md` because that is the requested name. Do not silently rename it unless the user asks.

## Project Goal

This repository is a Cloudflare-native rewrite of XBoard. The target architecture is serverless and should run on Cloudflare Workers with D1 and KV as the only persistent data services requested by the user.

The high-level goals are:

- Keep an XBoard-compatible admin panel.
- Keep XBoard-compatible admin API and user API routes where practical.
- Keep subscription output compatible with original XBoard syntax.
- Split runtime into independently deployable Worker folders.
- Use D1 for durable business data.
- Use KV for cache, sessions, temporary state, and version markers.
- Avoid the original Laravel/PHP runtime.
- Keep payment-related features disabled for now, but preserve compatibility placeholders so the admin panel does not crash.

The user specifically wants:

- Default admin email: `admin@admin.com`
- Default admin password: `adminadmin`
- Admin panel path: `/admin`
- Admin inner routes as hash routes, for example `/admin#/server/machine`
- Site root `/` should return only plain text `200`
- Cloudflare should auto-deploy via Cloudflare Workers Builds connected to GitHub, not GitHub Actions
- `docs/`, `origin/`, and `.tmp/` should not be committed

## Current Repository State

Important root files and folders:

```text
.gitignore
README.md
README_FOR_AGNET.md
LICENSE
package.json
package-lock.json
schema/
scripts/
workers/
```

Ignored local/reference folders:

```text
origin/
.tmp/
docs/
node_modules/
.wrangler/
dist/
bugs.md
```

The `.gitignore` currently includes `bugs.md`. That was present before this file was created. Treat it as user-owned unless the user asks to change it.

## Worker Layout

Each Worker is self-contained and can be deployed by selecting its own folder as the Cloudflare Worker root:

```text
workers/xboard-edge
workers/xboard-subscription
workers/xboard-server
workers/xboard-jobs
workers/xboard-cron
```

Do not introduce a shared runtime package imported by all Workers from the repository root. The user explicitly requested that each Worker root folder can be selected independently at deployment time.

If shared logic is needed, copy the small helper into each Worker or make a deliberate local duplicate. This is ugly but intentional for the deployment model.

Each Worker folder generally contains:

```text
package.json
package-lock.json
tsconfig.json
wrangler.toml
src/index.ts
src/db.ts
src/kv.ts
src/compat.ts
src/types.ts
test/basic.test.mjs
README.md
```

`xboard-edge` also contains:

```text
public/
```

The `public/` directory contains the official admin Web UI static assets copied from `cedar2025/xboard-admin-dist`.

## xboard-edge Responsibilities

`workers/xboard-edge` is the main admin/user/API Worker.

It handles:

```text
GET /
GET /health
GET /admin
GET /admin/*
GET /settings.js
GET /settings.local.js
GET /assets/*
GET /locales/*
GET /images/*
/api/v2/passport/*
/api/v2/admin/*
/api/v1/*
/api/v2/user/*
```

Important behavior:

- `/` returns plain text `200`.
- `/admin` returns the admin SPA shell.
- `/admin#/...` is client-side hash routing. The server only sees `/admin`.
- Admin static bundles are served from `/assets/*` and `/locales/*`.
- `settings.js` sets:

```js
window.settings = {
  base_url: "/",
  secure_path: "/admin"
};
```

The official admin frontend builds API URLs as:

```text
base_url + api/v2 + secure_path + endpoint
```

With the current settings this becomes:

```text
/api/v2/admin/...
```

The admin login endpoint used by the frontend is:

```text
POST /api/v2/passport/auth/login
```

The Worker maps that to the admin login handler internally.

## Static Assets And Worker Routing

`workers/xboard-edge/wrangler.toml` uses Cloudflare Workers Static Assets:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = ["/", "/health", "/admin", "/admin/*", "/api/*"]
```

This setting is important.

Why:

- If Static Assets runs before the Worker for `/`, the root path may serve `index.html` instead of plain text `200`.
- If Worker runs first for every path and then calls `env.ASSETS.fetch("/index.html")`, requests can loop back into the Worker and return the fallback response instead of the asset.
- The current design only runs the Worker first for API/admin/root paths. Static files such as `/assets/index-*.js` are still served directly by Assets.
- The admin HTML shell is returned directly from `src/index.ts` so it cannot be intercepted by Static Assets routing.

If the admin panel becomes blank after changing routing, first check this section.

## Authentication Details

Default admin:

```text
admin@admin.com
adminadmin
```

Password hashing:

```text
pbkdf2$sha256$100000$xboard-cloudflare-admin$8abd89496c7d7b0cfdc7b786fd49da099859e1167bbcf9f945c38415d6d56268
```

This hash is for `adminadmin` with salt `xboard-cloudflare-admin`.

Files that must remain consistent:

```text
schema/seed.sql
scripts/seed-admin.ts
README.md
workers/xboard-edge/README.md
```

The seed SQL uses `ON CONFLICT(email) DO UPDATE` so the default admin password can be updated in an existing D1 database. This is intentional. Do not change it back to `INSERT OR IGNORE`, because that would leave old deployments with stale passwords.

Authorization header compatibility:

The official admin frontend sends:

```text
Authorization: <token>
```

It does not send:

```text
Authorization: Bearer <token>
```

Therefore `workers/xboard-edge/src/compat.ts` must accept both:

- `Authorization: Bearer <token>`
- `Authorization: <token>`
- `x-token: <token>`
- `token: <token>`

If users report "未授权" immediately after login, check `getBearer()` first.

## Admin Dashboard Compatibility

The official admin dashboard expects several stat endpoints and specific response shapes. Missing nested fields can crash the React app with errors like:

```text
Cannot read properties of undefined (reading 'upload')
```

This happened because the frontend reads:

```js
monthTraffic.upload
todayTraffic.upload
```

The following endpoints are implemented to prevent dashboard crashes:

```text
GET /api/v2/admin/stat/getStats
GET /api/v2/admin/stat/getOrder
GET /api/v2/admin/stat/getTrafficRank
```

`getStats` must return at least:

```json
{
  "todayIncome": 0,
  "currentMonthIncome": 0,
  "dayIncomeGrowth": 0,
  "monthIncomeGrowth": 0,
  "ticketPendingTotal": 0,
  "commissionPendingTotal": 0,
  "currentMonthNewUsers": 0,
  "userGrowth": 0,
  "totalUsers": 0,
  "activeUsers": 0,
  "monthTraffic": {
    "upload": 0,
    "download": 0
  },
  "todayTraffic": {
    "upload": 0,
    "download": 0
  }
}
```

`getOrder` must return:

```json
{
  "summary": {
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD",
    "paid_total": 0,
    "paid_count": 0,
    "avg_paid_amount": 0,
    "commission_total": 0,
    "commission_count": 0,
    "commission_rate": 0
  },
  "list": []
}
```

`getTrafficRank` must return an array. Each row should look like:

```json
{
  "name": "User or Node",
  "value": 0,
  "change": 0
}
```

The current implementation calculates what it can from D1 and returns zero for disabled payment/commission features.

## Payment Status

Payment work is intentionally paused.

Do not implement real payment processing unless the user explicitly asks.

Current behavior:

- Payment/order/coupon/commission/gift-card tables exist for compatibility.
- Admin API paths related to payment return disabled placeholders.
- Dashboard income and commission stats return zero.
- This is expected and should not be treated as a bug.

## D1 Database

D1 binding:

```text
XBOARD_DB
```

Database name:

```text
xboard-db
```

Schema file:

```text
schema/d1.sql
```

Seed file:

```text
schema/seed.sql
```

Important tables:

```text
v2_user
personal_access_tokens
v2_plan
v2_server
v2_server_group
v2_server_route
v2_server_machine
v2_server_machine_load_history
v2_settings
v2_notice
v2_knowledge
v2_ticket
v2_ticket_message
v2_mail_templates
v2_stat
v2_stat_user
v2_stat_server
v2_admin_audit_log
v2_traffic_reset_logs
v2_subscribe_templates
v2_job_logs
v2_order
v2_payment
v2_coupon
v2_commission_log
v2_gift_card_template
v2_gift_card_code
v2_gift_card_usage
```

Conventions:

- Store timestamps as Unix seconds.
- Store JSON as `TEXT`.
- Store money as integer cents when real money fields are needed.
- Preserve original-ish table names and common field names for migration compatibility.

## KV Namespace

KV binding:

```text
XBOARD_KV
```

Namespace name:

```text
xboard-kv
```

Common keys:

```text
settings:all
settings_version
servers_version
user_version:{userId}
session:{token}
admin_session:{token}
subscribe:{token}:{client}:{version}
verify:email:{email}
rate:login:{key}
rate:register:{ip}
node:last_check:{id}
node:last_push:{id}
node:online:{id}
node:load:{id}
template:{name}
schedule:last_run:{task}
```

KV is not authoritative for durable business data. Keep user balances, plans, traffic totals, node definitions, and permissions in D1.

## Subscription Worker

Folder:

```text
workers/xboard-subscription
```

Main routes:

```text
GET /s/:token
GET /sub/:token
GET /api/v1/client/subscribe
```

Responsibilities:

- Read D1.
- Use KV short cache.
- Validate token, ban, expiry, and traffic limits.
- Return subscription outputs and headers compatible with original XBoard conventions.

The planned cache key shape:

```text
subscribe:{token}:{client}:{settingsVersion}:{serversVersion}:{userVersion}
```

Default TTL:

```text
60 seconds
```

## Server Worker

Folder:

```text
workers/xboard-server
```

Main routes:

```text
/api/v1/server/*
/api/v2/server/*
/api/v2/server/machine/*
```

Responsibilities:

- Authenticate nodes.
- Return node config.
- Return user lists.
- Accept traffic reports.
- Write node status to KV.
- Send traffic events to queues where implemented.

Node status KV keys:

```text
node:last_check:{id}
node:last_push:{id}
node:online:{id}
node:load:{id}
```

## Jobs Worker

Folder:

```text
workers/xboard-jobs
```

Queues originally planned:

```text
traffic-events
mail-events
telegram-events
stat-events
node-sync-events
```

Responsibilities:

- Consume queued traffic events.
- Batch write stats into D1.
- Write failures to `v2_job_logs`.
- Keep job processing idempotent where possible.

## Cron Worker

Folder:

```text
workers/xboard-cron
```

Responsibilities:

- Replace Laravel schedule.
- Periodically check traffic exceeded state.
- Reset traffic according to plan rules where implemented.
- Clean logs/status.
- Enqueue reminder jobs where implemented.

Cron status KV key shape:

```text
schedule:last_run:{task}
```

## Cloudflare Builds

The user wants Cloudflare-native Git binding, not GitHub Actions.

Do not add a GitHub Actions deployment workflow unless the user reverses that decision.

Expected Cloudflare Workers Builds setup:

```text
branch: master
build command: npm ci && npm run typecheck && npm test
deploy command: npx wrangler deploy
```

Worker roots:

```text
xboard-edge          -> workers/xboard-edge
xboard-subscription  -> workers/xboard-subscription
xboard-server        -> workers/xboard-server
xboard-jobs          -> workers/xboard-jobs
xboard-cron          -> workers/xboard-cron
```

The repository remote is:

```text
https://github.com/kemi-20/Xboard-cf
```

Default branch:

```text
master
```

## Important Deployment History

These are important commits that explain current behavior:

```text
0dc902d  Restore official admin Web UI through Cloudflare build
9484562  Change default admin password to adminadmin and root response intent
c7fe6e5  Add assets run_worker_first so / is handled by Worker
a66a035  Serve admin shell directly through Worker to avoid Assets loop
76f99ff  Accept raw Authorization tokens from official admin frontend
e6f998d  Add admin dashboard stats responses
```

If another agent sees older failed builds in Cloudflare, note that earlier failures were fixed. Check the latest build, not only the visible failed history row.

## Known Pitfalls

### Pitfall: `/` Serves Admin HTML

Cause:

Static Assets ran before the Worker and served `index.html`.

Fix:

Use:

```toml
run_worker_first = ["/", "/health", "/admin", "/admin/*", "/api/*"]
```

### Pitfall: `/admin` Returns `200` Text Or Fallback JSON

Cause:

Worker ran first for all paths and `env.ASSETS.fetch("/index.html")` was routed back through the Worker.

Fix:

Return the admin HTML shell directly from Worker code and let `/assets/*` and `/locales/*` be served by Static Assets.

### Pitfall: Login Succeeds But Admin Shows "未授权"

Cause:

Official admin frontend sends a raw token in the `Authorization` header.

Fix:

`getBearer()` must accept raw `Authorization` header values as tokens.

### Pitfall: Login Then Page Shows `Cannot read properties of undefined (reading 'upload')`

Cause:

Dashboard `stat/getStats` response missed nested objects:

```text
monthTraffic
todayTraffic
```

Fix:

Keep `adminStats()` returning complete nested objects.

### Pitfall: Default Password Does Not Change In Existing D1

Cause:

Using `INSERT OR IGNORE` for default admin.

Fix:

Use `ON CONFLICT(email) DO UPDATE` in `schema/seed.sql` and `scripts/seed-admin.ts`.

## Local Validation Commands

Run all workers:

```bash
npm run typecheck
npm test
```

Run one worker:

```bash
cd workers/xboard-edge
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir ../../.tmp/xboard-edge-dry-run
```

The dry-run may write debug logs to the user profile. In restricted sandboxes this can fail after a successful dry-run with a log-file permission error. Check whether Wrangler already printed the asset/binding summary before treating it as a real build failure.

## Smoke Tests

Set the deployed edge Worker base URL locally before running these examples:

```powershell
$base = "https://<your-xboard-edge-worker-domain>"
```

Root:

```powershell
$r = Invoke-WebRequest "$base/"
$r.StatusCode
$r.Content
```

Expected:

```text
200
200
```

Admin shell:

```powershell
$r = Invoke-WebRequest "$base/admin"
$r.StatusCode
$r.Content -match '<div id="root"></div>'
$r.Content -match '/assets/index-CEIYH7i8.js'
```

Login and dashboard stats:

```powershell
$loginBody = @{ email = 'admin@admin.com'; password = 'adminadmin' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$base/api/v2/passport/auth/login" -ContentType 'application/json' -Body $loginBody
$token = $login.data.token
Invoke-RestMethod -Method Get -Uri "$base/api/v2/admin/config/fetch" -Headers @{ Authorization = $token }
Invoke-RestMethod -Method Get -Uri "$base/api/v2/admin/stat/getStats" -Headers @{ Authorization = $token }
```

The second request intentionally uses:

```text
Authorization: <token>
```

not:

```text
Authorization: Bearer <token>
```

That matches the official admin frontend.

## Coding Style And Constraints

General:

- Keep changes narrowly scoped.
- Preserve existing folder independence.
- Do not add a monorepo-level shared package unless the user explicitly allows it.
- Do not commit `origin/`, `.tmp/`, `docs/`, `node_modules/`, `.wrangler/`, or generated dry-run output.
- Use TypeScript for Worker code.
- Keep APIs JSON-compatible with the official frontend.

Database:

- Use D1 prepared statements.
- Avoid string interpolation for user-controlled values.
- Table names are only interpolated from controlled internal maps.
- Store JSON in `TEXT`.
- Store timestamps as Unix seconds.

API responses:

- Existing helper `ok(data)` returns:

```json
{ "data": "<value>" }
```

- Existing helper `fail(message, status, code)` returns:

```json
{
  "message": "Error",
  "errors": "Error",
  "code": 400
}
```

Frontend compatibility:

- Missing nested object fields can crash the admin React bundle.
- Prefer returning empty arrays/objects with complete shapes over minimal placeholders.
- When adding endpoints used by admin, inspect the minified bundle around the function that calls the endpoint and return the expected shape.

## Reference Repositories

Upstream references:

```text
https://github.com/cedar2025/Xboard
https://github.com/cedar2025/xboard-admin-dist
https://github.com/cedar2025/xboard-user
https://github.com/cedar2025/Xboard-Node
```

Use:

- `cedar2025/Xboard` for original database/API behavior.
- `cedar2025/xboard-admin-dist` for the admin Web UI dist.
- `cedar2025/xboard-user` for user API compatibility.
- `cedar2025/Xboard-Node` for node API behavior.

Downloaded reference repositories, scripts, and generated analysis should go under `.tmp/` and must not be committed.

## What To Do When Continuing Work

1. Run:

```bash
git status --short --branch
```

2. Inspect recent commits:

```bash
git log --oneline --decorate --max-count=10
```

3. If the user reports a frontend crash, search the admin bundle for the field in the error message:

```bash
rg -n "fieldName" workers/xboard-edge/public/assets/index-CEIYH7i8.js
```

Because the bundle is minified, prefer a small Node snippet to print context around the match instead of dumping entire minified lines:

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('workers/xboard-edge/public/assets/index-CEIYH7i8.js','utf8'); const i=s.indexOf('fieldName'); console.log(s.slice(Math.max(0,i-1000), i+2000));"
```

4. Patch the relevant API response shape.

5. Run:

```bash
cd workers/xboard-edge
npm run typecheck
npm test
```

6. Commit and push to `master`.

7. Confirm Cloudflare Workers Builds produced a successful build for the changed Worker.

8. Run smoke tests with real deployed URLs.

## Current Honest Limitations

This codebase is not yet a complete, audited, 100% feature-perfect replacement for original XBoard.

Known areas that are compatibility scaffolds or partial:

- Payment flows are disabled.
- Many admin CRUD endpoints are generic compatibility handlers.
- Some plugin/theme endpoints may still need shape-specific responses.
- Queue processing and cron behavior are minimal compared with a full Laravel scheduler.
- Subscription output should be tested against real clients before production use.
- Node/server APIs should be tested with actual XBoard-Node clients.

When reporting status to the user, be honest about these limitations. Do not claim complete parity unless it has actually been implemented and tested.

## Git And Deployment Notes

Normal push works when Git credentials are available:

```bash
git add <files>
git commit -m "Message"
git push origin master
```

Cloudflare should then automatically build only the Worker whose watched path changed.

If Git credentials are unavailable, do not invent a deployment flow. Report the blocker and leave local changes staged or unstaged according to the user request.

Do not force-push unless the user explicitly authorizes it.

## Last Known Working Login

Use:

```text
https://<your-xboard-edge-worker-domain>/admin
admin@admin.com
adminadmin
```

After login, the dashboard should load without:

```text
未授权
Cannot read properties of undefined (reading 'upload')
```

If either error returns, see the pitfall sections above first.
