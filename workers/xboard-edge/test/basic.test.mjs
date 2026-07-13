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
});

test("login sessions fall back to D1 when KV writes fail", () => {
  const source = fs.readFileSync("src/auth.ts", "utf8");
  const d1Insert = source.indexOf('INSERT INTO personal_access_tokens');
  const kvWrite = source.indexOf('await kv.put');
  assert.ok(d1Insert >= 0 && kvWrite > d1Insert);
  assert.match(source.slice(kvWrite - 20, kvWrite + 500), /try[\s\S]*await kv\.put[\s\S]*catch/);
});
