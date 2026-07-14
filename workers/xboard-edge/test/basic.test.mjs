import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("xboard-edge has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
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
  assert.match(source, /const setMenuLabel = node => Array\.from\(node\.childNodes\)/);
  assert.match(source, /if \(link && link\.textContent\.trim\(\) !== label\.text\) setMenuLabel\(link\)/);
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
  assert.match(source, /status = 'failed' AND COALESCE\(updated_at, created_at\) >= \?/);
  assert.match(source, /current - 10080 \* 60/);
  assert.match(source, /WHERE created_at >= \?/);
  assert.match(source, /current - 60 \* 60/);
  assert.doesNotMatch(source, /SELECT status, COUNT\(\*\) AS count FROM v2_job_logs GROUP BY status/);
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
  assert.match(source, /name IN \('subscribe_url', 'subscribe_path'\)/);
  assert.match(source, /values\.subscribe_url/);
  assert.match(source, /values\.subscribe_path/);
  assert.match(source, /await subscribeUrl\(request, env,/);
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
  assert.match(source, /readState\("last_check"\)/);
  assert.match(source, /readState\("last_push"\)/);
  assert.match(source, /available_status: availableStatus/);
  assert.match(source, /load_status: loadStatus/);
  assert.match(source, /online_conn: Number\(metrics\?\.active_connections \|\| 0\)/);
  assert.match(source, /machines\.find\(item => Number\(item\.id\) === Number\(server\.machine_id\)\)/);
  assert.match(source, /machineOnline \? machineSeenAt : 0/);
  assert.match(source, /machine:load:\$\{machine\.id\}/);
  assert.match(source, /parseKvObject\(kvMachineLoad\)/);
});

test("machine load history matches the upstream chart contract", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function adminMachineHistory\(env: Env, url: URL\)/);
  assert.match(source, /limit < 10 \|\| limit > 1440/);
  assert.match(source, /rangeHours < 1 \|\| rangeHours > 24/);
  assert.match(source, /FROM v2_server_machine_load_history WHERE machine_id = \?/);
  assert.match(source, /ORDER BY recorded_at DESC LIMIT \?/);
  assert.match(source, /\(result\.results \|\| \[\]\)\.reverse\(\)\.map/);
  assert.match(source, /net_in_speed: row\.net_in_speed === null/);
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
  assert.match(source, /await optionalKvPut\(env, "bootstrap:edge:v18"/);
  assert.doesNotMatch(source, /await env\.XBOARD_KV\.put\("bootstrap:edge:v12"/);
});

test("overwrite migrations suppress first-run seed data", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /mode = 'overwrite' AND status != 'rolled_back'/);
  assert.match(source, /if \(!preserveMigratedData\) \{[\s\S]*SELECT COUNT\(\*\) AS c FROM v2_user/);
  assert.match(source, /DELETE FROM v2_user WHERE email = 'admin@admin\.com' AND uuid = '00000000-0000-4000-8000-000000000001'/);
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

test("revenue overview reads the migrated daily statistics table", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const stats = source.slice(source.indexOf("async function orderStats"), source.indexOf("async function trafficRank"));
  assert.match(stats, /FROM v2_stat WHERE/);
  assert.match(stats, /record_type = 'd'/);
  assert.match(stats, /paid_total,paid_count,commission_total,commission_count/);
  assert.doesNotMatch(stats, /FROM v2_order/);
  assert.match(stats, /avg_commission_amount/);
});

test("English and Russian email settings describe Resend instead of SMTP", () => {
  const english = fs.readFileSync("public/locales/en-US.js", "utf8");
  const russian = fs.readFileSync("public/locales/ru-RU.js", "utf8");
  assert.match(english, /Resend API URL/);
  assert.match(english, /Resend API Key/);
  assert.doesNotMatch(english.slice(english.indexOf('"email": {'), english.indexOf('"telegram": {')), /SMTP/);
  assert.match(russian, /URL API Resend/);
  assert.match(russian, /API-ключ Resend/);
  assert.doesNotMatch(russian.slice(russian.indexOf('"email": {'), russian.indexOf('"telegram": {')), /SMTP/);
});

test("admin migration imports official SQLite data in bounded D1 batches", () => {
  const source = fs.readFileSync("src/migration.ts", "utf8");
  const index = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /sourceRows\.length > 100/);
  assert.match(source, /INSERT OR REPLACE/);
  assert.match(source, /INSERT OR IGNORE/);
  assert.match(source, /transfer_used_total/);
  assert.match(source, /\["v2_stat", "v2_stat_user", "v2_stat_server"\][\s\S]*?row\.record_type = "d"/);
  assert.match(source, /v2_server_machine/);
  assert.match(source, /password_algo = "bcrypt"/);
  assert.match(source, /x-migration-token/);
  assert.match(source, /access_token_hash = NULL/);
  assert.match(index, /handleAdminMigration/);
  assert.match(index, /\/migration\/status/);
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
  assert.match(app, /手动配置 Resend API Key/);
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

test("Resend settings persist through the official email field names", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /email_password: firstNonEmpty\(all\.email_password, all\.resend_api_key\)/);
  assert.match(source, /email_from_address: firstNonEmpty\(all\.email_from_address, all\.resend_from_address\)/);
  assert.match(source, /email_password: "resend_api_key", resend_api_key: "email_password"/);
  assert.match(source, /email_from_address: "resend_from_address", resend_from_address: "email_from_address"/);
});

test("admin orders are persisted and exposed through the official route set", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  for (const route of ["fetch", "assign", "detail", "update", "cancel", "paid"]) {
    assert.match(source, new RegExp(`route === "/order/${route}"`));
  }
  assert.match(source, /INSERT INTO v2_order\(user_id,plan_id,period,trade_no,status,total_amount,type,commission_status,invite_user_id,created_at,updated_at\)/);
  assert.match(source, /SELECT o\.\*, p\.name AS plan_name FROM v2_order o LEFT JOIN v2_plan p/);
  assert.match(source, /const orderResponse = await adminOrder/);
  assert.match(source, /month_price: "monthly"/);
  assert.match(source, /legacyOrderPeriods\[value\]/);
  assert.doesNotMatch(source, /path\.match\(\/order\|coupon/);
  assert.match(source, /ALTER TABLE v2_order ADD COLUMN plan_id/);
  assert.match(source, /UPDATE v2_order SET status = 2 WHERE status IS NULL/);
});

test("traffic history exposes the official server_rate field", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /server_rate: Number\(row\.server_rate \?\? row\.rate \?\? 1\) \|\| 1/);
  assert.match(source, /ALTER TABLE v2_stat_user ADD COLUMN server_rate/);
  assert.match(source, /UPDATE v2_stat_user SET server_rate = COALESCE\(rate, 1\)/);
});

test("node metrics fall back to D1 when KV writes are unavailable", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /parseKvObject\(kvMetrics\) \|\| parseKvObject\(server\.metrics\)/);
  assert.match(source, /ALTER TABLE v2_server ADD COLUMN metrics TEXT/);
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

test("mail APIs enqueue Resend jobs instead of returning SMTP placeholders", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const adminBundle = fs.readFileSync("public/assets/index-CF20260713.js", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /MAIL_EVENTS: Queue/);
  assert.match(source, /type: "mail"/);
  assert.match(source, /resend_api_key/);
  assert.doesNotMatch(source, /testSendMail"\) return fail\("未配置邮件队列发送服务"/);
  assert.match(wrangler, /binding = "MAIL_EVENTS"/);
  assert.match(wrangler, /queue = "mail-events"/);
  assert.match(source, /async function sendTestMail/);
  assert.match(source, /driver: "resend"/);
  assert.match(source, /return ok\(await sendTestMail/);
  assert.doesNotMatch(source, /queued: true, event_id/);
  assert.doesNotMatch(source, /email_encryption/);
  assert.doesNotMatch(adminBundle, /email_encryption/);
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

test("user knowledge, server availability and invite commission match upstream contracts", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function userIsAvailable/);
  assert.match(source, /transfer_enable \|\| 0\) - Number\(user\.u \|\| 0\) - Number\(user\.d \|\| 0\) > 0/);
  assert.match(source, /language IS NULL/);
  assert.match(source, /SELECT \$\{selected\} FROM v2_knowledge/);
  assert.match(source, /phpUrlEncode\(subscription\)/);
  assert.match(source, /SUM\(COALESCE\(get_amount, amount, 0\)\).*invite_user_id/);
  assert.match(source, /commission_distribution_l1/);
  assert.match(source, /COALESCE\(get_amount, amount, 0\) > 0/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-1"/);
  assert.match(source, /coupon\.ended_at !== null/);
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
  assert.match(source, /route === "\/server\/group\/save"/);
  assert.match(source, /if \(!name\) return fail\("组名不能为空"/);
  assert.match(source, /INSERT INTO v2_admin_audit_log\(admin_id, action, target, metadata, ip, method, uri, request_data/);
  assert.match(source, /replaceAll\("-", "_"\)/);
  assert.match(source, /const sensitive = \/\(\^\|_\)\(password\|token\|secret\|key\|api_key\)\$\/i/);
  assert.match(source, /const userMap = new Map\(userEntries\)/);
});
