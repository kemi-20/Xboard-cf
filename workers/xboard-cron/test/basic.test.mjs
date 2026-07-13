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
});
