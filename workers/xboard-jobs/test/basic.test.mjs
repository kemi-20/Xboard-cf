import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jobsWorker, { __test } from "../src/index.ts";
import { cronTest } from "../src/cron.ts";
import { TrafficStatsHub } from "../src/traffic-stats.ts";

test("xboard-jobs has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("Jobs and first-time deployment enable the Worker Cache API runtime", () => {
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  const bootstrap = fs.readFileSync("../../scripts/prepare-cloudflare-ci.mjs", "utf8");
  assert.match(wrangler, /\[cache\]\s+enabled = true/);
  assert.doesNotMatch(bootstrap, /worker === "xboard-edge" \|\| worker === "xboard-server"/);
  assert.match(bootstrap, /for \(const worker of \["xboard-edge", "xboard-server", "xboard-jobs"\]\)/);
  assert.match(bootstrap, /\[cache\\\]\\s\*\$\/m/);
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
  assert.doesNotMatch(source, /SELECT id FROM v2_stat WHERE record_at = \? AND record_type = 'd'/);
  assert.match(source, /INSERT INTO v2_stat\(record_at, record_type,[\s\S]*ON CONFLICT\(record_at, record_type\) DO UPDATE/);
  assert.match(source, /const fields = \["user_count", "order_count", "transfer_used", "transfer_used_total"/);
  assert.match(source, /fields\.map\(field => `\$\{field\} = CASE WHEN \? IS NULL THEN v2_stat\.\$\{field\} ELSE excluded\.\$\{field\} END`\)/);
  assert.match(wrangler, /queue = "notification-events"[\s\S]*dead_letter_queue = "notification-events-dlq"/);
});

test("traffic statistics persist the official server_rate field", () => {
  const source = fs.readFileSync("src/traffic-stats.ts", "utf8");
  assert.match(source, /server_rate, record_type/);
  assert.match(source, /server_rate = excluded\.server_rate/);
  assert.match(source, /v2_stat_server\(server_id, server_type, u, d, record_type,[\s\S]*VALUES \(\?, \?, \?, \?, 'd'/);
  assert.doesNotMatch(source, /UPDATE v2_stat_server SET record_type = 'd' WHERE/);
  assert.match(source, /u = excluded\.u, d = excluded\.d/);
  assert.doesNotMatch(source, /u = u \+ excluded\.u/);
});

test("traffic statistics use one-row Outbox batches and a global durable aggregator", async () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const hub = fs.readFileSync("src/traffic-stats.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(source, /INSERT INTO v2_traffic_stats_outbox/);
  assert.doesNotMatch(source, /v2_stat_user[\s\S]*u = u \+ excluded\.u/);
  assert.match(hub, /class TrafficStatsHub/);
  assert.match(hub, /processed:/);
  assert.match(hub, /now\(\) - last >= 3600/);
  assert.match(hub, /input\.force === true/);
  assert.match(hub, /private async scheduleHourlyMaterialization\(\)/);
  assert.match(hub, /const legacyBuckets = await this\.state\.storage\.list\(\{ prefix: "bucket:" \}\)/);
  assert.doesNotMatch(hub, /writeDataPoint/);
  assert.match(wrangler, /name = "TRAFFIC_STATS_HUB"/);
  assert.doesNotMatch(wrangler, /analytics_engine_datasets/);
  assert.doesNotMatch(source, /backfillTrafficAnalytics/);
  const first = await __test.stableBatchId(["b", "a"]);
  const second = await __test.stableBatchId(["a", "b"]);
  assert.equal(first, second);
});

test("TrafficStatsHub deduplicates a retried batch and updates only involved user shards", async () => {
  const values = new Map();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) {
      if (typeof key === "string") values.set(key, value);
      else for (const [name, entry] of Object.entries(key)) values.set(name, entry);
    },
    async delete(key) { return values.delete(key); },
    async list(options = {}) { return new Map([...values].filter(([key]) => !options.prefix || key.startsWith(options.prefix))); },
    async setAlarm() {},
    async transaction(closure) { return closure(this); }
  };
  const db = {
    withSession() { return this; },
    prepare() { return { bind() { return this; }, async all() { return { success: true, results: [] }; }, async first() { return null; }, async run() { return { success: true }; } }; },
    async batch() { return []; }
  };
  const hub = new TrafficStatsHub({ storage }, { XBOARD_DB: db });
  const payload = { batch_id: "stable", user_aggregates: [{ userId: 17, serverId: 3, serverType: "vless", u: 10, d: 20, rate: 1 }], server_aggregates: [{ serverId: 3, serverType: "vless", u: 10, d: 20 }], transfer_used: 30, record_at: 1000, created_at: 1200 };
  assert.equal((await hub.fetch(new Request("https://hub/process", { method: "POST", body: JSON.stringify(payload) }))).status, 200);
  assert.equal((await hub.fetch(new Request("https://hub/process", { method: "POST", body: JSON.stringify(payload) }))).status, 200);
  assert.equal(values.get("daily:user:1000:1")["17:3:vless"].u, 10);
  assert.equal(values.get("daily:total:1000"), 30);
  assert.equal([...values.keys()].filter(key => key.startsWith("daily:user:1000:")).length, 1);
});

test("mail templates override fallbacks and provider credentials stay protocol-specific", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.doesNotMatch(source, /if \(payload\.html \|\| payload\.text\) return payload/);
  assert.match(source, /const subjectTemplate = row \? template\.subject : payload\.subject \|\| template\.subject/);
  assert.match(source, /log_subject: String\(payload\.subject \|\| subject\)/);
  assert.match(source, /setting\(env, "email_password"\)/);
  assert.doesNotMatch(source, /resend_api_key/);
  assert.match(source, /replace\(\/\[<>\]\/g, ""\)/);
  assert.match(source, /const html = row[\s\S]*?\? renderedContent/);
  assert.match(source, /remindExpire/);
  assert.match(source, /remindTraffic/);
  assert.match(source, /legacyAliases/);
  assert.match(source, /const flatTemplateVars = Object\.fromEntries/);
  assert.match(source, /payload\.template_value\?\.vars \|\| payload\.vars \|\| flatTemplateVars/);
  assert.match(source, /recipients\.map\(email/);
});

test("traffic events use event-level idempotency and conditional exceeded checks", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.doesNotMatch(source, /event\.event_id}:user:/);
  assert.match(source, /async function trafficCandidates/);
  assert.match(source, /aggregateTrafficEvents\(candidates\)/);
  assert.match(source, /INSERT INTO v2_traffic_dedup\(event_id, created_at\) VALUES \(\?, \?\)/);
  assert.doesNotMatch(source, /INSERT OR IGNORE INTO v2_traffic_dedup/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS v2_traffic_dedup/);
  assert.match(source, /WITHOUT ROWID/);
  assert.doesNotMatch(source, /VALUES \(\?, 'traffic', 'done', '', NULL, \?, \?\)/);
  assert.match(source, /INSERT INTO v2_traffic_pending_check/);
  assert.match(source, /u \+ d >= transfer_enable/);
  assert.match(source, /ON CONFLICT\(user_id\) DO NOTHING/);
  assert.doesNotMatch(source, /traffic:pending_check/);
  assert.match(source, /trafficMessages = batch\.messages\.filter/);
  assert.match(source, /trafficEventGroups\(splitTrafficEvents\(trafficMessages\.map/);
  assert.match(source, /trafficBatch\(env, events\)/);
  assert.match(wrangler, /dead_letter_queue = "traffic-events-dlq"/);
  assert.match(wrangler, /dead_letter_queue = "notification-events-dlq"/);
  assert.match(wrangler, /max_retries = 5/);
  assert.match(wrangler, /queue = "traffic-events"[\s\S]*?max_batch_size = 100/);
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

  const groups = __test.trafficEventGroups([
    { payload: Array(100).fill({ user_id: 1 }) },
    { payload: Array(100).fill({ user_id: 2 }) },
    { payload: Array(100).fill({ user_id: 3 }) }
  ]);
  assert.deepEqual(groups.map(group => group.length), [2, 1]);

  const oversized = __test.splitTrafficEvents([{
    event_id: "large-report",
    server_id: 1,
    payload: Array.from({ length: 601 }, (_, index) => ({ user_id: index + 1, u: 1, d: 0 }))
  }]);
  assert.deepEqual(oversized.map(event => event.payload.length), [250, 250, 101]);
  assert.deepEqual(oversized.map(event => event.event_id), [
    "large-report:chunk:0", "large-report:chunk:1", "large-report:chunk:2"
  ]);
  assert.ok(__test.trafficEventGroups(oversized).every(group => group.reduce((total, event) => total + event.payload.length, 0) <= 250));
});

test("queue batches use one first-primary D1 session", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  const db = fs.readFileSync("src/db.ts", "utf8");
  assert.match(db, /db\.withSession\("first-primary"\)/);
  assert.match(source, /async queue\(batch: MessageBatch, env: Env\)[\s\S]*XBOARD_DB: primaryDatabase\(env\.XBOARD_DB\)/);
  assert.doesNotMatch(source, /withSession\("first-unconstrained"\)/);
});

test("traffic candidate selection skips completed and active duplicate deliveries", async () => {
  const current = Math.floor(Date.now() / 1000);
  const env = {
    XBOARD_DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async run() { return { success: true, meta: { changes: 0 } }; },
          async all() {
            if (sql.includes("FROM v2_traffic_dedup")) {
              return { success: true, results: [{ event_id: "dedup" }] };
            }
            return { success: true, results: [
              { event_id: "done", status: "done", updated_at: current },
              { event_id: "active", status: "processing:owner", updated_at: current },
              { event_id: "failed", status: "failed", updated_at: current - 10 }
            ] };
          }
        };
      }
    }
  };
  const result = await __test.trafficCandidates(env, [
    { event_id: "new" }, { event_id: "dedup" }, { event_id: "done" }, { event_id: "active" }, { event_id: "failed" }, { event_id: "new" }
  ]);
  assert.deepEqual(result.candidates.map(event => event.event_id), ["new", "failed"]);
  assert.deepEqual(result.staleEventIds, ["failed"]);
});

function jobLogDb() {
  const rows = new Map();
  return {
    rows,
    withSession() { return this; },
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async first() {
          if (sql.startsWith("SELECT status, updated_at FROM v2_job_logs")) return rows.get(values[0]) || null;
          throw new Error(`Unexpected SQL: ${sql}`);
        },
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
  const claimed = claims.filter(result => result.state === "claimed");
  assert.equal(claimed.length, 1);
  assert.equal(claims.filter(result => result.state === "busy").length, 19);
  await __test.completeClaim(env, "traffic:duplicate", claimed[0].token, []);
  assert.equal(db.rows.get("traffic:duplicate").status, "done");
  assert.deepEqual(await __test.claimEvent(env, "traffic:duplicate", "traffic", {}), { state: "done" });
});

test("fresh notification claims are delayed instead of acknowledged as complete", async () => {
  const db = jobLogDb();
  const env = { XBOARD_DB: db };
  const first = await __test.claimEvent(env, "mail:busy", "mail", {});
  assert.equal(first.state, "claimed");
  const second = await __test.claimEvent(env, "mail:busy", "mail", {});
  assert.equal(second.state, "busy");
  assert.ok(second.retryAfter >= 120 && second.retryAfter <= 121);
  await assert.rejects(() => __test.claimedToken(env, "mail:busy", "mail", {}), error =>
    error instanceof __test.EventClaimBusyError && error.retryAfter >= 120
  );
  let acknowledged = false;
  let retryOptions = null;
  await jobsWorker.queue({
    queue: "notification-events",
    messages: [{
      body: { event_id: "mail:busy", type: "mail", payload: {} },
      ack() { acknowledged = true; },
      retry(options) { retryOptions = options; }
    }]
  }, env);
  assert.equal(acknowledged, false);
  assert.ok(retryOptions.delaySeconds >= 120 && retryOptions.delaySeconds <= 121);
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

test("accepted traffic refreshes last online in the existing user update", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /UPDATE v2_user SET u = u \+ \?, d = d \+ \?, t = \?, online_count = CASE WHEN COALESCE\(online_count, 0\) > 0 THEN online_count ELSE 1 END, last_online_at = \?, updated_at = \? WHERE id = \?/);
});

test("database mail templates use safe variables and preserve text line breaks", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /function safeMailVars/);
  assert.match(source, /escapeHtml\(value\)/);
  assert.match(source, /contentMode === "text"/);
  assert.match(source, /mailLogin:/);
  assert.match(source, /const target = payload\.to \?\? payload\.email/);
  assert.match(source, /INSERT INTO v2_mail_log\(email, subject, template_name, error/);
  assert.match(source, /payload\.parse_mode \|\| "Markdown"/);
  assert.match(source, /telegramBody\.parse_mode = parseMode === "markdown" \? "Markdown"/);
  assert.match(source, /escapeHtml\(content\)\.replace/);
});

test("test mail returns the upstream mail log contract when the provider rejects the request", async () => {
  const originalFetch = globalThis.fetch;
  const statements = [];
  let providerPayload = null;
  const settings = [
    { name: "app_name", value: "XBoard" },
    { name: "app_url", value: "https://example.com" },
    { name: "email_driver", value: "maileroo" },
    { name: "email_password", value: "test-key" },
    { name: "email_from_address", value: "sender@example.com" },
    { name: "email_username", value: "XBoard" }
  ];
  const db = {
    withSession() { return this; },
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...input) { values = input; return this; },
        async all() { return { results: sql.includes("FROM v2_settings") ? settings : [] }; },
        async first() {
          if (sql.includes("FROM v2_mail_templates")) return { subject: "{{name}} notice", content: "{{content}}\n{{url}}" };
          return null;
        },
        async run() { statements.push({ sql, values }); return { success: true, meta: { changes: 1 } }; }
      };
      return statement;
    },
    async batch(batch) { return Promise.all(batch.map(statement => statement.run())); }
  };
  globalThis.fetch = async (_input, init) => {
    providerPayload = JSON.parse(String(init.body));
    return new Response("provider unavailable", { status: 503 });
  };
  try {
    const response = await jobsWorker.fetch(new Request("https://jobs.internal/internal/mail/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-xboard-internal-token": "internal-secret" },
      body: JSON.stringify({ email: "admin@example.com" })
    }), { XBOARD_DB: db, INTERNAL_SYNC_TOKEN: "internal-secret" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.email, "admin@example.com");
    assert.equal(payload.data.subject, "This is xboard test email");
    assert.equal(payload.data.template_name, "db:notify");
    assert.match(payload.data.error, /Maileroo 503/);
    assert.equal(providerPayload.subject, "XBoard notice");
    assert.match(providerPayload.html, /https:\/\/example\.com/);
    assert.ok(statements.some(item => item.sql.includes("INSERT INTO v2_mail_log")));
    assert.equal(statements.some(item => item.sql.includes("v2_job_logs")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("template test mail forwards the selected template, subject and variables", async () => {
  const originalFetch = globalThis.fetch;
  let providerPayload = null;
  const settings = [
    { name: "email_driver", value: "brevo" },
    { name: "email_password", value: "test-key" },
    { name: "email_from_address", value: "sender@example.com" },
    { name: "email_username", value: "XBoard" }
  ];
  const db = {
    withSession() { return this; },
    prepare(sql) {
      let values = [];
      return {
        bind(...input) { values = input; return this; },
        async all() { return { results: sql.includes("FROM v2_settings") ? settings : [] }; },
        async first() {
          if (sql.includes("FROM v2_mail_templates")) return { subject: "{{name}} verification", content: "Code: {{code}}" };
          return null;
        },
        async run() { return { success: true, meta: { changes: 1 }, values }; }
      };
    },
    async batch(batch) { return Promise.all(batch.map(statement => statement.run())); }
  };
  globalThis.fetch = async (_input, init) => {
    providerPayload = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ messageId: "ok" }), { status: 201 });
  };
  try {
    const response = await jobsWorker.fetch(new Request("https://jobs.internal/internal/mail/test", {
      method: "POST",
      headers: { "content-type": "application/json", "x-xboard-internal-token": "internal-secret" },
      body: JSON.stringify({
        email: "admin@example.com",
        template_name: "verify",
        subject: "XBoard - 验证码测试",
        vars: { name: "Power Chain", code: "123456" },
        content_mode: "text"
      })
    }), { XBOARD_DB: db, INTERNAL_SYNC_TOKEN: "internal-secret" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.subject, "XBoard - 验证码测试");
    assert.equal(payload.data.template_name, "db:verify");
    assert.equal(payload.data.error, null);
    assert.equal(providerPayload.subject, "Power Chain verification");
    assert.match(providerPayload.html, /Code: 123456/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("online cleanup failures are visible without writing a database job log", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    await cronTest.cleanupOnlineStatus({
      XBOARD_DB: { prepare() { return { bind() { return this; }, async run() { throw new Error("D1 unavailable"); } }; } }
    }, Math.floor(Date.now() / 1000));
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /online status/i);
  } finally {
    console.warn = originalWarn;
  }
});
