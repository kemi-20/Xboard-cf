import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OFFICIAL_HTTP_ROUTES, OFFICIAL_WS_EVENTS } from "../src/contracts.ts";
import { REGISTERED_HTTP_ROUTES } from "../src/index.ts";

test("xboard-server has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
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
