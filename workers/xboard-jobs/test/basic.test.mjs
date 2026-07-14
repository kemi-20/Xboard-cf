import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("xboard-jobs has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("mail events are delivered through the Resend HTTP API with idempotency", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function mail/);
  assert.match(source, /api\.resend\.com/);
  assert.match(source, /authorization: `Bearer \$\{apiKey\}`/);
  assert.match(source, /"idempotency-key": String\(event\.event_id\)/);
  assert.match(source, /message\.retry\(\)/);
});

test("traffic statistics persist the official server_rate field", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /server_rate, record_type/);
  assert.match(source, /server_rate = excluded\.server_rate/);
});

test("mail templates override fallbacks and Resend credentials stay protocol-specific", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.doesNotMatch(source, /if \(payload\.html \|\| payload\.text\) return payload/);
  assert.match(source, /render\(String\(template\.subject \|\| ""\), vars\) \|\| render\(String\(payload\.subject \|\| ""\), vars\)/);
  assert.doesNotMatch(source, /setting\(env, "email_password"\)/);
  assert.match(source, /replace\(\/\[<>\]\/g, ""\)/);
});
