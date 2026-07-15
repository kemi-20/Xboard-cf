import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import cronWorker, { __test } from "../src/index.ts";

test("xboard-cron has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(wrangler, /crons = \["\* \* \* \* \*"\]/);
  assert.doesNotMatch(wrangler, /10 0 \* \* \*/);
});

test("public HTTP requests cannot execute cron maintenance", async () => {
  const forbiddenEnv = new Proxy({}, {
    get() { throw new Error("The public HTTP handler accessed a runtime binding"); }
  });
  for (const url of [
    "https://audit.invalid/",
    "https://audit.invalid/?task=all",
    "https://audit.invalid/?task=check:order"
  ]) {
    const response = await cronWorker.fetch(new Request(url), forbiddenEnv);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { message: "Not Found" });
  }
  const health = await cronWorker.fetch(new Request("https://audit.invalid/health"), forbiddenEnv);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).data.service, "xboard-cron");
});

test("order month arithmetic uses the Asia/Shanghai calendar", () => {
  const shanghaiMarchFirstAtTwo = Date.UTC(2026, 1, 28, 18, 0, 0) / 1000;
  const expectedShanghaiAprilFirstAtTwo = Date.UTC(2026, 2, 31, 18, 0, 0) / 1000;
  assert.equal(__test.addOrderMonths(shanghaiMarchFirstAtTwo, 1), expectedShanghaiAprilFirstAtTwo);
});

test("migrated boolean settings accept true/false and one/zero strings", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function booleanSetting\(value: unknown, fallback = false\)/);
  assert.match(source, /String\(value\)\.toLowerCase\(\) === "true"/);
  assert.match(source, /booleanSetting\(config\.remind_mail_enable\)/);
  assert.match(source, /booleanSetting\(await setting\(env, "commission_auto_check_enable"/);
});

test("scheduled reminders enqueue the official expiry and traffic notifications", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /remind_mail_enable/);
  assert.match(source, /remind_expire/);
  assert.match(source, /remind_traffic/);
  assert.match(source, /template_name: "remindExpire"/);
  assert.match(source, /template_name: "remindTraffic"/);
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
  assert.match(source, /const recordDay = day - 86400/);
  assert.match(source, /FROM v2_stat_server WHERE created_at >= \? AND created_at < \?/);
  assert.match(source, /transfer_used_total = \?/);
  for (const field of ["order_total", "paid_count", "paid_total", "commission_count", "commission_total", "register_count", "invite_count"]) assert.match(source, new RegExp(field));
  assert.match(source, /v2_traffic_reset_logs/);
  assert.match(source, /new_order_event_id/);
  assert.match(source, /renew_order_event_id/);
  assert.match(source, /change_order_event_id/);
  assert.match(source, /v2_traffic_pending_check/);
  assert.match(source, /scope: "users"/);
  assert.match(source, /WHERE status = 0 AND created_at <= \?/);
  assert.match(source, /SELECT id, user_id, balance_amount FROM v2_order/);
  assert.match(source, /balance = COALESCE\(balance, 0\) \+ COALESCE\(\(SELECT balance_amount/);
  assert.match(source, /WHERE status = 1 ORDER BY id ASC LIMIT 200/);
  assert.match(source, /UPDATE v2_order SET status = 3/);
  assert.match(source, /ORDER BY u\.id ASC LIMIT 100/);
  assert.match(source, /online_count > 0 AND \(last_online_at IS NULL OR last_online_at < \?\)/);
  assert.match(source, /while \(true\)[\s\S]*commission_status = 1/);
  assert.match(source, /v2_traffic_pending_check[\s\S]*LIMIT 1000[\s\S]*DELETE FROM v2_traffic_pending_check/);
  assert.match(source, /DELETE FROM failed_jobs WHERE failed_at < \?/);
  assert.match(source, /DELETE FROM v2_job_logs WHERE COALESCE\(updated_at, created_at\) < \?/);
  assert.match(source, /ts - 7 \* 86400/);
});

test("order and commission retries cannot credit balances twice", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /EXISTS \(SELECT 1 FROM v2_order WHERE id = \? AND commission_status = 1\)/);
  assert.match(source, /SELECT \?, \?, \?, \?, \?, \?, \?, \?, \? WHERE EXISTS/);
  assert.match(source, /balance = COALESCE\(balance, 0\) \+ \?/);
  assert.match(source, /const orderGuard = "EXISTS \(SELECT 1 FROM v2_order WHERE id = \? AND status = 1\)"/);
  assert.match(source, /WHERE id = \? AND \$\{orderGuard\}/);
  assert.match(source, /results\.at\(-1\).*changes/);
});
