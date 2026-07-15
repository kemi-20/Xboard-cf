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

test("telegram and daily statistics preserve upstream success and record contracts", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /result\?\.ok !== true/);
  assert.match(source, /SELECT id FROM v2_stat WHERE record_at = \? AND record_type = 'd'/);
  assert.match(source, /INSERT INTO v2_stat\(record_at, record_type,[\s\S]*VALUES \(\?, 'd'/);
  assert.match(wrangler, /queue = "telegram-events"[\s\S]*dead_letter_queue = "telegram-events-dlq"/);
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
  assert.match(source, /render\(String\(template\.subject \|\| ""\), renderVars\) \|\| render\(String\(payload\.subject \|\| ""\), renderVars\)/);
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
  assert.match(source, /async function claimTrafficEvents/);
  assert.match(source, /aggregateTrafficEvents\(claimed\.map/);
  assert.match(source, /UPDATE v2_job_logs SET status = 'done'/);
  assert.match(source, /INSERT INTO v2_traffic_pending_check/);
  assert.match(source, /u \+ d >= transfer_enable/);
  assert.match(source, /ON CONFLICT\(user_id\) DO UPDATE/);
  assert.match(source, /pendingResultIndexes\.some/);
  assert.match(source, /trafficMessages = batch\.messages\.filter/);
  assert.match(wrangler, /dead_letter_queue = "traffic-events-dlq"/);
  assert.match(wrangler, /dead_letter_queue = "mail-events-dlq"/);
  assert.match(wrangler, /max_retries = 5/);
  assert.match(wrangler, /queue = "traffic-events"[\s\S]*?max_batch_size = 10/);
  assert.match(wrangler, /queue = "traffic-events"[\s\S]*?max_batch_timeout = 5/);
});

test("traffic batches aggregate users and servers while preserving rate semantics", () => {
  const aggregate = __test.aggregateTrafficEvents([
    { server_id: 1, server_type: "vless", rate: 2, payload: [{ user_id: 7, u: 10, d: 5 }, { user_id: 8, u: 0, d: 0 }] },
    { server_id: 1, server_type: "vless", rate: 3, payload: [{ user_id: 7, u: 4, d: 6 }] },
    { server_id: 2, server_type: "trojan", rate: 1, payload: [{ user_id: 7, u: 1, d: 2 }] }
  ]);
  assert.deepEqual(aggregate.users.get(7), { u: 33, d: 30 });
  assert.equal(aggregate.users.has(8), false);
  assert.deepEqual(aggregate.servers.get("1:vless"), { serverId: 1, serverType: "vless", u: 14, d: 11 });
  assert.deepEqual(aggregate.userStats.get("7:1:vless"), { userId: 7, serverId: 1, serverType: "vless", u: 32, d: 28, rate: 3 });
  assert.equal(aggregate.transferUsed, 63);
});

function jobLogDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async run() {
          if (sql.startsWith("INSERT INTO v2_job_logs")) {
            const [eventId, type, status, payload, createdAt, updatedAt, staleAt] = values;
            const current = rows.get(eventId);
            if (!current || current.status === "failed" || (current.status.startsWith("processing:") && current.updated_at < staleAt)) {
              rows.set(eventId, { event_id: eventId, type, status, payload, created_at: current?.created_at || createdAt, updated_at: updatedAt });
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
          if (sql.includes("SET status = 'failed'")) {
            const [, updatedAt, eventId, claim] = values;
            const current = rows.get(eventId);
            if (current?.status !== claim) return { success: true, meta: { changes: 0 } };
            rows.set(eventId, { ...current, status: "failed", updated_at: updatedAt });
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
  };
}

test("concurrent duplicate queue deliveries have exactly one claimant", async () => {
  const db = jobLogDb();
  const env = { XBOARD_DB: db };
  const claims = await Promise.all(Array.from({ length: 20 }, () => __test.claimEvent(env, "traffic:duplicate", "traffic", {})));
  assert.equal(claims.filter(Boolean).length, 1);
  await __test.completeClaim(env, "traffic:duplicate", claims.find(Boolean), []);
  assert.equal(db.rows.get("traffic:duplicate").status, "done");
  assert.equal(await __test.claimEvent(env, "traffic:duplicate", "traffic", {}), null);
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

test("database mail templates use safe variables and preserve text line breaks", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function safeMailVars/);
  assert.match(source, /escapeHtml\(value\)/);
  assert.match(source, /contentMode === "text"/);
  assert.match(source, /mailLogin:/);
});
