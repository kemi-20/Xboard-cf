import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OFFICIAL_HTTP_ROUTES, OFFICIAL_WS_EVENTS } from "../src/contracts.ts";
import { appendMachineHistory, REGISTERED_HTTP_ROUTES } from "../src/index.ts";
import { invalidateSettingsCache, settings } from "../src/db.ts";

test("xboard-server has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("device state expiry matches the upstream five-minute Redis TTL", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /`node:devices:\$\{nodeId\}`/);
  assert.match(source, /JSON\.stringify\(next\), \{ expirationTtl: 300 \}/);
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
  assert.match(source, /if \(status\) await processStatus/);
  assert.match(source, /await processMetrics/);
});

test("node and machine runtime status persist in the global StatusHub", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /export class StatusHub/);
  assert.match(source, /const STATUS_HUB_ID = "global"/);
  assert.match(source, /env\.STATUS_HUB\.idFromName\(STATUS_HUB_ID\)/);
  assert.match(source, /this\.state\.storage\.put\(writes\)/);
  assert.match(source, /writes\[historyKey\] = appendMachineHistory\(history, point, updatedAt\)/);
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

test("settings use a coalesced memory and KV snapshot cache", () => {
  const source = fs.readFileSync("src/db.ts", "utf8");
  assert.match(source, /const SETTINGS_CACHE_TTL_MS = 300_000/);
  assert.match(source, /const SETTINGS_VERSION_CHECK_MS = 30_000/);
  assert.match(source, /settings:snapshot:/);
  assert.match(source, /kv\.get\("settings_version"\)/);
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

test("large traffic reports are split before entering the queue", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /offset \+= 10/);
  assert.match(source, /payload\.slice\(offset, offset \+ 10\)/);
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
  assert.match(source, /output\[String\(user\.id\)\] = \[\.\.\.ips\]/);
  assert.match(source, /await clearNodeDevices\(this\.env, Number\(node\.id\)\)/);
  assert.match(source, /node:ws:target:\$\{nodeId\}`[\s\S]*expirationTtl: 86400/);
  assert.match(source, /UPDATE v2_user SET online_count = \?/);
  assert.match(source, /Internal sync token is not configured/);
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

test("invalid node rates follow the upstream numeric cast instead of charging at rate one", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /Number\.isFinite\(parsedFallback\) \? parsedFallback : 0/);
  assert.doesNotMatch(source, /Number\.isFinite\(parsedFallback\) \? parsedFallback : 1/);
});
