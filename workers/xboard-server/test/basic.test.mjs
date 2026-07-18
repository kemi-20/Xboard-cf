import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import serverWorker from "../src/index.ts";
import { OFFICIAL_HTTP_ROUTES, OFFICIAL_WS_EVENTS } from "../src/contracts.ts";
import { appendMachineHistory, normalizeOnlineCounts, REGISTERED_HTTP_ROUTES, StatusHub } from "../src/index.ts";
import { invalidateSettingsCache, settings } from "../src/db.ts";

test("xboard-server has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("server reuses expensive constants and keeps dead helpers removed", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const protocol = fs.readFileSync("src/protocol.ts", "utf8");
  const compat = fs.readFileSync("src/compat.ts", "utf8");
  const database = fs.readFileSync("src/db.ts", "utf8");
  const internalAuth = fs.readFileSync("src/internal-auth.ts", "utf8");
  assert.match(source, /const RATE_TIME_FORMATTER = new Intl\.DateTimeFormat/);
  assert.match(source, /RATE_TIME_FORMATTER\.formatToParts/);
  assert.match(protocol, /const PROTOCOL_MD5_CONSTANTS = Array\.from/);
  assert.equal(compat.trim(), "export const now = () => Math.floor(Date.now() / 1000);");
  assert.doesNotMatch(database, /export async function list/);
  assert.doesNotMatch(internalAuth, /export async function internalToken/);
});

test("internal endpoints accept the D1 fallback during a partial Secret rollout", async () => {
  const db = {
    withSession() { return this; },
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: [
          { name: "server_token", value: "public-node-token" },
          { name: "internal_sync_token", value: "database-internal-token" }
        ] }; }
      };
    }
  };
  const response = await serverWorker.fetch(new Request("https://server.internal/internal/settings/invalidate", {
    method: "POST",
    headers: {
      "x-xboard-internal-token": "new-worker-secret",
      "x-xboard-internal-token-fallback": "database-internal-token"
    }
  }), { XBOARD_DB: db, INTERNAL_SYNC_TOKEN: "old-worker-secret" });
  assert.equal(response.status, 200);
});

test("device state tolerates three five-minute reporting intervals without KV heartbeats", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /status-hub\.internal\/devices\/report/);
  assert.match(source, /const ONLINE_RETENTION_SECONDS = 900/);
  assert.match(source, /Number\(seenAt\) >= timestamp - ONLINE_RETENTION_SECONDS/);
  assert.doesNotMatch(source, /`node:devices:\$\{nodeId\}`/);
  assert.doesNotMatch(source, /`user:devices:\$\{userId\}`/);
});

test("node polling defaults to five minutes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /setting\(env, "server_push_interval", "300"\)/);
  assert.match(source, /setting\(env, "server_pull_interval", "300"\)/);
  assert.doesNotMatch(source, /setting\(env, "server_(?:push|pull)_interval", "60"\)/);
});

test("Tidalab submit paths skip user reads and preserve payload-based ETags", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const tidalab = source.slice(source.indexOf("async function handleTidalab"), source.indexOf("async function machineNodes"));
  assert.doesNotMatch(tidalab.split('if (family === "ShadowsocksTidalab")')[0], /nodeUsers/);
  assert.match(tidalab, /etagResponse\(request, \{ data \}, data\)/);
  assert.match(tidalab, /etagResponse\(request, \{ msg: "ok", data \}, data\)/);
  assert.match(tidalab, /if \(action === "submit"\) return submit\(\)/);
});

test("node configuration and user snapshots use Cache API after authentication", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const cache = fs.readFileSync("src/cache.ts", "utf8");
  assert.match(source, /node-config:\$\{node\.id\}/);
  assert.match(source, /node-users:\$\{node\.id\}/);
  assert.match(cache, /await cache\.match\(request\)/);
  assert.match(cache, /const pending = new Map/);
});

test("independent node and machine fanout is concurrent but capped", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function mapConcurrent/);
  assert.match(source, /mapConcurrent\(nodes, 8/);
  assert.match(source, /mapConcurrent\(machines\.results \|\| \[\], 8/);
  assert.match(source, /const \[config, users\] = await Promise\.all/);
  assert.match(source, /await pushNodeEvent\(env, node, "sync\.config"[\s\S]*await pushNodeEvent\(env, node, "sync\.users"/);
});

test("websocket settings accept both SQLite booleans and numeric flags", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function booleanSetting\(value: unknown, fallback = false\)/);
  assert.match(source, /String\(value\)\.toLowerCase\(\) === "true"/);
  assert.match(source, /booleanSetting\(await setting\(env, "server_ws_enable", "1"\), true\)/);
  assert.doesNotMatch(source, /Number\(await setting\(env, "server_ws_enable", "1"\)\)/);
});

test("official server routes use exact method and path matching", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.doesNotMatch(source, /pathname\.includes\(/);
  assert.deepEqual([...REGISTERED_HTTP_ROUTES].sort(), [...OFFICIAL_HTTP_ROUTES].sort());
  assert.match(source, /routes\.set\(`\$\{method\} \/api\/v1\/server\/UniProxy\/\$\{action\}`/);
  assert.match(source, /routes\.set\("POST \/api\/v2\/server\/report"/);
  assert.match(source, /routes\.set\("POST \/api\/v2\/server\/machine\/nodes"/);
  assert.match(source, /routes\.set\("POST \/api\/v2\/server\/machine\/status"/);
});

test("websocket protocol includes the official event vocabulary", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  for (const event of OFFICIAL_WS_EVENTS) {
    assert.ok(source.includes(event), `missing ${event}`);
  }
});

test("node status accepts official flat metrics and nested status payloads", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /const status = data\.status \?\? \(data\.mem && data\.disk \? data : null\)/);
  assert.match(source, /const metrics = data\.metrics \?\? data/);
  assert.match(source, /const load = statusState\(status\)/);
  assert.match(source, /const metricValues = metricsState\(metrics\)/);
  assert.match(source, /await reportStatus\(env, "node", Number\(node\.id\), runtime\)/);
});

test("node and machine runtime status persist in the global StatusHub", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /export class StatusHub/);
  assert.match(source, /const STATUS_HUB_ID = "global"/);
  assert.match(source, /env\.STATUS_HUB\.idFromName\(STATUS_HUB_ID\)/);
  assert.match(source, /updatedAt - Number\(this\.persistedStatusAt\.get\(key\) \|\| 0\) >= 60/);
  assert.match(source, /updatedAt - lastRecordedAt >= 300/);
  assert.match(source, /await this\.state\.storage\.put\(`history:\$\{id\}`, nextHistory\)/);
  assert.match(source, /last_seen_at: recordedAt, connected: true, load_status: load/);
  assert.match(source, /timestamp - Number\(identity\.last_status_at \|\| 0\) >= 240/);
  assert.match(source, /last_seen_at: timestamp, connected: true/);
  assert.doesNotMatch(source, /RUNTIME_ANALYTICS/);
  assert.doesNotMatch(wrangler, /analytics_engine_datasets/);
  assert.match(wrangler, /name = "STATUS_HUB"/);
  assert.match(wrangler, /class_name = "StatusHub"/);
  assert.match(wrangler, /tag = "v2"[\s\S]*new_sqlite_classes = \["StatusHub"\]/);
  assert.doesNotMatch(source, /UPDATE v2_server SET metrics = \?, last_push_at = \?, updated_at = \?/);
  assert.doesNotMatch(source, /INSERT INTO v2_server_machine_load_history/);
});

test("internal runtime status responses cannot be frozen by Runtime Cache", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function noStoreResponse\(response: Response\)/);
  assert.match(source, /headers\.set\("cache-control", "no-store, no-cache, must-revalidate"\)/);
  assert.match(source, /url\.pathname === "\/snapshot" && \(request\.method === "GET" \|\| request\.method === "POST"\)/);
  assert.match(source, /url\.pathname === "\/history" && \(request\.method === "GET" \|\| request\.method === "POST"\)/);
  assert.match(source, /return noStoreResponse\(await statusHub\(env\)\.fetch/);
});

test("machine load history remains bounded to the latest 24 hours", () => {
  const recent = 2_000_000_000;
  const first = { cpu: 10, recorded_at: recent - 299 };
  const second = { cpu: 20, recorded_at: recent };
  assert.deepEqual(appendMachineHistory([first], second, recent), [first, second]);

  const oversized = Array.from({ length: 1440 }, (_, index) => ({ cpu: index, recorded_at: recent - 1439 + index }));
  const trimmed = appendMachineHistory(oversized, { cpu: 999, recorded_at: recent + 1 }, recent + 1);
  assert.equal(trimmed.length, 1440);
  assert.equal(trimmed[0].cpu, 1);
  assert.equal(trimmed.at(-1).cpu, 999);

  const stale = { cpu: 1, recorded_at: recent - 86401 };
  assert.deepEqual(appendMachineHistory([stale], second, recent), [second]);
});

function statusHubStorage() {
  const rows = new Map();
  const writes = [];
  return {
    rows,
    writes,
    async get(key) { return rows.get(key); },
    async put(key, value) {
      if (typeof key === "string") { rows.set(key, value); writes.push(key); }
      else for (const [entryKey, entryValue] of Object.entries(key)) { rows.set(entryKey, entryValue); writes.push(entryKey); }
    },
    async delete(key) { return rows.delete(key); },
    async list(options = {}) { return new Map([...rows].filter(([key]) => !options.prefix || key.startsWith(options.prefix))); },
    async setAlarm() {}
  };
}

test("StatusHub coalesces heartbeat storage and persists five-minute load history", async () => {
  const storage = statusHubStorage();
  const hub = new StatusHub({ storage }, {});
  const originalNow = Date.now;
  let clock = 2_000_000_000_000;
  Date.now = () => clock;
  try {
    const report = state => hub.fetch(new Request("https://status-hub.internal/report", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "node", id: 1, state })
    }));
    await report({ last_check_at: 1 });
    await report({ last_check_at: 2 });
    assert.equal(storage.writes.filter(key => key === "node:1").length, 1);
    await report({ connected: false });
    assert.equal(storage.writes.filter(key => key === "node:1").length, 2);

    const deviceReport = (timestamp, devices, replaceNode = false) => hub.fetch(new Request("https://status-hub.internal/devices/report", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node_id: 1, timestamp, devices, replace_node: replaceNode })
    }));
    await deviceReport(1000, { 7: { "1.1.1.1": 1000, "2.2.2.2": 1000 } });
    await deviceReport(1060, { 7: { "1.1.1.1": 1060 } });
    assert.equal(storage.writes.filter(key => key === "devices:1").length, 2);
    let listed = await hub.fetch(new Request("https://status-hub.internal/devices/list", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_ids: [7], timestamp: 1060 })
    }));
    assert.deepEqual((await listed.json()).data.users, { 7: ["1.1.1.1"] });
    await deviceReport(1100, { 8: { "3.3.3.3": 1100 } });
    assert.equal(storage.writes.filter(key => key === "devices:1").length, 3);
    listed = await hub.fetch(new Request("https://status-hub.internal/devices/list", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_ids: [7, 8], timestamp: 1100 })
    }));
    assert.deepEqual((await listed.json()).data.users, { 7: ["1.1.1.1"], 8: ["3.3.3.3"] });
    await deviceReport(1110, { 7: { "1.1.1.1": 1110 } }, true);
    listed = await hub.fetch(new Request("https://status-hub.internal/devices/list", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_ids: [7, 8], timestamp: 1110 })
    }));
    assert.deepEqual((await listed.json()).data.users, { 7: ["1.1.1.1"] });
    await deviceReport(1120, { 7: {} });
    listed = await hub.fetch(new Request("https://status-hub.internal/devices/list", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_ids: [7, 8], timestamp: 1120 })
    }));
    assert.deepEqual((await listed.json()).data.users, {});

    const machineReport = () => hub.fetch(new Request("https://status-hub.internal/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "machine", id: 3, history: true, state: { load_status: { cpu: 10, mem: {}, disk: {} } } })
    }));
    await machineReport();
    clock += 60_000;
    await machineReport();
    assert.equal(storage.writes.filter(key => key === "history:3").length, 1);
    clock += 241_000;
    await machineReport();
    assert.equal(storage.writes.filter(key => key === "history:3").length, 2);
    assert.equal(storage.rows.get("history:3").length, 2);

    const acquire = claim => hub.fetch(new Request("https://status-hub.internal/locks/acquire", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "scheduled", claim, timestamp: 3000, ttl: 1800 })
    }));
    assert.equal((await (await acquire("owner-1")).json()).data.acquired, true);
    assert.equal((await (await acquire("owner-2")).json()).data.acquired, false);
    await hub.fetch(new Request("https://status-hub.internal/locks/release", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "scheduled", claim: "owner-1" })
    }));
    assert.equal((await (await acquire("owner-2")).json()).data.acquired, true);
  } finally {
    Date.now = originalNow;
  }
});

test("settings use a coalesced memory and KV snapshot cache", () => {
  const source = fs.readFileSync("src/db.ts", "utf8");
  assert.match(source, /const SETTINGS_CACHE_TTL_MS = 300_000/);
  assert.match(source, /const SETTINGS_VERSION_CHECK_MS = 30_000/);
  assert.match(source, /settings:snapshot:/);
  assert.match(source, /availableKv\.get\("settings_version"\)/);
  assert.match(source, /availableKv = undefined/);
  assert.match(source, /let settingsPromise: Promise<Record<string, string>> \| null = null/);
  assert.match(source, /SELECT name, value FROM v2_settings/);
  assert.doesNotMatch(source, /SELECT value FROM v2_settings WHERE name = \?/);
});

test("a versioned KV settings snapshot avoids a D1 read", async () => {
  invalidateSettingsCache();
  const db = new Proxy({}, {
    get() { throw new Error("D1 must not be accessed on a KV snapshot hit"); }
  });
  const kv = {
    async get(key) {
      if (key === "settings_version") return "test-version";
      if (key === "settings:snapshot:server:test-version") return JSON.stringify({ server_token: "cached-token" });
      return null;
    },
    async put() { throw new Error("KV must not be written on a snapshot hit"); },
    async delete() {}
  };
  assert.equal((await settings(db, kv)).server_token, "cached-token");
  invalidateSettingsCache();
});

test("a KV outage falls straight through to D1 without a second KV attempt", async () => {
  invalidateSettingsCache();
  let kvReads = 0;
  let kvWrites = 0;
  let d1Reads = 0;
  const kv = {
    async get() { kvReads += 1; throw new Error("KV unavailable"); },
    async put() { kvWrites += 1; },
    async delete() {}
  };
  const statement = {
    bind() { return statement; },
    async all() {
      d1Reads += 1;
      return { success: true, results: [{ name: "server_token", value: "d1-token" }] };
    }
  };
  const db = { prepare() { return statement; } };
  assert.equal((await settings(db, kv)).server_token, "d1-token");
  assert.equal(kvReads, 1);
  assert.equal(kvWrites, 0);
  assert.equal(d1Reads, 1);
  invalidateSettingsCache();
});

test("large traffic reports are split before entering the queue", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /const billable = billableTraffic\(payload\)/);
  assert.match(source, /offset \+= 250/);
  assert.match(source, /billable\.slice\(offset, offset \+ 250\)/);
  assert.match(source, /else if \(events\.length > 1\)/);
  assert.match(source, /TRAFFIC_EVENTS\.sendBatch\(events\)/);
});

test("admin changes and migrations can invalidate the server settings cache immediately", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const db = fs.readFileSync("src/db.ts", "utf8");
  const auth = fs.readFileSync("src/internal-auth.ts", "utf8");
  assert.match(db, /export function invalidateSettingsCache\(\)/);
  assert.match(source, /url\.pathname === "\/internal\/settings\/invalidate"/);
  assert.match(auth, /SELECT name, value FROM v2_settings WHERE name IN \('internal_sync_token', 'server_token'\)/);
  assert.match(auth, /token === values\.server_token/);
  assert.match(source, /invalidateSettingsCache\(\)/);
});

test("websocket device state follows the official per-IP contract", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /next\[userId\] = Object\.fromEntries/);
  assert.match(source, /deviceSnapshot\(Number\(input\.timestamp \|\| now\(\)\)/);
  assert.match(source, /await clearNodeDevices\(env, Number\(node\.id\)\)/);
  assert.match(source, /async function pushNodeEvent/);
  assert.match(source, /pushDo\(env, `machine:\$\{machineId\}`/);
  assert.match(source, /pushDo\(env, `node:\$\{nodeId\}`/);
  assert.match(source, /UPDATE v2_user SET online_count = \?/);
  assert.doesNotMatch(source, /event === "pong"[\s\S]{0,400}optionalKvPut/);
  assert.match(source, /internalRequestAuthorized/);
  assert.match(source, /event === "report\.devices"[\s\S]*socket\.send\(wsMessage\("sync\.devices"/);
  assert.match(source, /processAlive\(env, nodeId, data\.devices \?\? data, true\)/);
  assert.match(source, /action === "alivelist"[\s\S]{0,160}aggregateDeviceCounts\(env, await nodeUsers\(env, node\), true\)/);
  assert.match(source, /Number\(seenAt \|\| 0\) > timestamp - ONLINE_RETENTION_SECONDS/);
  assert.match(source, /aggregateDevices\(env, users, limitedOnly\)/);
  assert.match(source, /enqueueTraffic\(env, node, traffic\)/);
  assert.match(source, /const nonEmptyArrayLike =/);
  assert.match(source, /catch \{ return false; \}/);
  assert.match(source, /catch \{ return \{\}; \}/);
  assert.match(source, /offset < ids\.length; offset \+= 100/);
  assert.doesNotMatch(source, /this\.env\.XBOARD_KV\.put\(`node:ws:/);
  assert.doesNotMatch(source, /node:ws:(?:target|alive)/);
});

test("HTTP reports retain per-user online connections and clear empty snapshots", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /input\.online && typeof input\.online === "object"/);
  assert.match(source, /runtime\.connections = onlineCounts/);
  assert.match(source, /await refreshOnlineUsers\(env, onlineCounts, reportedAt\)/);
  assert.match(source, /COALESCE\(last_online_at, 0\) < \?/);
  assert.match(source, /\.bind\(count, count, timestamp, Number\(userId\), count, timestamp - 240\)/);
  assert.doesNotMatch(source, /timestamp - 480/);
  assert.match(source, /connections = Object\.fromEntries\(payload\.map\(item => \[String\(item\.user_id\), 1\]\)\)/);
  assert.match(source, /else if \(traffic\.count > 0\)[\s\S]{0,180}runtime\.connections = traffic\.connections/);
  assert.doesNotMatch(source, /refreshOnlineUsers\(env, traffic\.connections/);
  assert.deepEqual(normalizeOnlineCounts({ "1": 2, "2": "3", "3": 0, bad: 4, "-1": 5 }), { "1": 2, "2": 3 });
});

test("HTTP and websocket database work use request-scoped first-primary sessions", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const db = fs.readFileSync("src/db.ts", "utf8");
  assert.match(db, /db\.withSession\("first-primary"\)/);
  assert.match(source, /async fetch\(request: Request, env: Env,[\s\S]*XBOARD_DB: primaryDatabase\(env\.XBOARD_DB\)/);
  assert.match(source, /async webSocketMessage[\s\S]*XBOARD_DB: primaryDatabase\(this\.env\.XBOARD_DB\)/);
  assert.match(source, /async webSocketClose[\s\S]*XBOARD_DB: primaryDatabase\(this\.env\.XBOARD_DB\)/);
  assert.doesNotMatch(source, /withSession\("first-unconstrained"\)/);
});

test("traffic-exceeded user removals are batched per node", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function syncUsersChange/);
  assert.match(source, /input\.scope === "users"/);
  assert.match(source, /action: "remove", users: affected/);
});

test("machine V2 authentication rejects node zero before node lookup", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /!handshake && \(!Number\.isInteger\(Number\(input\.node_id\)\) \|\| Number\(input\.node_id\) < 1\)/);
  assert.match(source, /validationFailure\("node_id", "The node id must be at least 1\."\)/);
});

test("node and machine polling reuse a short bounded authentication cache", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const cache = fs.readFileSync("src/auth-cache.ts", "utf8");
  assert.match(cache, /AUTH_CACHE_TTL_MS = 20_000/);
  assert.match(cache, /AUTH_CACHE_MAX_ENTRIES = 512/);
  assert.match(cache, /const authLoads = new Map/);
  assert.match(cache, /if \(value !== null\)/);
  assert.match(source, /cachedAuthRow\(`node:/);
  assert.match(source, /cachedAuthRow\(`machine:/);
  assert.match(source, /cachedAuthRow\(`machine-node:/);
  assert.match(source, /url\.pathname === "\/internal\/sync"[\s\S]{0,220}invalidateAuthCache\(\)/);
  assert.match(source, /invalidateInternalTokenCache\(\);\s*invalidateAuthCache\(\)/);
});

test("authentication cache coalesces hits, skips misses and supports immediate invalidation", async () => {
  const { cachedAuthRow, invalidateAuthCache } = await import(`../src/auth-cache.ts?test=${Date.now()}`);
  let loads = 0;
  const loader = async () => { loads += 1; return { id: 7 }; };
  assert.deepEqual(await cachedAuthRow("node:7", loader), { id: 7 });
  assert.deepEqual(await cachedAuthRow("node:7", loader), { id: 7 });
  assert.equal(loads, 1);
  invalidateAuthCache();
  await cachedAuthRow("node:7", loader);
  assert.equal(loads, 2);
  await cachedAuthRow("missing", async () => { loads += 1; return null; });
  await cachedAuthRow("missing", async () => { loads += 1; return null; });
  assert.equal(loads, 4);
});

test("V2 handshake checks the websocket runtime and Tidalab forces its node type", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function websocketRuntimeAvailable/);
  assert.match(source, /env\.NODE_HUB\.idFromName\("health"\)/);
  assert.match(source, /!enabled \|\| !await websocketRuntimeAvailable\(env\)/);
  assert.match(source, /authenticateV1\(env, input, type\)/);
  assert.doesNotMatch(source, /family === "ShadowsocksTidalab" \? undefined : type/);
});

test("invalid node rates follow the upstream numeric cast instead of charging at rate one", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /Number\.isFinite\(parsedFallback\) \? parsedFallback : 0/);
  assert.doesNotMatch(source, /Number\.isFinite\(parsedFallback\) \? parsedFallback : 1/);
});

test("node synchronization targets live users and preserves child node keys", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const protocol = fs.readFileSync("src/protocol.ts", "utf8");
  assert.match(source, /async function pushNodeEvent/);
  assert.doesNotMatch(source, /status-hub\.internal\/presence/);
  assert.match(source, /!Number\(user\.plan_id\)/);
  assert.match(protocol, /shadowsocksServerKey\(node\.created_at, keyLength\)/);
  assert.match(protocol, /function nullableNested/);
});
