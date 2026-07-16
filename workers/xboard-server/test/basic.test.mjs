import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OFFICIAL_HTTP_ROUTES, OFFICIAL_WS_EVENTS } from "../src/contracts.ts";
import { appendMachineHistory, REGISTERED_HTTP_ROUTES, StatusHub } from "../src/index.ts";
import { invalidateSettingsCache, settings } from "../src/db.ts";

test("xboard-server has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("device state keeps the upstream five-minute activity window without KV heartbeats", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /status-hub\.internal\/devices\/report/);
  assert.match(source, /Number\(seenAt\) >= timestamp - 300/);
  assert.doesNotMatch(source, /`node:devices:\$\{nodeId\}`/);
  assert.doesNotMatch(source, /`user:devices:\$\{userId\}`/);
});

test("node polling defaults to five minutes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /setting\(env, "server_push_interval", "300"\)/);
  assert.match(source, /setting\(env, "server_pull_interval", "300"\)/);
  assert.doesNotMatch(source, /setting\(env, "server_(?:push|pull)_interval", "60"\)/);
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
  assert.match(source, /await reportStatus\(this\.env, "node", Number\(node\.id\), runtime\)/);
});

test("node and machine runtime status persist in the global StatusHub", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /export class StatusHub/);
  assert.match(source, /const STATUS_HUB_ID = "global"/);
  assert.match(source, /env\.STATUS_HUB\.idFromName\(STATUS_HUB_ID\)/);
  assert.match(source, /updatedAt - Number\(this\.persistedStatusAt\.get\(key\) \|\| 0\) >= 60/);
  assert.match(source, /updatedAt - lastRecordedAt >= 300/);
  assert.match(source, /await this\.state\.storage\.put\(historyKey, nextHistory\)/);
  assert.match(wrangler, /name = "STATUS_HUB"/);
  assert.match(wrangler, /class_name = "StatusHub"/);
  assert.match(wrangler, /tag = "v2"[\s\S]*new_sqlite_classes = \["StatusHub"\]/);
  assert.doesNotMatch(source, /UPDATE v2_server SET metrics = \?, last_push_at = \?, updated_at = \?/);
  assert.doesNotMatch(source, /INSERT INTO v2_server_machine_load_history/);
});

test("machine load history appends every report like upstream", () => {
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

test("StatusHub coalesces heartbeat storage while preserving device expiry and history", async () => {
  const storage = statusHubStorage();
  const hub = new StatusHub({ storage });
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

    const deviceReport = (timestamp, devices) => hub.fetch(new Request("https://status-hub.internal/devices/report", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node_id: 1, timestamp, devices })
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
    await deviceReport(1120, { 7: {} });
    listed = await hub.fetch(new Request("https://status-hub.internal/devices/list", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_ids: [7, 8], timestamp: 1120 })
    }));
    assert.deepEqual((await listed.json()).data.users, { 8: ["3.3.3.3"] });

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
  assert.match(db, /export function invalidateSettingsCache\(\)/);
  assert.match(source, /url\.pathname === "\/internal\/settings\/invalidate"/);
  assert.match(source, /SELECT name, value FROM v2_settings WHERE name IN \('internal_sync_token', 'server_token'\)/);
  assert.match(source, /invalidateSettingsCache\(\)/);
});

test("websocket device state follows the official per-IP contract", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /next\[userId\] = Object\.fromEntries/);
  assert.match(source, /deviceSnapshot\(Number\(input\.timestamp \|\| now\(\)\)/);
  assert.match(source, /await clearNodeDevices\(this\.env, Number\(node\.id\)\)/);
  assert.match(source, /async function pushNodeEvent/);
  assert.match(source, /pushDo\(env, `machine:\$\{machineId\}`/);
  assert.match(source, /pushDo\(env, `node:\$\{nodeId\}`/);
  assert.match(source, /UPDATE v2_user SET online_count = \?/);
  assert.doesNotMatch(source, /event === "pong"[\s\S]{0,400}optionalKvPut/);
  assert.match(source, /Internal sync token is not configured/);
  assert.match(source, /event === "report\.devices"[\s\S]*socket\.send\(wsMessage\("sync\.devices"/);
  assert.match(source, /Number\(seenAt \|\| 0\) > timestamp - 300/);
  assert.match(source, /aggregateDevices\(env, users\)/);
  assert.match(source, /enqueueTraffic\(env, node, traffic\)/);
  assert.match(source, /const nonEmptyArrayLike =/);
  assert.match(source, /catch \{ return false; \}/);
  assert.match(source, /catch \{ return \{\}; \}/);
  assert.match(source, /offset < ids\.length; offset \+= 100/);
  assert.doesNotMatch(source, /this\.env\.XBOARD_KV\.put\(`node:ws:/);
  assert.doesNotMatch(source, /node:ws:(?:target|alive)/);
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
