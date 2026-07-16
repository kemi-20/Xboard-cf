import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

test("xboard-edge has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("admin authentication accepts raw and Bearer Authorization tokens", () => {
  const script = `
    const { getBearer } = await import("./src/compat.ts");
    const read = (headers) => getBearer(new Request("https://audit.invalid", { headers }));
    console.log(JSON.stringify({
      raw: read({ authorization: "raw-session-token" }),
      bearer: read({ authorization: "Bearer raw-session-token" }),
      emptyBearer: read({ authorization: "Bearer" }),
      compatibility: read({ "x-token": "compat-session-token" })
    }));
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    raw: "raw-session-token",
    bearer: "raw-session-token",
    emptyBearer: null,
    compatibility: "compat-session-token"
  });
});

test("new installations default node polling to five minutes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const seed = fs.readFileSync("../../schema/seed.sql", "utf8");
  assert.match(source, /server_pull_interval: 300, server_push_interval: 300/);
  assert.match(seed, /\('server_pull_interval', '300'/);
  assert.match(seed, /\('server_push_interval', '300'/);
});

test("fresh trial duration matches upstream while node polling remains cost optimized", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const seed = fs.readFileSync("../../schema/seed.sql", "utf8");
  assert.match(source, /try_out_plan_id: 1, try_out_hour: 1/);
  assert.match(seed, /\('try_out_hour', '1'/);
});

test("SQLite migration normalizes upstream nullable numeric fields required by D1", () => {
  const source = fs.readFileSync("src/migration.ts", "utf8");
  for (const field of ["remind_expire", "remind_traffic"]) assert.match(source, new RegExp(`row\\.${field} == null\\) row\\.${field} = 1`));
  assert.match(source, /table === "v2_plan"[\s\S]*row\.transfer_enable == null\) row\.transfer_enable = 0/);
  assert.match(source, /table === "v2_plan"[\s\S]*row\.sort == null\) row\.sort = 0/);
  assert.match(source, /table === "v2_server" && row\.sort == null\) row\.sort = 0/);
});

test("orders accept canonical periods and expose configured reset and surplus details", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /canonicalOrderPeriods\.has\(value\) \? value : ""/);
  assert.match(source, /const period = normalizeOrderPeriod\(legacyPeriod\)/);
  assert.match(source, /new_order_event_id/);
  assert.match(source, /renew_order_event_id/);
  assert.match(source, /change_order_event_id/);
  assert.match(source, /surplus_orders: surplusResult\.results \|\| \[\]/);
  assert.match(source, /new Date\(\(timestamp \+ EDGE_SHANGHAI_OFFSET\) \* 1000\)/);
});

test("machine form validates while typing", () => {
  const adminBundle = fs.readFileSync("public/assets/index-CF20260713.js", "utf8");
  const machineFormStart = adminBundle.indexOf("const t3t=");
  assert.notEqual(machineFormStart, -1);
  assert.match(adminBundle.slice(machineFormStart, machineFormStart + 500), /mode:"onChange"/);
});

test("admin shell references the current bundle without caching", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /src="\/assets\/index-CF20260713\.js"/);
  assert.doesNotMatch(source, /src="\/assets\/index-CEIYH7i8\.js"/);
  assert.match(source, /"cache-control": "no-store, no-cache, must-revalidate"/);
  assert.match(source, /window\.settings = \$\{settingsJson\}/);
  assert.match(source, /id = "xboard-migration-menu"/);
  assert.match(source, /=== "\/config\/knowledge"/);
  assert.match(source, /knowledgeLink\?\.closest\("li"\) \|\| knowledgeLink/);
  assert.match(source, /sourceItem\.insertAdjacentElement\("afterend", item\)/);
  assert.doesNotMatch(source, /nav\.appendChild\(link\)/);
  assert.match(source, /link\.innerHTML = '<div class="mr-2">/);
  assert.match(source, /if \(text && text\.textContent !== label\.text\) text\.textContent = label\.text/);
  assert.match(source, /M20 17v6/);
  assert.match(source, /M17 20l3 3l3 -3/);
  assert.match(source, /localStorage\.getItem\("i18nextLng"\)/);
  assert.match(source, /"en-US": \{ text: "Data Migration"/);
  assert.match(source, /"ru-RU": \{ text: "Миграция данных"/);
  assert.match(source, /new Intl\.DateTimeFormat\(undefined/);
  assert.match(source, /if \(version\.textContent !== date\) version\.textContent = date/);
  assert.match(source, /window\.setInterval\(updateFooterDate, 60000\)/);
  assert.doesNotMatch(source, /position:fixed;left:16px;bottom:12px/);
});

test("mobile node editor remains inside the visual viewport after keyboard dismissal", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const html = fs.readFileSync("public/index.html", "utf8");
  const script = fs.readFileSync("public/assets/mobile-node-dialog-fix.js", "utf8");
  const style = fs.readFileSync("public/assets/mobile-node-dialog-fix.css", "utf8");

  for (const document of [source, html]) {
    assert.match(document, /\/assets\/mobile-node-dialog-fix\.css/);
    assert.match(document, /\/assets\/mobile-node-dialog-fix\.js/);
  }
  assert.match(script, /window\.visualViewport\?\.height \|\| window\.innerHeight/);
  assert.match(script, /visualViewport\?\.addEventListener\("resize"/);
  assert.match(script, /document\.addEventListener\("focusout"/);
  assert.match(script, /\[50, 200, 500\]/);
  assert.match(script, /h-\[75vh\]/);
  assert.match(script, /min-h-\[500px\]/);
  assert.match(style, /@media \(max-width: 767px\)/);
  assert.match(style, /--xboard-visual-viewport-height/);
  assert.match(style, /\.xboard-mobile-node-dialog-form/);
  assert.match(style, /padding-bottom: max\(1rem, env\(safe-area-inset-bottom\)\)/);
});

test("admin search hides reserved pages and includes data migration", () => {
  const bundle = fs.readFileSync("public/assets/index-CF20260713.js", "utf8");
  const zh = fs.readFileSync("public/locales/zh-CN.js", "utf8");
  const en = fs.readFileSync("public/locales/en-US.js", "utf8");
  const ru = fs.readFileSync("public/locales/ru-RU.js", "utf8");
  assert.match(bundle, /\.filter\(e=>!\["\/config\/plugin","\/config\/payment","\/config\/theme"\]\.includes\(e\.href\)\)/);
  assert.match(bundle, /id:"data-migration-search",title:"nav:dataMigration"/);
  assert.match(bundle, /href:`\$\{window\.location\.origin\}\$\{window\.settings\.secure_path\}\/migration`/);
  assert.match(bundle, /window\.location\.assign\(e\)/);
  assert.match(zh, /"dataMigration": "数据迁移"/);
  assert.match(en, /"dataMigration": "Data Migration"/);
  assert.match(ru, /"dataMigration": "Миграция данных"/);
});

test("admin UI and API follow the saved secure path", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function currentSecurePath/);
  assert.match(source, /const adminUiPath = `\/\$\{securePath\}`/);
  assert.match(source, /const dynamicAdminPrefix = `\/api\/v2\/\$\{securePath\}`/);
  assert.match(source, /const canonicalPath = `\/api\/v2\/admin\$\{url\.pathname\.slice\(dynamicAdminPrefix\.length\)\}`/);
  assert.match(source, /securePath !== "admin" && securePath\.length < 8/);
  assert.match(source, /securePath !== "admin"/);
  assert.doesNotMatch(source, /url\.pathname === "\/admin" \|\| url\.pathname\.startsWith\("\/admin\/"\)/);
});

test("dashboard queue statistics honor the official time windows", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /cachedData\("queue-stats", 60/);
  assert.match(source, /globalThis as any\)\.caches\?\.default/);
  assert.match(source, /status = 'failed' AND COALESCE\(updated_at, created_at\) >= \?/);
  assert.match(source, /SELECT COUNT\(\*\) AS count FROM failed_jobs WHERE failed_at >= \?/);
  assert.match(source, /current - 10080 \* 60/);
  assert.match(source, /status = 'done' AND updated_at >= \?/);
  assert.match(source, /status = 'failed' AND updated_at >= \?/);
  assert.match(source, /current - 60 \* 60/);
  assert.doesNotMatch(source, /SELECT status, COUNT\(\*\) AS count FROM v2_job_logs GROUP BY status/);
  assert.match(source, /FROM failed_jobs WHERE failed_at >= \?/);
  assert.match(source, /FROM v2_job_logs WHERE status = 'failed'/);
  assert.match(source, /ORDER BY failed_at DESC LIMIT \? OFFSET \?/);
});

test("registration limits use the Cloudflare visitor IP and preserve it during automatic login", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /request\.headers\.get\("cf-connecting-ip"\) \|\| request\.headers\.get\("x-forwarded-for"\)/);
  assert.match(source, /const rateKey = `rate:register:\$\{requestIp\(request\)\}`/);
  assert.match(source, /\["cf-connecting-ip", "x-forwarded-for", "user-agent"\]/);
  assert.match(source, /headers: loginHeaders/);
});

test("admin CRUD routes server resources to their own tables", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /\["\/server\/group\/", "v2_server_group"\]/);
  assert.match(source, /\["\/server\/route\/", "v2_server_route"\]/);
  assert.match(source, /\["\/server\/machine\/", "v2_server_machine"\]/);
  assert.match(source, /\["\/server\/manage\/", "v2_server"\]/);
  assert.match(source, /const table = adminTableForPath\(path\)/);
});

test("server groups include the user and node counts expected by the official admin UI", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function adminServerGroupRows\(env: Env\)/);
  assert.match(source, /users_count: userCounts\.get\(Number\(group\.id\)\) \|\| 0/);
  assert.match(source, /server_count: serverCounts\.get\(Number\(group\.id\)\) \|\| 0/);
  assert.match(source, /suffix === "\/server\/group\/fetch"\) return ok\(await adminServerGroupRows\(env\)\)/);
});

test("audited compatibility fixes match upstream order, ticket and statistics behavior", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function orderSurplus/);
  assert.match(source, /surplus_amount, surplus_credit, surplus_order_ids/);
  assert.match(source, /VALUES \(\?, \?, \?, 0, 0, \?, \?, \?\)/);
  assert.match(source, /UPDATE v2_ticket SET reply_status = 0/);
  assert.match(source, /SELECT COALESCE\(SUM\(online_count\), 0\) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >=/);
  assert.match(source, /SELECT COUNT\(\*\) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >=/);
  assert.match(source, /SELECT COALESCE\(SUM\(get_amount\), 0\)/);
  assert.doesNotMatch(source, /COALESCE\(SUM\(COALESCE\(get_amount, amount, 0\)\)/);
  assert.match(source, /coupon\.limit_use !== null[\s\S]*Number\(coupon\.limit_use\) <= 0/);
  assert.match(source, /capacity_limit === null \|\| \(row as any\)\.capacity_limit === undefined/);
});

test("server validation keeps public and backend ports independent", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /for \(const field of \["type", "name", "host", "port", "server_port", "rate"\]\)/);
  assert.match(source, /const port = Number\(input\.port\)/);
  assert.match(source, /const serverPort = Number\(input\.server_port\)/);
  assert.doesNotMatch(source, /server\.name = `\$\{server\.name \|\| "Node"\} Copy`/);
});

test("bootstrap preserves renamed default groups", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /INSERT INTO v2_server_group[\s\S]*?ON CONFLICT\(id\) DO NOTHING/);
});

test("bootstrap never overwrites an existing customized default plan", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const seed = fs.readFileSync("../../schema/seed.sql", "utf8");
  assert.match(source, /INSERT INTO v2_plan[\s\S]*?ON CONFLICT\(id\) DO NOTHING/);
  assert.match(seed, /INSERT INTO v2_plan[\s\S]*?ON CONFLICT\(id\) DO NOTHING/);
  assert.doesNotMatch(source, /ON CONFLICT\(id\) DO UPDATE SET group_id = excluded\.group_id, transfer_enable = excluded\.transfer_enable, name = excluded\.name/);
});

test("cache version bumps cannot turn successful D1 saves into API errors", () => {
  const source = fs.readFileSync("src/kv.ts", "utf8");
  assert.match(source, /try[\s\S]*await kv\.put\(key, String\(Date\.now\(\)\)\)[\s\S]*catch/);
});

test("worker settings use memory, versioned KV snapshots and D1 fallback", () => {
  for (const file of [
    "src/db.ts",
    "../xboard-server/src/db.ts",
    "../xboard-subscription/src/db.ts",
    "../xboard-jobs/src/db.ts",
    "../xboard-cron/src/db.ts"
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /const SETTINGS_CACHE_TTL_MS = 300_000/);
    assert.match(source, /const SETTINGS_VERSION_CHECK_MS = 30_000/);
    assert.match(source, /settings:snapshot:/);
    assert.match(source, /availableKv\.get\("settings_version"\)/);
    assert.match(source, /availableKv = undefined/);
    assert.match(source, /expirationTtl: SETTINGS_SNAPSHOT_TTL_SECONDS/);
    assert.match(source, /SELECT name, value FROM v2_settings/);
  }
});

test("settings saves invalidate the xboard-server instance cache", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const migration = fs.readFileSync("src/migration.ts", "utf8");
  assert.match(source, /async function invalidateServerSettings\(env: Env\)/);
  assert.match(source, /internal\/settings\/invalidate/);
  assert.match(source, /invalidateSettingsCache\(\);\s*await invalidateServerSettings\(env\)/);
  assert.match(migration, /async function resetServerRuntime\(env: MigrationEnv\)/);
  assert.match(migration, /internal\/settings\/invalidate/);
  assert.match(migration, /await resetServerRuntime\(env\)/);
});

test("node protocol paths are proxied through the xboard-server service binding", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /isNodeProtocolPath\(url\.pathname, request\.method\)/);
  assert.match(source, /pathname === "\/api\/v2\/server\/machine\/nodes"[\s\S]*method === "POST"/);
  assert.match(source, /env\.XBOARD_SERVER\.fetch\(request\)/);
  assert.match(source, /\/api\/v1\/server\//);
  assert.match(source, /\/api\/v2\/server\/machine\/nodes/);
  assert.match(wrangler, /binding = "XBOARD_SERVER"/);
  assert.match(wrangler, /service = "xboard-server"/);
});

test("official subscription paths are proxied through the subscription service binding", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /XBOARD_SUBSCRIPTION: Fetcher/);
  assert.match(source, /url\.pathname === "\/api\/v1\/client\/subscribe"/);
  assert.match(source, /async function currentSubscribePath/);
  assert.match(source, /isSubscriptionPath\(url\.pathname, await currentSubscribePath\(env\)\)/);
  assert.doesNotMatch(source, /url\.pathname\.startsWith\("\/sub\/"\)/);
  assert.match(wrangler, /binding = "XBOARD_SUBSCRIPTION"[\s\S]*service = "xboard-subscription"/);
});

test("machine detail GET endpoints read ids from query parameters", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const getToken = source.slice(source.indexOf('if (path.includes("/server/machine/getToken"))'), source.indexOf('if (path.includes("/server/machine/installCommand"))'));
  const installCommand = source.slice(source.indexOf('if (path.includes("/server/machine/installCommand"))'), source.indexOf('if (path.includes("/server/machine/resetToken"))'));
  assert.match(getToken, /new URL\(request\.url\)\.searchParams\.get\("id"\)/);
  assert.match(installCommand, /new URL\(request\.url\)\.searchParams\.get\("id"\)/);
  assert.match(source, /--mode machine --panel/);
  assert.match(source, /--machine-id \$\{machineId\}/);
});

test("machine tokens match Laravel Str::random(32) format", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const compat = fs.readFileSync("src/compat.ts", "utf8");
  assert.match(source, /const machineToken = randomString\(32\)/);
  assert.match(compat, /ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(compat, /export function randomString\(length = 32\)/);
});

test("generated subscription URLs honor configured domain and path", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /const values = await settings\(env\.XBOARD_DB, env\.XBOARD_KV\)/);
  assert.match(source, /values\.subscribe_url/);
  assert.match(source, /values\.subscribe_path/);
  assert.match(source, /configuredList\[Math\.floor\(Math\.random\(\) \* configuredList\.length\)\]/);
  assert.match(source, /\.replace\(\/\\\[\(\\d\+\)-\(\\d\+\)\\\]\/g/);
  assert.match(source, /\.replaceAll\("\[uuid\]", crypto\.randomUUID\(\)\)/);
  assert.match(source, /await subscribeUrl\(request, env,/);
});

test("bootstrap persists generated Cloudflare bindings for Workers Builds", () => {
  const workflow = fs.readFileSync("../../.github/workflows/deploy.yml", "utf8");
  const bootstrap = fs.readFileSync("../../scripts/prepare-cloudflare-ci.mjs", "utf8");
  assert.match(workflow, /permissions:\s+contents: write/);
  assert.match(workflow, /git diff --quiet -- workers\/\*\/wrangler\.toml/);
  assert.match(workflow, /git add workers\/\*\/wrangler\.toml/);
  assert.match(workflow, /git commit -m "Configure Cloudflare resource bindings"/);
  assert.match(workflow, /git push origin "HEAD:\$\{GITHUB_REF_NAME\}"/);
  assert.match(bootstrap, /body: JSON\.stringify\(\{ name, primary_location_hint: "apac" \}\)/);
  assert.match(bootstrap, /read_replication: \{ mode: "auto" \}/);
  assert.match(bootstrap, /if \(existing\) return \{ database: existing, created: false \}/);
  assert.match(bootstrap, /if \(databaseCreated\) await enableReadReplication\(account\.id, databaseId\)/);
  assert.match(bootstrap, /Warning: xboard-db was created successfully, but read replication could not be enabled/);
  assert.match(bootstrap, /patchWrangler\(worker, account\.id, databaseId, kv\.id\)/);
  assert.match(bootstrap, /"telegram-events"/);
  assert.match(bootstrap, /"telegram-events-dlq"/);
});

test("admin can fetch a fresh subscription URL for the copy action", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /path\.includes\("\/user\/getSubscribe"\)/);
  assert.match(source, /SELECT token FROM v2_user WHERE id = \?/);
});

test("plan list hides payment periods whose price is blank", () => {
  const bundle = fs.readFileSync("public/assets/index-CF20260713.js", "utf8");
  assert.match(bundle, /null!=n\[t\]&&""!==String\(n\[t\]\)\.trim\(\)&&Q\.jsxs/);
});

test("user editor defaults missing commission type safely", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const bundle = fs.readFileSync("public/assets/index-CF20260713.js", "utf8");
  assert.match(source, /ALTER TABLE v2_user ADD COLUMN commission_type INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /commission_type: Number\(row\.commission_type \?\? 0\)/);
  assert.match(bundle, /value:\(t\.value\?\?0\)\.toString\(\)/);
});

test("admin user and node forms receive upstream-compatible boolean values", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  for (const field of ["banned", "is_admin", "is_staff", "remind_expire", "remind_traffic", "commission_auto_check"]) {
    assert.match(source, new RegExp(`${field}: Boolean\\(boolNumber\\(row\\.${field}`));
  }
  assert.match(source, /rate_time_enable: Boolean\(Number\(server\.rate_time_enable/);
  assert.match(source, /protocol_settings: parseJsonObject\(server\.protocol_settings\)/);
  assert.doesNotMatch(source, /paginated\(data,[^\n]+meta: result/);
});

test("admin APIs reject non-official paths and methods before loose compatibility handlers", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function adminRouteAllowed\(route: string, method: string\)/);
  assert.match(source, /if \(!adminRouteAllowed\(route, request\.method\)\) return json\(\{ message: "Not Found" \}, 404\)/);
  assert.match(source, /"\/server\/group\/save": \["POST"\]/);
});

test("passport, guest and client routes are separated from authenticated user routes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /startsWith\("\/api\/v1\/passport"\).*startsWith\("\/api\/v2\/passport"\)/s);
  assert.match(source, /startsWith\("\/api\/v1\/guest"\)\) return guestApi/);
  assert.match(source, /startsWith\("\/api\/v1\/client"\).*startsWith\("\/api\/v2\/client"\)/s);
  assert.doesNotMatch(source, /startsWith\("\/api\/v1"\).*return userApi/);
});

test("route fetch returns match rules as an array", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function routeMatchArray\(value: unknown\): string\[\]/);
  assert.match(source, /match: routeMatchArray\(route\.match\)/);
  assert.match(source, /suffix === "\/server\/route\/fetch"\) return ok\(await adminRouteRows\(env\)\)/);
});

test("node list exposes upstream-compatible health and load fields", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function nodeAvailableStatus\(lastCheckAt: number \| null, lastPushAt: number \| null/);
  assert.match(source, /timestamp - 300 >= lastCheckAt/);
  assert.match(source, /statusSnapshot\(env\)/);
  assert.match(source, /live\.nodes/);
  assert.match(source, /live\.machines/);
  assert.match(source, /available_status: availableStatus/);
  assert.match(source, /load_status: loadStatus/);
  assert.match(source, /online_conn: Number\(metrics\?\.active_connections \|\| 0\)/);
  assert.match(source, /machines\.find\(item => Number\(item\.id\) === Number\(server\.machine_id\)\)/);
  assert.match(source, /machineOnline \? machineSeenAt : 0/);
  assert.match(source, /const loadStatus = nodeState\.load_status \|\| machineState\.load_status \|\| null/);
});

test("machine load history matches the upstream chart contract", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function adminMachineHistory\(env: Env, url: URL\)/);
  assert.match(source, /limit < 10 \|\| limit > 1440/);
  assert.match(source, /rangeHours < 1 \|\| rangeHours > 24/);
  assert.match(source, /statusHubRequest\(env, `history\?\$\{params\}`\)/);
  assert.match(source, /new URLSearchParams\(\{ machine_id: String\(machineId\), limit: String\(limit\) \}\)/);
  assert.match(source, /return ok\(payload\.data \|\| \[\]\)/);
  assert.match(source, /return adminMachineHistory\(env, new URL\(request\.url\)\)/);
});

test("login sessions fall back to D1 when KV writes fail", () => {
  const source = fs.readFileSync("src/auth.ts", "utf8");
  const d1Insert = source.indexOf('INSERT INTO personal_access_tokens');
  const kvWrite = source.indexOf('await kv.put');
  assert.ok(d1Insert >= 0 && kvWrite > d1Insert);
  assert.match(source.slice(kvWrite - 20, kvWrite + 500), /try[\s\S]*await kv\.put[\s\S]*catch/);
});

test("bootstrap remains available when the KV daily write limit is exhausted", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /system_bootstrap_edge_version/);
  assert.match(source, /await optionalKvPut\(env, "bootstrap:edge:v20"/);
  assert.doesNotMatch(source, /await env\.XBOARD_KV\.put\("bootstrap:edge:v12"/);
});

test("overwrite migrations suppress first-run seed data", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /mode = 'overwrite' AND status != 'rolled_back'/);
  assert.match(source, /if \(!preserveMigratedData\) \{[\s\S]*SELECT COUNT\(\*\) AS c FROM v2_user/);
  assert.doesNotMatch(source, /DELETE FROM v2_user WHERE email = 'admin@admin\.com'/);
  assert.match(source, /if \(!preserveMigratedData\) \{[\s\S]*Preserve sender identity and initialize the provider choice/);
  assert.doesNotMatch(source, /ON CONFLICT\(email\) DO UPDATE SET password = excluded\.password/);
});

test("dashboard statistics follow the upstream order and server traffic contracts", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const stats = source.slice(source.indexOf("async function adminStats"), source.indexOf("function dateString"));
  assert.match(stats, /status NOT IN \(0,2\)/);
  assert.match(stats, /FROM v2_stat_server/);
  assert.doesNotMatch(stats, /FROM v2_stat_user/);
  for (const field of ["todayIncome", "currentMonthIncome", "lastMonthIncome", "currentMonthCommissionPayout", "onlineNodes", "todayTraffic", "monthTraffic", "totalTraffic"]) {
    assert.match(stats, new RegExp(field));
  }
});

test("traffic rankings use one period aggregation and a short non-KV cache", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const rank = source.slice(source.indexOf("async function trafficRank"), source.indexOf("async function planById"));
  assert.match(rank, /cachedData\(`traffic-rank:/);
  assert.match(rank, /WITH traffic AS/);
  assert.match(rank, /SUM\(CASE WHEN record_at >= \?/);
  assert.doesNotMatch(rank, /SELECT SUM\(previous\.u \+ previous\.d\)/);
  assert.doesNotMatch(rank, /XBOARD_KV/);
});

test("storage optimization removes write-heavy unused traffic indexes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const schema = fs.readFileSync("../../schema/d1.sql", "utf8");
  for (const name of ["idx_v2_stat_user_u", "idx_v2_stat_user_d", "idx_v2_stat_user_record", "idx_v2_stat_server_upload", "idx_v2_stat_server_download", "idx_v2_stat_server_record"]) {
    assert.match(source, new RegExp(`"DROP INDEX IF EXISTS ${name}"`));
    assert.doesNotMatch(schema, new RegExp(`CREATE INDEX IF NOT EXISTS ${name}(?:\\s+ON|;)`));
  }
  assert.match(source, /idx_v2_stat_server_record_server ON v2_stat_server\(record_at, server_id, server_type\)/);
  assert.match(schema, /idx_v2_stat_server_record_server ON v2_stat_server\(record_at, server_id, server_type\)/);
  assert.match(source, /bootstrap:storage:v3/);
  assert.match(source, /DROP INDEX IF EXISTS idx_v2_job_logs_status_time/);
  assert.doesNotMatch(schema, /CREATE INDEX IF NOT EXISTS idx_v2_job_logs_status_time/);
  assert.match(schema, /idx_v2_job_logs_failed_time ON v2_job_logs\(updated_at, created_at\) WHERE status = 'failed'/);
});

test("edge database requests default to primary and only audited guest reads use an unconstrained session", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const db = fs.readFileSync("src/db.ts", "utf8");
  assert.match(db, /db\.withSession\("first-primary"\)/);
  assert.match(db, /db\.withSession\("first-unconstrained"\)/);
  assert.match(source, /XBOARD_DB: primaryDatabase\(env\.XBOARD_DB\)/);
  assert.match(source, /PUBLIC_READ_DB: unconstrainedDatabase\(env\.XBOARD_DB\)/);
  const guest = source.slice(source.indexOf("async function guestApi"), source.indexOf("async function clientUser"));
  assert.match(guest, /request\.method === "GET" && path === "\/api\/v1\/guest\/plan\/fetch"/);
  assert.match(guest, /request\.method === "GET" && path === "\/api\/v1\/guest\/comm\/config"/);
  assert.equal((guest.match(/const readEnv = env\.PUBLIC_READ_DB/g) || []).length, 1);
  assert.equal((guest.match(/const readDb = env\.PUBLIC_READ_DB/g) || []).length, 1);
  assert.match(guest, /SETTINGS_MEMORY_SCOPE: "public"/);
  assert.match(db, /settingsCaches = new Map/);
  assert.match(db, /settingsPromises = new Map/);
});

test("revenue overview reads the migrated daily statistics table", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const stats = source.slice(source.indexOf("async function orderStats"), source.indexOf("async function trafficRank"));
  assert.match(stats, /FROM v2_stat WHERE/);
  assert.match(stats, /record_type = 'd'/);
  assert.match(stats, /paid_total,paid_count,commission_total,commission_count/);
  assert.doesNotMatch(stats, /FROM v2_order/);
  assert.match(stats, /avg_commission_amount/);
});

test("email settings describe Maileroo and Brevo instead of SMTP or Resend", () => {
  const chinese = fs.readFileSync("public/locales/zh-CN.js", "utf8");
  const english = fs.readFileSync("public/locales/en-US.js", "utf8");
  const russian = fs.readFileSync("public/locales/ru-RU.js", "utf8");
  assert.match(chinese, /选择 Maileroo 或 Brevo/);
  assert.match(english, /Choose Maileroo or Brevo/);
  assert.doesNotMatch(english.slice(english.indexOf('"email": {'), english.indexOf('"telegram": {')), /SMTP/);
  assert.doesNotMatch(english.slice(english.indexOf('"email": {'), english.indexOf('"telegram": {')), /Resend/);
  assert.match(russian, /Выберите Maileroo или Brevo/);
  assert.doesNotMatch(russian.slice(russian.indexOf('"email": {'), russian.indexOf('"telegram": {')), /SMTP/);
});

test("admin migration imports official SQLite data in bounded D1 batches", () => {
  const source = fs.readFileSync("src/migration.ts", "utf8");
  const index = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /sourceRows\.length > 100/);
  assert.match(source, /run\.mode === "overwrite" \? "INSERT" : "INSERT OR IGNORE"/);
  assert.match(source, /INSERT OR IGNORE/);
  assert.match(source, /transfer_used_total/);
  assert.match(source, /\["v2_stat", "v2_stat_user", "v2_stat_server"\][\s\S]*?row\.record_type = "d"/);
  assert.match(source, /v2_server_machine/);
  assert.match(source, /row\.password_algo = \/\^\\\$2\[aby\]\\\$\/.+\? "bcrypt" : "pbkdf2"/);
  assert.match(source, /table === "failed_jobs"/);
  assert.match(source, /failedAt < now\(\) - FAILED_JOB_RETENTION_SECONDS/);
  assert.match(source, /DELETE FROM failed_jobs WHERE failed_at < \?/);
  assert.match(source, /DELETE FROM v2_job_logs WHERE COALESCE\(updated_at, created_at\) < \?/);
  assert.match(source, /x-migration-token/);
  assert.match(source, /access_token_hash = NULL/);
  assert.match(index, /handleAdminMigration/);
  assert.match(index, /\/migration\/status/);
});

test("complete migration deletes old business data before strict replacement", () => {
  const source = fs.readFileSync("src/migration.ts", "utf8");
  const page = fs.readFileSync("public/migration/panel.html", "utf8");
  const app = fs.readFileSync("public/migration/app.js", "utf8");
  assert.match(source, /COMPLETE_RESET_TABLES = \["v2_log", "v2_server_machine_load_history", "v2_job_logs", "v2_traffic_pending_check", "v2_traffic_dedup"\]/);
  assert.match(source, /DELETE FROM sqlite_sequence WHERE name IN/);
  assert.match(source, /COMPLETE_RESET_TABLES\.map\(\(\) => "\?"\)/);
  assert.match(source, /rollback_progress = \?[\s\S]*DELETE FROM sqlite_sequence WHERE name IN/);
  assert.match(source, /targetMismatches/);
  assert.match(source, /counts\[table\] !== expected/);
  assert.match(source, /name != 'system_bootstrap_edge_version'/);
  assert.match(source, /run\.mode === "overwrite"[\s\S]*COMPLETE_RESET_TABLES\.map/);
  assert.match(source, /完成数据切换失败/);
  assert.match(page, /完整迁入（删除原数据后切换）/);
  assert.match(app, /完整迁入会删除当前 D1 的全部旧业务数据/);
  assert.match(app, /不会保留 admin@admin\.com 或其他旧记录/);
});

test("migration UI parses SQLite and Redis backups locally", () => {
  const page = fs.readFileSync("public/migration/panel.html", "utf8");
  const app = fs.readFileSync("public/migration/app.js", "utf8");
  const index = fs.readFileSync("src/index.ts", "utf8");
  assert.match(page, /SQLite3/);
  assert.match(page, /Redis RDB \/ JSON/);
  assert.match(page, /SQLite3 数据库（必选）/);
  assert.match(page, /Redis RDB \/ JSON（可选）/);
  assert.match(page, /sqlite-file/);
  assert.match(page, /redis-file/);
  assert.match(app, /source_type: hasRedis \? "xboard" : "sqlite"/);
  assert.match(app, /if \(hasRedis\) await migrateRedis\(\)/);
  assert.match(app, /未选择 Redis 备份/);
  assert.match(app, /initSqlJs/);
  assert.match(app, /REDIS\\d\{4\}/);
  assert.match(app, /usefulRedisKey/);
  assert.match(app, /XBOARD_ACCESS_TOKEN/);
  assert.match(app, /localStorage, sessionStorage/);
  assert.match(app, /parsed\?\.value\?\.auth_data/);
  assert.match(app, /api\/v2\/admin\/migration/);
  assert.match(app, /选择 Maileroo 或 Brevo，并手动配置 API Key/);
  assert.match(app, /所有插件、插件配置、支付渠道和服务器机器负载历史不会导入/);
  assert.match(page, /id="skip-backup"/);
  assert.match(app, /skip_backup: state\.skipBackup/);
  assert.match(app, /强制账号备份已下载/);
  assert.match(app, /tables: started\.backup_tables/);
  assert.match(app, /const batchSize = 100/);
  assert.match(app, /table, offset, limit: 100/);
  assert.match(index, /\/api\/v2\/admin\/migration/);
});

test("migration excludes service credentials that cannot move to Cloudflare", () => {
  const source = fs.readFileSync("src/migration.ts", "utf8");
  assert.match(source, /NON_MIGRATABLE_SERVICE_TABLES/);
  assert.match(source, /"v2_payment"/);
  assert.match(source, /"v2_plugins"/);
  assert.match(source, /NON_MIGRATABLE_MAIL_SETTINGS/);
  assert.match(source, /"email_password"/);
  assert.match(source, /"resend_api_key"/);
  assert.match(source, /NON_MIGRATABLE_SERVICE_TABLES\.has\(table\)/);
  assert.match(source, /key\.startsWith\("plugin"\)/);
  assert.match(source, /skip_backup INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /该迁移已跳过备份，无法一键还原/);
  assert.match(source, /CRITICAL_BACKUP_TABLES = \["v2_user", "personal_access_tokens"\]/);
  assert.match(source, /SKIPPED_SOURCE_TABLES = \["v2_log", "v2_server_machine_load_history"\]/);
  assert.match(source, /skipped_tables: SKIPPED_SOURCE_TABLES/);
  assert.match(source, /DELETE FROM v2_server_machine_load_history/);
  const migrationTables = source.slice(source.indexOf("const MIGRATION_TABLES"), source.indexOf("const CRITICAL_BACKUP_TABLES"));
  assert.doesNotMatch(migrationTables, /v2_server_machine_load_history/);
  assert.match(source, /skipped_service_config/);
});

test("unsupported plugin, payment, and theme menus stay reserved but hidden", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /Reserved for future native plugin, payment, and theme implementations/);
  assert.match(source, /target\.hash\.replace\(\/\^#\//);
  assert.match(source, /route === "\/config\/plugin"/);
  assert.match(source, /route === "\/config\/payment"/);
  assert.match(source, /route === "\/config\/theme"/);
  assert.match(source, /a\[href\$="#\/config\/theme"\]/);
  assert.match(source, /display: none !important/);
  assert.match(source, /menu\.closest\("li"\) \|\| menu/);
  assert.match(source, /item\.style\.display = "none"/);
  assert.match(source, /api\.telegram\.org\/bot\$\{botToken\}/);
});

test("migration does not import or export application log records", () => {
  const source = fs.readFileSync("src/migration.ts", "utf8");
  const tableList = source.match(/const MIGRATION_TABLES = \[[\s\S]*?\] as const;/)?.[0] || "";
  assert.doesNotMatch(tableList, /"v2_log"/);
  assert.doesNotMatch(tableList, /"v2_server_machine_load_history"/);
  assert.match(fs.readFileSync("public/migration/app.js", "utf8"), /\(skip\)/);
  assert.match(fs.readFileSync("../../schema/d1.sql", "utf8"), /CREATE TABLE IF NOT EXISTS v2_log/);
});

test("bootstrap creates the upstream performance indexes on existing D1 databases", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const schema = fs.readFileSync("../../schema/d1.sql", "utf8");
  for (const index of ["idx_v2_order_created_at", "idx_v2_order_status", "idx_v2_commission_user", "idx_v2_ticket_status", "idx_v2_stat_server_server", "idx_v2_user_availability", "idx_v2_server_sort", "idx_v2_stat_user_record_user"]) {
    assert.match(source, new RegExp(index));
    assert.match(schema, new RegExp(index));
  }
});

test("migration export restores original SQLite value representations", () => {
  const source = fs.readFileSync("src/migration.ts", "utf8");
  assert.match(source, /name === "system_bootstrap_edge_version"/);
  assert.match(source, /replace\(\/\\\.0\+\$\/, ""\)/);
  assert.match(source, /row\.password_algo = null/);
  assert.match(source, /row\.online_count = null/);
});

test("plan traffic is converted from gigabytes to user bytes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /SELECT transfer_enable FROM v2_plan[\s\S]*?\* 1073741824/);
  assert.match(source, /Number\(plan\.transfer_enable \|\| 0\) \* 1073741824/);
  assert.match(source, /v2_plan\.transfer_enable = v2_user\.transfer_enable/);
});

test("Maileroo and Brevo settings persist through the official email field names", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /email_driver: \["maileroo", "brevo"\]/);
  assert.match(source, /email_password: firstNonEmpty\(all\.email_password\)/);
  assert.match(source, /email_from_address: firstNonEmpty\(all\.email_from_address, all\.resend_from_address\)/);
  assert.match(source, /邮件服务商只能是 Maileroo 或 Brevo/);
  assert.match(source, /email_from_address: "resend_from_address", resend_from_address: "email_from_address"/);
});

test("admin orders are persisted and exposed through the official route set", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  for (const route of ["fetch", "assign", "detail", "update", "cancel", "paid"]) {
    assert.match(source, new RegExp(`route === "/order/${route}"`));
  }
  assert.match(source, /INSERT INTO v2_order\(user_id,plan_id,period,trade_no,status,total_amount,type,commission_status,invite_user_id,commission_balance,created_at,updated_at\)/);
  assert.match(source, /balance_amount/);
  assert.match(source, /async function cancelOrder/);
  assert.match(source, /commission_first_time_enable/);
  assert.match(source, /period === "onetime" \|\| user\.expired_at == null \|\| Number\(order\.type\) === 1/);
  assert.match(source, /INSERT INTO v2_traffic_reset_logs/);
  assert.match(source, /next_reset_at/);
  assert.match(source, /SELECT o\.\*, p\.name AS plan_name FROM v2_order o LEFT JOIN v2_plan p/);
  assert.match(source, /const orderResponse = await adminOrder/);
  assert.match(source, /month_price: "monthly"/);
  assert.match(source, /legacyOrderPeriods\[value\]/);
  assert.doesNotMatch(source, /path\.match\(\/order\|coupon/);
  assert.match(source, /ALTER TABLE v2_order ADD COLUMN plan_id/);
  assert.match(source, /UPDATE v2_order SET status = 2 WHERE status IS NULL/);
  assert.match(source, /"\/plan\/save", "\/plan\/drop", "\/order\/paid"/);
  assert.match(source, /surplusOrderIds = parseJsonArray\(row\.surplus_order_ids\)/);
  assert.match(source, /SELECT \* FROM v2_commission_log WHERE trade_no = \?/);
});

test("admin user relations, CSV units and smoke tests cover functional paths", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const smoke = fs.readFileSync("../../scripts/smoke-test.ts", "utf8");
  assert.match(source, /SELECT id, email FROM v2_user WHERE id IN/);
  assert.match(source, /invite_user: inviters\.get/);
  assert.match(source, /function trafficConvert/);
  assert.match(source, /trafficConvert\(user\.transfer_enable\)/);
  assert.match(smoke, /admin shell/);
  assert.match(smoke, /guest config/);
  assert.match(smoke, /guest plans/);
  assert.match(smoke, /admin login/);
  assert.match(smoke, /admin config/);
  assert.match(smoke, /XBOARD_SUBSCRIBE_TOKEN/);
});

test("traffic history exposes the official server_rate field", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /server_rate: Number\(row\.server_rate \?\? 1\) \|\| 1/);
  assert.match(source, /SELECT \* FROM v2_stat_user WHERE user_id = \? ORDER BY record_at DESC/);
  assert.match(source, /GROUP BY user_id, server_rate, record_at ORDER BY record_at DESC/);
  assert.doesNotMatch(source, /MIN\(id\) AS id, user_id, server_rate/);
  assert.match(source, /ALTER TABLE v2_stat_user ADD COLUMN server_rate/);
  assert.match(source, /UPDATE v2_stat_user SET server_rate = COALESCE\(rate, 1\)/);
});

test("node metrics use StatusHub as the realtime source", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /const metrics = nodeState\.metrics \|\| \(loadStatus\?\.metrics/);
  assert.match(source, /async function statusHubRequest/);
  assert.doesNotMatch(source, /parseKvObject\(kvMetrics\) \|\| parseKvObject\(server\.metrics\)/);
});

test("node sync and error handling avoid unrelated work and SQL disclosure", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const giftCards = fs.readFileSync("src/gift-card.ts", "utf8");
  assert.match(source, /pathname\.endsWith\(suffix\)/);
  assert.doesNotMatch(source.slice(source.indexOf("function shouldNotifyNodeSync"), source.indexOf("async function runSqlIgnore")), /pathname\.includes\(part\)/);
  assert.match(source, /pendingCommission[\s\S]*SUM\(commission_balance\)/);
  assert.match(source, /保存服务器失败，请检查字段后重试/);
  assert.doesNotMatch(source, /保存服务器失败: \$\{fallbackError/);
  assert.match(giftCards, /gift card redeem failed/);
});

test("gift card APIs implement the official admin and user route set", () => {
  const source = fs.readFileSync("src/gift-card.ts", "utf8");
  const index = fs.readFileSync("src/index.ts", "utf8");
  for (const route of ["templates", "create-template", "update-template", "delete-template", "generate-codes", "codes", "toggle-code", "export-codes", "usages", "statistics", "types", "update-code", "delete-code"]) {
    assert.match(source, new RegExp(`gift-card/${route}`));
  }
  for (const route of ["check", "redeem", "history", "detail", "types"]) assert.match(source, new RegExp(`gift-card/${route}`));
  assert.match(index, /handleAdminGiftCard/);
  assert.match(index, /handleUserGiftCard/);
  assert.match(source, /max_use_per_user/);
  assert.match(source, /cooldown_hours/);
  assert.match(source, /invite_reward_rate/);
  assert.match(source, /reset_package/);
  assert.match(source, /plan_validity_days/);
  assert.match(source, /usage_count = usage_count \+ 1/);
  assert.match(source, /redemption_nonce/);
  assert.match(source, /await db\.batch\(statements\)/);
});

test("gift card traffic rewards use the byte values submitted by the official admin UI", () => {
  const source = fs.readFileSync("src/gift-card.ts", "utf8");
  assert.match(source, /updateValues\.push\(Number\(rewards\.transfer_enable\)\)/);
  assert.match(source, /Number\(inviteRewards\.transfer_enable \|\| 0\), ts/);
  assert.doesNotMatch(source, /rewards\.transfer_enable\) \* 1073741824/);
  assert.match(source, /rewards_given: parseJson\(row\.rewards_given, \{\}\)/);
});

test("gift card generation follows the upstream code and CSV formats", () => {
  const source = fs.readFileSync("src/gift-card.ts", "utf8");
  assert.match(source, /crypto\.getRandomValues\(new Uint8Array\(6\)\)/);
  assert.match(source, /toString\(16\).*toUpperCase\(\)/s);
  for (const heading of ["兑换码", "创建时间", "模板奖励", "使用时间", "备注"]) assert.match(source, new RegExp(heading));
  assert.match(source, /gift_cards_\$\{String\(input\.batch_id\)\}\.txt/);
});

test("fresh D1 schema follows upstream visibility and expiry defaults", () => {
  const schema = fs.readFileSync("../../schema/d1.sql", "utf8");
  assert.match(schema, /expired_at INTEGER DEFAULT 0/);
  assert.equal((schema.match(/show INTEGER NOT NULL DEFAULT 0/g) || []).length, 5);
  assert.doesNotMatch(schema, /show INTEGER NOT NULL DEFAULT 1/);
});

test("mail APIs support Maileroo and Brevo without SMTP fields", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const adminBundle = fs.readFileSync("public/assets/index-CF20260713.js", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /MAIL_EVENTS: Queue/);
  assert.match(source, /type: "mail"/);
  assert.match(source, /normalizeEmailProvider/);
  assert.match(source, /smtp\.maileroo\.com\/api\/v2\/emails/);
  assert.match(source, /api\.brevo\.com\/v3\/smtp\/email/);
  assert.doesNotMatch(source, /testSendMail"\) return fail\("未配置邮件队列发送服务"/);
  assert.match(wrangler, /binding = "MAIL_EVENTS"/);
  assert.match(wrangler, /queue = "mail-events"/);
  assert.match(source, /async function sendTestMail/);
  assert.match(source, /driver: provider/);
  assert.match(source, /return ok\(await sendTestMail/);
  assert.doesNotMatch(source, /queued: true, event_id/);
  assert.doesNotMatch(source, /email_encryption/);
  assert.doesNotMatch(adminBundle, /email_encryption/);
  assert.match(adminBundle, /name:"email_driver"/);
  assert.match(adminBundle, /value:"maileroo",children:"Maileroo"/);
  assert.match(adminBundle, /value:"brevo",children:"Brevo"/);
  assert.doesNotMatch(adminBundle, /name:"email_port"/);
});

test("Telegram webhook setup and join requests use the official Bot API", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /api\.telegram\.org\/bot\$\{botToken\}/);
  assert.match(source, /setWebhook/);
  assert.match(source, /setMyCommands/);
  assert.match(source, /approveChatJoinRequest/);
  assert.match(source, /declineChatJoinRequest/);
});

test("non-payment compatibility endpoints no longer return fake success", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function adminTicket/);
  assert.match(source, /async function adminCoupon/);
  assert.match(source, /async function themeApi/);
  assert.match(source, /async function pluginApi/);
  assert.doesNotMatch(source, /compatible placeholder/);
});

test("quick login, withdrawals and ECH generation are implemented", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /quick_login:\$\{verify\}/);
  assert.match(source, /Commission Withdrawal Request/);
  assert.match(source, /BEGIN \$\{label\}/);
  assert.match(source, /name: "X25519"/);
});

test("request bodies preserve repeated form keys and urlencoded payloads", () => {
  const source = fs.readFileSync("src/compat.ts", "utf8");
  assert.match(source, /application\/x-www-form-urlencoded/);
  assert.match(source, /Array\.isArray\(out\[key\]\)/);
  assert.match(source, /new URLSearchParams\(await request\.text\(\)\)/);
});

test("V1 app config merges supported nodes into the official Clash app profile", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /\/rules\/app\.clash\.yaml/);
  assert.match(source, /XBOARD_SUBSCRIPTION\.fetch/);
  assert.match(source, /xboard-subscription\.internal\/api\/v1\/client\/subscribe/);
  assert.match(source, /supportedCiphers/);
  assert.match(source, /proxy\?\.type === "vmess" \|\| proxy\?\.type === "trojan"/);
  assert.match(source, /base\["proxy-groups"\]/);
  assert.match(source, /return new Response\(stringifyYaml\(base\)/);
});

test("user deletion removes ticket messages in the same D1 batch", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /DELETE FROM v2_ticket_message WHERE ticket_id IN \(SELECT id FROM v2_ticket WHERE user_id = \?\)/);
  assert.doesNotMatch(source, /for \(const ticket of ticketIds\.results/);
});

test("admin user updates reject non-numeric numeric fields", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /const numericKeys = \["transfer_enable"/);
  assert.match(source, /Number\.isFinite\(Number\(value\)\)/);
});

test("all newly hashed user passwords satisfy the D1 password algorithm constraint", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.doesNotMatch(source, /password_algo\s*=\s*NULL/);
  assert.doesNotMatch(source, /password_algo, password_salt[\s\S]{0,300}VALUES \([^)]*NULL,NULL/);
  assert.match(source, /VALUES \(\?, \?, 'bcrypt', NULL,/);
  assert.match(source, /values\.password_algo = "bcrypt"/);
  assert.match(source, /SET password = \?, password_algo = 'bcrypt', password_salt = NULL/);
});

test("user knowledge, server availability and invite commission match upstream contracts", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function userIsAvailable/);
  assert.match(source, /Number\(user\.transfer_enable \|\| 0\) > 0/);
  assert.doesNotMatch(source, /user\.plan_id !== null/);
  assert.match(source, /language IS NULL/);
  assert.match(source, /SELECT \$\{selected\} FROM v2_knowledge/);
  assert.match(source, /phpUrlEncode\(subscription\)/);
  assert.match(source, /SUM\(get_amount\).*invite_user_id/);
  assert.match(source, /commission_distribution_l1/);
  assert.match(source, /AND get_amount > 0/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-1"/);
  assert.match(source, /Number\(coupon\.ended_at \|\| 0\) < ts/);
});

test("audited notice, ranking and migration edge cases match upstream", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const migration = fs.readFileSync("src/migration.ts", "utf8");
  assert.match(source, /SELECT \* FROM v2_notice WHERE show = 1 ORDER BY sort ASC, id DESC LIMIT \? OFFSET \?/);
  assert.match(source, /return json\(\{ data: result\.results \|\| \[\], total \}\)/);
  assert.match(source, /previousValue/);
  assert.match(source, /change: calculateChange\(value, previousValue\)/);
  assert.match(source, /monthStart\(\)\)\.all(?:<Record<string, any>>)?\(\)/);
  assert.match(migration, /row\.online_count == null/);
  assert.match(migration, /row\.last_login_ip = \[24, 16, 8, 0\]/);
  assert.match(migration, /table === "v2_traffic_reset_logs"/);
  assert.match(migration, /SELECT id, is_admin FROM v2_user WHERE id IN/);
  assert.match(migration, /adminUsers\.has\(Number\(row\.user_id/);
});

test("D1 keeps upstream lookup indexes used by tokens and gift cards", () => {
  const schema = fs.readFileSync("../../schema/d1.sql", "utf8");
  assert.match(schema, /idx_personal_access_tokens_tokenable ON personal_access_tokens\(tokenable_type, tokenable_id\)/);
  assert.match(schema, /idx_gift_template_created_at ON v2_gift_card_template\(created_at\)/);
  assert.match(schema, /idx_gift_code_user_id ON v2_gift_card_code\(user_id\)/);
  assert.match(schema, /idx_gift_usage_user_id ON v2_gift_card_usage\(user_id\)/);
  assert.match(schema, /idx_gift_usage_created_at ON v2_gift_card_usage\(created_at\)/);
});

test("audited admin and user mutations reject stale or partial operations", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /const filtered = scope === "filtered" \? adminUserQuery\(input\) : null/);
  assert.match(source, /const results = await env\.XBOARD_DB\.batch\(statements\)/);
  assert.match(source, /status NOT IN \(0,2\)/);
  assert.doesNotMatch(source, /coupon_id = .*status IN \(1,3\)/);
  assert.match(source, /return await cancelOrder\(env, order, now\(\)\) \? ok\(true\) : fail\("取消失败"/);
  assert.match(source, /callback_no: order\.trade_no/);
  assert.match(source, /\[0, 1, 2\]\.includes\(Number\(input\.level\)\)/);
  assert.match(source, /String\(input\.password\)\.length < 8/);
});

test("statistics and mail templates preserve the upstream contracts", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /route\.endsWith\("YesterdayRank"\) \? dayStart\(\) - 86400 : 0/);
  assert.match(source, /server_name: row\.server_name, server_id: Number\(row\.server_id\), server_type: row\.server_type/);
  assert.match(source, /type === "server_traffic_rank"/);
  assert.match(source, /type === "invite_rank"/);
  assert.match(source, /Number\(row\.paid_total \|\| 0\) \/ 100/);
  assert.match(source, /remindExpire:/);
  assert.match(source, /remindTraffic:/);
  assert.match(source, /missing = mailTemplateMeta\[name\]\.required_vars/);
});

test("RX compatibility fixes preserve upstream CRUD, plans, Telegram and filters", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const giftCards = fs.readFileSync("src/gift-card.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /const validServerTypes = new Set/);
  assert.match(source, /type === "shadowsocks"\) return requiredString\("cipher"/);
  assert.match(source, /online_count: Number\(row\.online_count \|\| 0\)/);
  assert.match(source, /INSERT INTO v2_knowledge\(title,category,body,language,show/);
  assert.match(source, /route === "\/server\/route\/drop"/);
  assert.match(source, /DELETE FROM v2_server_route WHERE id = \?/);
  assert.match(source, /boolNumber\(input\.show, 0\)/);
  assert.match(source, /async function publicPlanRows/);
  assert.match(source, /Number\(value\) \* 100/);
  assert.match(source, /async function handleTelegramMessage/);
  assert.match(source, /command === "\/getlatesturl"/);
  assert.match(source, /telegramRequest\(botToken, "getMe"\)/);
  assert.match(source, /async function queueTelegram/);
  assert.match(wrangler, /binding = "TELEGRAM_EVENTS"[\s\S]*queue = "telegram-events"/);
  assert.match(source, /l\.action = \?/);
  assert.match(source, /l\.uri LIKE \? OR l\.request_data LIKE \?/);
  assert.match(source, /l\.reset_type = \?/);
  assert.match(source, /u\.email LIKE \?/);
  assert.match(source, /const response = await \(async \(\) =>/);
  assert.match(source, /await audit\(env,[\s\S]*return response/);
  assert.match(giftCards, /UPDATE v2_gift_card_code SET status = 1/);
});

test("API responses use the same open CORS policy as upstream Laravel", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /request\.method === "OPTIONS"/);
  assert.match(source, /access-control-allow-origin", "\*"/);
  assert.match(source, /access-control-allow-methods", "\*"/);
  assert.match(source, /access-control-allow-headers", "\*"/);
});

test("V2 client app config exposes the complete upstream structure", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const start = source.indexOf('path === "/api/v2/client/app/getConfig"');
  const section = source.slice(start, source.indexOf('return json({ message: "Not Found"', start));
  for (const key of ["app_info", "features", "ui_config", "business_rules", "server_config", "security_config", "payment_config", "notification_config", "cache_config", "last_updated", "config_hash"]) {
    assert.match(section, new RegExp(key));
  }
  assert.match(section, /md5\(JSON\.stringify\(config\)\)/);
});

test("admin ticket, coupon and audit handlers preserve upstream behavior", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /UPDATE v2_ticket SET reply_status = 1/);
  assert.match(source, /ticket_sendEmailNotify_/);
  assert.match(source, /expirationTtl: 1800/);
  assert.match(source, /parseJsonArray\(input\.reply_status\)/);
  assert.match(source, /const ticketFields:/);
  assert.match(source, /const couponFields = new Set/);
  assert.match(source, /return json\(paginated\(\(result\.results \|\| \[\]\)\.map/);
  assert.match(source, /route === "\/server\/group\/save"/);
  assert.match(source, /if \(!name\) return fail\("组名不能为空"/);
  assert.match(source, /INSERT INTO v2_admin_audit_log\(admin_id, action, target, metadata, ip, method, uri, request_data/);
  assert.match(source, /replaceAll\("-", "_"\)/);
  assert.match(source, /const sensitive = \/\(\^\|_\)\(password\|token\|secret\|key\|api_key\)\$\/i/);
  assert.match(source, /const userMap = new Map\(userEntries\)/);
});

test("bootstrap defaults never overwrite customized mail templates", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /ON CONFLICT\(name\) DO UPDATE SET subject = excluded\.subject, content = excluded\.content[\s\S]*WHERE v2_mail_templates\.content IS NULL OR v2_mail_templates\.content = ''/);
});

test("GLM compatibility audit fixes preserve upstream mutations and envelopes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const schema = fs.readFileSync("../../schema/d1.sql", "utf8");
  assert.match(source, /id \? String\(existing\?\.code \|\| ""\) : randomString\(8\)/);
  assert.doesNotMatch(source, /new Response\(`\\uFEFF\$\{lines/);
  assert.match(source, /trigger_source: row\.trigger_source/);
  assert.match(source, /next_reset_at = \?, updated_at = \? WHERE id = \?/);
  assert.match(source, /trigger_source = 'cron'/);
  assert.match(source, /queueTemplateMail\(env, "notify"/);
  assert.match(source, /rawPrice !== null[\s\S]*Number\(rawPrice\) >= 0/);
  assert.match(source, /url\.searchParams\.get\("current"\)/);
  assert.match(source, /const nextResetAt = plan \? edgeNextResetAt/);
  assert.match(source, /const hasPlan = \(user as any\)\.plan_id !== null/);
  assert.match(source, /user && limitEnabled/);
  assert.match(source, /timestamp: new Date\(\)\.toISOString\(\), data: await trafficRank/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS v2_stat_server[\s\S]*record_type TEXT NOT NULL DEFAULT 'd'/);
});
