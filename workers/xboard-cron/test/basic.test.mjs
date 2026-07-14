import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("xboard-cron has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("scheduled reminders enqueue the official expiry and traffic notifications", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /remind_mail_enable/);
  assert.match(source, /remind_expire/);
  assert.match(source, /remind_traffic/);
  assert.match(source, /mail:remind-expire/);
  assert.match(source, /mail:remind-traffic/);
  assert.match(source, /MAIL_EVENTS\.sendBatch/);
  assert.match(source, /WHERE id > \?[\s\S]*ORDER BY id ASC LIMIT 500/);
});

test("cron implements the official order, ticket, commission and traffic checks", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /check:order/);
  assert.match(source, /check:ticket/);
  assert.match(source, /check:commission/);
  assert.match(source, /commission_auto_check_enable/);
  assert.match(source, /commission_distribution_l1/);
  assert.match(source, /v2_commission_log/);
  assert.match(source, /check:traffic-exceeded/);
  assert.match(source, /XBOARD_SERVER\.fetch/);
});
