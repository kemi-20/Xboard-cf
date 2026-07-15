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

test("node metrics persist to D1 when KV is unavailable", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /UPDATE v2_server SET metrics = \?, last_push_at = \?, updated_at = \?/);
  assert.match(source, /await optionalKvPut\(env, `node:metrics:\$\{node\.id\}`, value/);
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
