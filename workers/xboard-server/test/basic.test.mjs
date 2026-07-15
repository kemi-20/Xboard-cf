import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OFFICIAL_HTTP_ROUTES, OFFICIAL_WS_EVENTS } from "../src/contracts.ts";
import { REGISTERED_HTTP_ROUTES } from "../src/index.ts";

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
  assert.match(source, /writes\[historyKey\] = history\.slice\(-288\)/);
  assert.match(wrangler, /name = "STATUS_HUB"/);
  assert.match(wrangler, /class_name = "StatusHub"/);
  assert.match(wrangler, /tag = "v2"[\s\S]*new_sqlite_classes = \["StatusHub"\]/);
  assert.doesNotMatch(source, /UPDATE v2_server SET metrics = \?, last_push_at = \?, updated_at = \?/);
  assert.doesNotMatch(source, /INSERT INTO v2_server_machine_load_history/);
});

test("settings use a coalesced sixty-second instance cache", () => {
  const source = fs.readFileSync("src/db.ts", "utf8");
  assert.match(source, /const SETTINGS_CACHE_TTL_MS = 60_000/);
  assert.match(source, /let settingsPromise: Promise<Record<string, string>> \| null = null/);
  assert.match(source, /SELECT name, value FROM v2_settings/);
  assert.doesNotMatch(source, /SELECT value FROM v2_settings WHERE name = \?/);
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
