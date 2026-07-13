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
});

test("admin CRUD routes server resources to their own tables", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /\["\/server\/group\/", "v2_server_group"\]/);
  assert.match(source, /\["\/server\/route\/", "v2_server_route"\]/);
  assert.match(source, /\["\/server\/machine\/", "v2_server_machine"\]/);
  assert.match(source, /\["\/server\/manage\/", "v2_server"\]/);
  assert.match(source, /const table = adminTableForPath\(path\)/);
});

test("bootstrap preserves renamed default groups", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /INSERT INTO v2_server_group[\s\S]*?ON CONFLICT\(id\) DO NOTHING/);
});

test("node protocol paths are proxied through the xboard-server service binding", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /isNodeProtocolPath\(url\.pathname\)/);
  assert.match(source, /env\.XBOARD_SERVER\.fetch\(request\)/);
  assert.match(source, /\/api\/v1\/server\//);
  assert.match(source, /\/api\/v2\/server\/machine\/nodes/);
  assert.match(wrangler, /binding = "XBOARD_SERVER"/);
  assert.match(wrangler, /service = "xboard-server"/);
});
