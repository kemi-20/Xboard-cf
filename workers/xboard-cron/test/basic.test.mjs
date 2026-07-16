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
  assert.match(source, /if \(!amount\) continue;[\s\S]*inviterId = Number\(inviter\.invite_user_id \|\| 0\)/);
  assert.doesNotMatch(source, /share <= 0\) break/);
  assert.match(source, /XBOARD_SERVER\.fetch/);
  assert.match(source, /const recordDay = day - 86400/);
  assert.match(source, /FROM v2_stat_server WHERE created_at >= \? AND created_at < \?/);
  assert.match(source, /transfer_used_total = \?/);
  assert.doesNotMatch(source, /transfer_used = \?, transfer_used_total = \?/);
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
  assert.match(source, /WHERE status = 1 AND id > \? ORDER BY id ASC LIMIT 200/);
  assert.match(source, /UPDATE v2_order SET status = 3/);
  assert.match(source, /ORDER BY u\.id ASC LIMIT 100/);
  assert.match(source, /online_count > 0 AND \(last_online_at IS NULL OR last_online_at < \?\)/);
  assert.match(source, /while \(true\)[\s\S]*commission_status = 1/);
  assert.match(source, /DELETE FROM v2_traffic_pending_check WHERE user_id IN \([\s\S]*LIMIT 1000/);
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

function scheduleLockDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async run() {
          if (sql.startsWith("INSERT INTO v2_job_logs")) {
            const [eventId, status, createdAt, updatedAt, staleAt] = values;
            const current = rows.get(eventId);
            if (!current || !current.status.startsWith("running:") || current.updated_at < staleAt) {
              rows.set(eventId, { status, created_at: current?.created_at || createdAt, updated_at: updatedAt });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("SET status = 'done'")) {
            const [updatedAt, eventId, claim] = values;
            const current = rows.get(eventId);
            if (current?.status !== claim) return { success: true, meta: { changes: 0 } };
            rows.set(eventId, { ...current, status: "done", updated_at: updatedAt });
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }
      };
    }
  };
}

test("a stale cron owner cannot release its replacement's lock", async () => {
  const db = scheduleLockDb();
  const env = { XBOARD_DB: db };
  const first = await __test.acquireTaskLock(env, "check:order", 1_000);
  assert.ok(first);
  const replacement = await __test.acquireTaskLock(env, "check:order", 2_801);
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  await __test.releaseTaskLock(env, "check:order", first, 2_802);
  assert.equal(db.rows.get("schedule:lock:check:order").status, replacement);
  await __test.releaseTaskLock(env, "check:order", replacement, 2_803);
  assert.equal(db.rows.get("schedule:lock:check:order").status, "done");
});

test("scheduled cron keeps one trigger and one shared minute lock", () => {
  const ordinaryMinute = Date.UTC(2026, 6, 15, 4, 17) / 1000;
  const hourlyMinute = Date.UTC(2026, 6, 15, 5, 0) / 1000;
  assert.deepEqual(__test.scheduledTasks(ordinaryMinute), ["check:order", "check:ticket", "check:commission", "check:traffic-exceeded", "reset:traffic"]);
  assert.deepEqual(__test.scheduledTasks(hourlyMinute), [
    "check:order", "check:ticket", "check:commission", "check:traffic-exceeded", "reset:traffic", "cleanup:online-status"
  ]);
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /acquireTaskLock\(env, "scheduled", ts\)/);
  assert.match(source, /releaseTaskLock\(env, "scheduled", scheduledClaim/);
  assert.match(source, /Scheduled task failed/);
  assert.match(source, /if \(task !== "scheduled"\) throw error/);
  assert.match(source, /ts - 1800/);
  assert.doesNotMatch(source, /schedule:last_run:\$\{current\}/);
  assert.match(source, /internal\/status\/locks\/acquire/);
  assert.match(source, /if \(result\.data\?\.acquired === true\) return doClaim/);
  assert.match(source, /Fall back to D1 so scheduled business tasks remain available/);
  assert.match(source, /ts - previous >= 480/);
});

test("settings read D1 when KV fails after the memory cache is warm", async () => {
  const { settings } = await import(`../src/db.ts?kv-outage=${Date.now()}`);
  const originalNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  let d1Reads = 0;
  let versionReads = 0;
  const db = { prepare() { return { bind() { return this; }, async all() { d1Reads++; return { success: true, results: [{ name: "app_name", value: "fresh-d1" }] }; } }; } };
  const kv = {
    async get(key) {
      if (key === "settings_version") {
        versionReads++;
        if (versionReads > 1) throw new Error("KV unavailable");
        return "v1";
      }
      return JSON.stringify({ app_name: "stale-kv" });
    },
    async put() {}
  };
  try {
    assert.equal((await settings(db, kv)).app_name, "stale-kv");
    clock += 31_000;
    assert.equal((await settings(db, kv)).app_name, "fresh-d1");
    assert.equal(d1Reads, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("missing next reset timestamps are repaired once in bounded pages", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /system_next_reset_backfill_v1/);
  assert.match(source, /u\.id > \? AND u\.next_reset_at IS NULL/);
  assert.match(source, /ORDER BY u\.id ASC LIMIT 100/);
  assert.match(source, /value = users\.length < 100 \? "done"/);
});
