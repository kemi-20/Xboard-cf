import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __test } from "../src/index.ts";

test("xboard-jobs has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("mail rendering preserves unknown placeholders and honors defaults", () => {
  assert.equal(__test.render("Hello {{known}} {{missing}}", { known: "XBoard" }), "Hello XBoard {{missing}}");
  assert.equal(__test.render("{{missing|fallback}}", {}), "fallback");
  assert.equal(__test.render("{{zero}}/{{disabled}}", { zero: 0, disabled: false }), "0/false");
});

test("mail events support Maileroo and Brevo HTTP APIs with idempotency", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /async function mail/);
  assert.match(source, /smtp\.maileroo\.com\/api\/v2\/emails/);
  assert.match(source, /api\.brevo\.com\/v3\/smtp\/email/);
  assert.match(source, /authorization: `Bearer \$\{apiKey\}`/);
  assert.match(source, /"api-key": apiKey/);
  assert.match(source, /"idempotency-key": String\(event\.event_id\)/);
  assert.match(source, /message\.retry\(\)/);
});

test("traffic statistics persist the official server_rate field", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /server_rate, record_type/);
  assert.match(source, /server_rate = excluded\.server_rate/);
  assert.match(source, /SET u = u \+ \?, d = d \+ \?, t = \?, updated_at = \?/);
});

test("mail templates override fallbacks and provider credentials stay protocol-specific", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.doesNotMatch(source, /if \(payload\.html \|\| payload\.text\) return payload/);
  assert.match(source, /render\(String\(template\.subject \|\| ""\), vars\) \|\| render\(String\(payload\.subject \|\| ""\), vars\)/);
  assert.match(source, /setting\(env, "email_password"\)/);
  assert.doesNotMatch(source, /resend_api_key/);
  assert.match(source, /replace\(\/\[<>\]\/g, ""\)/);
  assert.match(source, /const html = row[\s\S]*?\? renderedContent/);
  assert.match(source, /remindExpire/);
  assert.match(source, /remindTraffic/);
  assert.match(source, /legacyAliases/);
  assert.match(source, /recipients\.map\(email/);
});

test("traffic events use event-level idempotency and conditional exceeded checks", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.doesNotMatch(source, /event\.event_id}:user:/);
  assert.match(source, /const users = new Map/);
  assert.match(source, /const results = await runOnce\(env, event\.event_id, "traffic"/);
  assert.match(source, /INSERT INTO v2_traffic_pending_check/);
  assert.match(source, /u \+ d >= transfer_enable/);
  assert.match(source, /ON CONFLICT\(user_id\) DO UPDATE/);
  assert.match(source, /pendingResultIndexes\.some/);
  assert.match(wrangler, /dead_letter_queue = "traffic-events-dlq"/);
  assert.match(wrangler, /dead_letter_queue = "mail-events-dlq"/);
  assert.match(wrangler, /max_retries = 5/);
  assert.match(wrangler, /queue = "traffic-events"[\s\S]*?max_batch_size = 1/);
});
