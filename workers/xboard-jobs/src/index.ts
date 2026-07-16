import type { AnalyticsEngineDataset, D1Database, D1PreparedStatement, DurableObjectNamespace, KVNamespace, MessageBatch } from "./types.ts";
import { now, ok } from "./compat.ts";
import { primaryDatabase, settings as loadSettings } from "./db.ts";
export { TrafficStatsHub } from "./traffic-stats.ts";

export interface Env {
  XBOARD_DB: D1Database;
  XBOARD_KV: KVNamespace;
  TRAFFIC_STATS_HUB: DurableObjectNamespace;
  USER_TRAFFIC_ANALYTICS: AnalyticsEngineDataset;
  SERVER_TRAFFIC_ANALYTICS: AnalyticsEngineDataset;
  MAILEROO_API_KEY?: string;
  BREVO_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

const SHANGHAI_OFFSET = 8 * 3600;
let trafficDedupSchemaReady = false;
let trafficDedupSchemaPromise: Promise<void> | null = null;

async function ensureTrafficDedupSchema(env: Env) {
  if (trafficDedupSchemaReady) return;
  if (!trafficDedupSchemaPromise) {
    trafficDedupSchemaPromise = (async () => {
      await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_traffic_dedup (
        event_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID`).run();
      await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_traffic_stats_outbox (
        batch_id TEXT PRIMARY KEY,
        event_ids TEXT NOT NULL,
        user_aggregates TEXT NOT NULL,
        server_aggregates TEXT NOT NULL,
        transfer_used INTEGER NOT NULL DEFAULT 0,
        record_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID`).run();
      try {
        await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES ('analytics_cutover_at', ?, ?, ?) ON CONFLICT(name) DO NOTHING").bind(String(now()), now(), now()).run();
      } catch { /* Fresh schema initialization may still be creating v2_settings. */ }
    })().then(() => {
      trafficDedupSchemaReady = true;
    }).finally(() => {
      trafficDedupSchemaPromise = null;
    });
  }
  await trafficDedupSchemaPromise;
}

async function stableBatchId(eventIds: string[]) {
  const input = new TextEncoder().encode([...eventIds].sort().join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function trafficStatsStub(env: Env) {
  return env.TRAFFIC_STATS_HUB.get(env.TRAFFIC_STATS_HUB.idFromName("traffic-stats:global"));
}

async function dispatchOutbox(env: Env, row: Record<string, any>) {
  const response = await trafficStatsStub(env).fetch("https://traffic-stats.internal/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batch_id: row.batch_id,
      user_aggregates: typeof row.user_aggregates === "string" ? JSON.parse(row.user_aggregates) : row.user_aggregates,
      server_aggregates: typeof row.server_aggregates === "string" ? JSON.parse(row.server_aggregates) : row.server_aggregates,
      transfer_used: Number(row.transfer_used || 0),
      record_at: Number(row.record_at),
      created_at: Number(row.created_at)
    })
  });
  if (!response.ok) throw new Error(`TrafficStatsHub rejected batch ${row.batch_id}: ${response.status}`);
  await env.XBOARD_DB.prepare("DELETE FROM v2_traffic_stats_outbox WHERE batch_id = ?").bind(row.batch_id).run();
}

async function replayOutbox(env: Env, limit = 100) {
  await ensureTrafficDedupSchema(env);
  const rows = await env.XBOARD_DB.prepare("SELECT * FROM v2_traffic_stats_outbox ORDER BY created_at ASC LIMIT ?").bind(Math.min(500, Math.max(1, limit))).all<Record<string, any>>();
  let delivered = 0;
  for (const row of rows.results || []) {
    await dispatchOutbox(env, row);
    delivered++;
  }
  return delivered;
}

async function materializeTraffic(env: Env, recordAt?: number, force = false) {
  await replayOutbox(env, 500);
  const response = await trafficStatsStub(env).fetch("https://traffic-stats.internal/materialize", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ record_at: recordAt || undefined, force })
  });
  if (!response.ok) throw new Error(`TrafficStatsHub materialization failed: ${response.status}`);
  return response.json();
}

async function saveSetting(env: Env, name: string, value: string) {
  const ts = now();
  await env.XBOARD_DB.prepare(`INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(name, value, ts, ts).run();
}

async function backfillTrafficAnalytics(env: Env, dataset: "user" | "server", limit: number) {
  await ensureTrafficDedupSchema(env);
  const boundedLimit = Math.min(20, Math.max(1, Math.trunc(limit || 20)));
  const cutoverRow = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'analytics_cutover_at'").first<{ value: string }>();
  const cutoff = dayStart(Number(cutoverRow?.value || now()));
  const cursorName = `analytics_backfill_${dataset}_cursor`;
  const completedRow = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = ?").bind(`analytics_backfill_${dataset}_completed_at`).first<{ value: string }>();
  if (completedRow?.value) return { dataset, migrated: 0, cursor: 0, cutoff, done: true };
  const cursorRow = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = ?").bind(cursorName).first<{ value: string }>();
  const cursor = Number(cursorRow?.value || 0);
  const table = dataset === "user" ? "v2_stat_user" : "v2_stat_server";
  const rows = await env.XBOARD_DB.prepare(`SELECT * FROM ${table} WHERE id > ? AND record_at < ? AND COALESCE(record_type, 'd') = 'd' ORDER BY id ASC LIMIT ?`)
    .bind(cursor, cutoff, boundedLimit).all<Record<string, any>>();
  let nextCursor = cursor;
  for (const row of rows.results || []) {
    const recordAt = Number(row.record_at || 0);
    const recordDay = new Date(recordAt * 1000).toISOString().slice(0, 10);
    const serverType = String(row.server_type || "unknown");
    const serverId = Number(row.server_id || 0);
    if (dataset === "user") {
      env.USER_TRAFFIC_ANALYTICS.writeDataPoint({
        indexes: [`user:${Number(row.user_id || 0)}`],
        blobs: [serverType, String(serverId), recordDay, "d1_backfill", "1"],
        doubles: [Number(row.u || 0), Number(row.d || 0), Number(row.server_rate ?? row.rate ?? 1), 1, recordAt]
      });
    } else {
      env.SERVER_TRAFFIC_ANALYTICS.writeDataPoint({
        indexes: [`server:${serverType}:${serverId}`],
        blobs: [serverType, String(serverId), recordDay, "1"],
        doubles: [Number(row.u || 0), Number(row.d || 0), 1, recordAt]
      });
    }
    nextCursor = Number(row.id);
  }
  if (nextCursor !== cursor) await saveSetting(env, cursorName, String(nextCursor));
  const done = (rows.results || []).length < boundedLimit;
  if (done) {
    await saveSetting(env, `analytics_backfill_${dataset}_completed_at`, String(now()));
    const other = dataset === "user" ? "server" : "user";
    const otherDone = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = ?").bind(`analytics_backfill_${other}_completed_at`).first<{ value: string }>();
    if (otherDone?.value) {
      const range = await env.XBOARD_DB.prepare(`SELECT MIN(record_at) AS oldest FROM (
        SELECT record_at FROM v2_stat_user WHERE record_at < ?
        UNION ALL SELECT record_at FROM v2_stat_server WHERE record_at < ?
      )`).bind(cutoff, cutoff).first<{ oldest: number }>();
      await saveSetting(env, "analytics_backfill_start", String(Number(range?.oldest || cutoff)));
      await saveSetting(env, "analytics_backfill_end", String(cutoff));
      await saveSetting(env, "analytics_backfill_completed_at", String(now()));
    }
  }
  return { dataset, migrated: (rows.results || []).length, cursor: nextCursor, cutoff, done };
}

function dayStart(ts = now()) {
  return Math.floor((ts + SHANGHAI_OFFSET) / 86400) * 86400 - SHANGHAI_OFFSET;
}

async function setting(env: Env, name: string) {
  const values = await loadSettings(env.XBOARD_DB, env.XBOARD_KV);
  return values[name] || "";
}

function render(source: string, vars: Record<string, unknown>) {
  return source.replace(/\{\{\s*([^}|]+?)(?:\|([^}]*))?\s*\}\}/g, (match, key: string, fallback: string | undefined) => {
    const value = vars[key.trim()];
    if (value !== undefined && value !== null && value !== "") return String(value);
    return fallback !== undefined ? fallback.trim() : match;
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function safeMailVars(vars: Record<string, unknown>, contentMode: unknown) {
  const safe = Object.fromEntries(Object.entries(vars).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [key, escapeHtml(value)]));
  if (vars.content !== undefined) {
    const content = String(vars.content ?? "");
    safe.content = contentMode === "text" ? escapeHtml(content).replace(/\r?\n/g, "<br>\n") : content;
  }
  return safe;
}

async function resolveMailContent(env: Env, payload: any) {
  const defaults: Record<string, { subject: string; content: string }> = {
    verify: { subject: "{{name}} - 邮箱验证码", content: "您的验证码是：{{code}}。返回 {{url}}" },
    mailLogin: { subject: "登录到 {{name}}", content: "请使用以下链接登录：{{link}}\n\n{{url}}" },
    notify: { subject: "{{name}} - 站点通知", content: "{{content}}\n\n{{url}}" },
    remindExpire: { subject: "{{name}} - 服务即将到期", content: "您的服务即将到期，请及时续费。{{url}}" },
    remindTraffic: { subject: "{{name}} - 流量使用提醒", content: "您的流量使用量已接近上限。{{url}}" }
  };
  const name = String(payload.template_name || "notify");
  const legacyAliases: Record<string, string> = { remindExpire: "remind_expire", remindTraffic: "remind_traffic", remind_expire: "remindExpire", remind_traffic: "remindTraffic" };
  let row = await env.XBOARD_DB.prepare("SELECT subject, content FROM v2_mail_templates WHERE name = ?").bind(name).first<{ subject: string; content: string }>();
  if (!row && legacyAliases[name]) row = await env.XBOARD_DB.prepare("SELECT subject, content FROM v2_mail_templates WHERE name = ?").bind(legacyAliases[name]).first<{ subject: string; content: string }>();
  const template = row || defaults[name] || defaults.notify;
  const templateValue = payload.template_value && typeof payload.template_value === "object" ? payload.template_value : {};
  const flatTemplateVars = Object.fromEntries(Object.entries(templateValue).filter(([key]) => !["vars", "content_mode"].includes(key)));
  const vars = payload.template_value?.vars || payload.vars || flatTemplateVars;
  const renderVars = row ? safeMailVars(vars, payload.template_value?.content_mode || payload.content_mode) : vars;
  const subjectTemplate = row ? template.subject : payload.subject || template.subject;
  const subject = render(String(subjectTemplate || ""), renderVars);
  const renderedContent = render(String(template.content), renderVars);
  const text = row || (!payload.html && !payload.text) ? renderedContent : render(String(payload.text || ""), vars);
  const html = row
    ? renderedContent
    : (!payload.html && !payload.text)
    ? `<div style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.6">${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</div>`
    : payload.html ? render(String(payload.html), vars) : undefined;
  return { ...payload, subject, text: text || undefined, html };
}

async function recordFailure(env: Env, event: any, error: unknown) {
  const ts = now();
  await env.XBOARD_DB.prepare(`INSERT INTO v2_job_logs(event_id, type, status, payload, error, created_at, updated_at)
    VALUES (?, ?, 'failed', ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at
    WHERE v2_job_logs.status NOT LIKE 'done%' AND v2_job_logs.status NOT LIKE 'processing:%'`)
    .bind(event.event_id, event.type || "unknown", JSON.stringify(event), String((error as any)?.message || error), ts, ts).run();
}

async function claimEvent(env: Env, eventId: string, type: string, payload: unknown) {
  const ts = now();
  const claim = `processing:${crypto.randomUUID()}`;
  const result = await env.XBOARD_DB.prepare(`INSERT INTO v2_job_logs(event_id, type, status, payload, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET type = excluded.type, status = excluded.status, payload = excluded.payload,
      error = NULL, updated_at = excluded.updated_at
    WHERE v2_job_logs.status = 'failed'
      OR (v2_job_logs.status LIKE 'processing:%' AND v2_job_logs.updated_at < ?)`)
    .bind(eventId, type, claim, JSON.stringify(payload), ts, ts, ts - 120).run();
  return Number((result.meta as any)?.changes || 0) === 1 ? claim : null;
}

async function failClaim(env: Env, eventId: string, claim: string, error: unknown) {
  await env.XBOARD_DB.prepare("UPDATE v2_job_logs SET status = 'failed', error = ?, updated_at = ? WHERE event_id = ? AND status = ?")
    .bind(String((error as any)?.message || error), now(), eventId, claim).run();
}

async function completeClaim(env: Env, eventId: string, claim: string, statements: D1PreparedStatement[]) {
  const results = await env.XBOARD_DB.batch([
    ...statements,
    env.XBOARD_DB.prepare("UPDATE v2_job_logs SET status = 'done', error = NULL, updated_at = ? WHERE event_id = ? AND status = ?")
      .bind(now(), eventId, claim)
  ]);
  if (Number((results.at(-1)?.meta as any)?.changes || 0) !== 1) throw new Error(`Queue event claim was lost: ${eventId}`);
  return results;
}

async function runOnce(env: Env, eventId: string, type: string, payload: unknown, statements: D1PreparedStatement[]) {
  const claim = await claimEvent(env, eventId, type, payload);
  if (!claim) return null;
  try {
    return await completeClaim(env, eventId, claim, statements);
  } catch (error: any) {
    await failClaim(env, eventId, claim, error);
    throw error;
  }
}

async function trafficCandidates(env: Env, events: any[]) {
  const unique = [...new Map(events.filter(event => event?.event_id).map(event => [String(event.event_id), event])).values()];
  if (!unique.length) return { candidates: [] as any[], staleEventIds: [] as string[] };
  await ensureTrafficDedupSchema(env);
  const ids = unique.map(event => String(event.event_id));
  const completed = await env.XBOARD_DB.prepare(`SELECT event_id FROM v2_traffic_dedup WHERE event_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all<{ event_id: string }>();
  const completedIds = new Set((completed.results || []).map(row => String(row.event_id)));
  const legacyIds = ids.filter(id => !completedIds.has(id));
  const existing = legacyIds.length
    ? await env.XBOARD_DB.prepare(`SELECT event_id, status, updated_at FROM v2_job_logs WHERE event_id IN (${legacyIds.map(() => "?").join(",")})`)
      .bind(...legacyIds).all<{ event_id: string; status: string; updated_at: number }>()
    : { results: [] as { event_id: string; status: string; updated_at: number }[] };
  const rows = new Map((existing.results || []).map(row => [String(row.event_id), row]));
  const staleEventIds: string[] = [];
  const candidates = unique.filter(event => {
    const eventId = String(event.event_id);
    if (completedIds.has(eventId)) return false;
    const row = rows.get(eventId);
    if (!row) return true;
    if (row.status === "done") return false;
    if (String(row.status || "").startsWith("processing:") && Number(row.updated_at || 0) >= now() - 120) return false;
    staleEventIds.push(String(event.event_id));
    return true;
  });
  return { candidates, staleEventIds };
}

function aggregateTrafficEvents(events: any[]) {
  const users = new Map<number, { u: number; d: number }>();
  const userStats = new Map<string, { userId: number; serverId: number; serverType: string; u: number; d: number; rate: number }>();
  const servers = new Map<string, { serverId: number; serverType: string; u: number; d: number }>();
  let transferUsed = 0;

  for (const event of events) {
    const rows = Array.isArray(event.payload) ? event.payload : Array.isArray(event.payload?.data) ? event.payload.data : [event.payload];
    const parsedRate = Number(event.rate);
    const rate = Number.isFinite(parsedRate) ? parsedRate : 1;
    const serverId = Number(event.server_id || 0);
    const serverType = String(event.server_type || "unknown");
    for (const row of rows) {
      const userId = Number(row?.user_id || row?.uid || row?.id);
      if (!userId) continue;
      const rawU = Math.max(0, Math.trunc(Number(row.u || row.upload || 0)));
      const rawD = Math.max(0, Math.trunc(Number(row.d || row.download || 0)));
      if (!rawU && !rawD) continue;
      const u = Math.trunc(rawU * rate);
      const d = Math.trunc(rawD * rate);
      const user = users.get(userId) || { u: 0, d: 0 };
      user.u += u; user.d += d;
      users.set(userId, user);
      transferUsed += u + d;

      const statKey = `${userId}:${serverId}:${serverType}`;
      const userStat = userStats.get(statKey) || { userId, serverId, serverType, u: 0, d: 0, rate };
      userStat.u += u; userStat.d += d; userStat.rate = rate;
      userStats.set(statKey, userStat);

      if (serverId) {
        const serverKey = `${serverId}:${serverType}`;
        const server = servers.get(serverKey) || { serverId, serverType, u: 0, d: 0 };
        server.u += rawU; server.d += rawD;
        servers.set(serverKey, server);
      }
    }
  }
  return { users, userStats, servers, transferUsed };
}

function trafficEventSize(event: any) {
  const payload = event?.payload;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload ? [payload] : [];
  return Math.max(1, rows.length);
}

function splitTrafficEvents(events: any[], maxRows = 250) {
  const normalized: any[] = [];
  for (const event of events) {
    const payload = event?.payload;
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : null;
    if (!rows || rows.length <= maxRows) {
      normalized.push(event);
      continue;
    }
    for (let offset = 0, chunk = 0; offset < rows.length; offset += maxRows, chunk++) {
      normalized.push({
        ...event,
        event_id: `${String(event.event_id)}:chunk:${chunk}`,
        parent_event_id: String(event.event_id),
        payload: rows.slice(offset, offset + maxRows)
      });
    }
  }
  return normalized;
}

function trafficEventGroups(events: any[], maxRows = 250, maxEvents = 25) {
  const groups: any[][] = [];
  let current: any[] = [];
  let rows = 0;
  for (const event of events) {
    const size = trafficEventSize(event);
    if (current.length && (current.length >= maxEvents || rows + size > maxRows)) {
      groups.push(current);
      current = [];
      rows = 0;
    }
    current.push(event);
    rows += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function trafficBatch(env: Env, events: any[]) {
  if (!events.length) return;
  const { candidates, staleEventIds } = await trafficCandidates(env, events);
  if (!candidates.length) return;
  const recordAt = dayStart();
  const aggregate = aggregateTrafficEvents(candidates);
  const ts = now();
  const batchId = await stableBatchId(candidates.map(event => String(event.event_id)));
  const userAggregates = [...aggregate.userStats.values()];
  const serverAggregates = [...aggregate.servers.values()];
  const statements: D1PreparedStatement[] = [];
  for (const eventId of staleEventIds) {
    statements.push(env.XBOARD_DB.prepare("DELETE FROM v2_job_logs WHERE event_id = ? AND status != 'done'").bind(eventId));
  }
  for (const [userId, value] of aggregate.users) {
    statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET u = u + ?, d = d + ?, t = ?, updated_at = ? WHERE id = ?").bind(value.u, value.d, ts, ts, userId));
    statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_pending_check(user_id, updated_at)
      SELECT id, ? FROM v2_user WHERE id = ? AND banned = 0 AND transfer_enable > 0 AND u + d >= transfer_enable
      ON CONFLICT(user_id) DO NOTHING`).bind(ts, userId));
  }
  for (const value of aggregate.servers.values()) {
    statements.push(env.XBOARD_DB.prepare("UPDATE v2_server SET u = u + ?, d = d + ?, updated_at = ? WHERE id = ?").bind(value.u, value.d, ts, value.serverId));
  }
  for (const event of candidates) {
    statements.push(env.XBOARD_DB.prepare("INSERT INTO v2_traffic_dedup(event_id, created_at) VALUES (?, ?)")
      .bind(String(event.event_id), ts));
  }
  statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_stats_outbox(batch_id, event_ids, user_aggregates, server_aggregates, transfer_used, record_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(batch_id) DO NOTHING`)
    .bind(batchId, JSON.stringify(candidates.map(event => String(event.event_id)).sort()), JSON.stringify(userAggregates), JSON.stringify(serverAggregates), aggregate.transferUsed, recordAt, ts));
  await env.XBOARD_DB.batch(statements);
  try {
    await dispatchOutbox(env, { batch_id: batchId, user_aggregates: userAggregates, server_aggregates: serverAggregates, transfer_used: aggregate.transferUsed, record_at: recordAt, created_at: ts });
  } catch (error) {
    console.warn("Traffic statistics retained in Outbox for replay", { batch_id: batchId, error: String((error as Error)?.message || error) });
  }
}

async function traffic(env: Env, event: any) {
  await trafficBatch(env, [event]);
}

async function mail(env: Env, event: any) {
  const claim = await claimEvent(env, event.event_id, "mail", event);
  if (!claim) return;
  let payload = event.payload || {};
  try {
  payload = await resolveMailContent(env, payload);
  const provider = String(await setting(env, "email_driver")).toLowerCase() === "brevo" ? "brevo" : "maileroo";
  const apiKey = (provider === "brevo" ? env.BREVO_API_KEY : env.MAILEROO_API_KEY) || await setting(env, "email_password");
  const fromAddress = await setting(env, "email_from_address");
  const fromName = (await setting(env, "email_username") || await setting(env, "app_name") || "XBoard").trim().replace(/[<>]/g, "");
  const providerName = provider === "brevo" ? "Brevo" : "Maileroo";
  if (!apiKey) throw new Error(`${providerName} API Key 未配置`);
  if (!fromAddress) throw new Error(`${providerName} 发件人地址未配置`);
  const target = payload.to ?? payload.email;
  if (!target || !payload.subject || (!payload.html && !payload.text)) throw new Error("邮件任务参数不完整");
  const recipients: string[] = Array.isArray(target) ? target.map(String) : [String(target)];
  const endpoint = provider === "brevo" ? "https://api.brevo.com/v3/smtp/email" : "https://smtp.maileroo.com/api/v2/emails";
  const response = await fetch(endpoint, provider === "brevo" ? {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json", "idempotency-key": String(event.event_id) },
    body: JSON.stringify({
      sender: { email: fromAddress, name: fromName || undefined },
      to: recipients.map(email => ({ email })),
      subject: String(payload.subject),
      htmlContent: payload.html ? String(payload.html) : undefined,
      textContent: payload.text ? String(payload.text) : undefined
    })
  } : {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json", "idempotency-key": String(event.event_id) },
    body: JSON.stringify({
      from: { address: fromAddress, display_name: fromName || undefined },
      to: recipients.map(address => ({ address })),
      subject: String(payload.subject),
      html: payload.html ? String(payload.html) : undefined,
      plain: payload.text ? String(payload.text) : undefined
    })
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`${providerName} ${response.status}: ${responseText.slice(0, 500)}`);
  let providerId = "";
  try {
    const result = JSON.parse(responseText);
    providerId = String(result?.messageId || result?.data?.reference_id || result?.reference_id || "");
  } catch {}
  const ts = now();
  await completeClaim(env, event.event_id, claim, recipients.map(email =>
    env.XBOARD_DB.prepare("INSERT INTO v2_mail_log(email, subject, template_name, error, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)")
      .bind(email, String(payload.subject), String(payload.template_name || "notify"), ts, ts)
  ));
  } catch (error) {
    const target = payload.to ?? payload.email;
    const recipients = (Array.isArray(target) ? target : target ? [target] : []).map(String);
    const ts = now();
    if (recipients.length) {
      try {
        await env.XBOARD_DB.batch(recipients.map(email => env.XBOARD_DB.prepare("INSERT INTO v2_mail_log(email, subject, template_name, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(email, String(payload.subject || ""), String(payload.template_name || "notify"), String((error as any)?.message || error), ts, ts)));
      } catch (logError) { console.error("Failed to write mail failure log", { error: logError }); }
    }
    await failClaim(env, event.event_id, claim, error);
    throw error;
  }
}

async function telegram(env: Env, event: any) {
  const claim = await claimEvent(env, event.event_id, "telegram", event);
  if (!claim) return;
  try {
  const payload = event.payload || {};
  const botToken = env.TELEGRAM_BOT_TOKEN || await setting(env, "telegram_bot_token");
  const chatId = payload.chat_id || payload.chatId || await setting(env, "telegram_discuss_id");
  if (!botToken || !chatId || !payload.text) throw new Error("Telegram 任务参数不完整");
  const parseMode = String(payload.parse_mode || "Markdown").toLowerCase();
  const text = parseMode === "markdown" ? String(payload.text).replaceAll("_", "\\_") : String(payload.text);
  const telegramBody: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: payload.disable_web_page_preview };
  telegramBody.parse_mode = parseMode === "markdown" ? "Markdown" : payload.parse_mode;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramBody)
  });
  const responseText = await response.text();
  let result: any = null;
  try { result = JSON.parse(responseText); } catch {}
  if (!response.ok || result?.ok !== true) throw new Error(`Telegram ${response.status}: ${String(result?.description || responseText).slice(0, 500)}`);
  await completeClaim(env, event.event_id, claim, []);
  } catch (error) {
    await failClaim(env, event.event_id, claim, error);
    throw error;
  }
}

async function stat(env: Env, event: any) {
  const payload = event.payload || {};
  const recordAt = Number(payload.record_at || dayStart());
  const ts = now();
  const fields = ["user_count", "order_count", "transfer_used", "transfer_used_total", "register_count", "invite_count", "order_total", "paid_total", "paid_count", "commission_total", "commission_count"];
  const values = fields.map(field => payload[field] ?? null);
  const statements = [env.XBOARD_DB.prepare(`INSERT INTO v2_stat(record_at, record_type, ${fields.join(", ")}, created_at, updated_at)
    VALUES (?, 'd', ${fields.map(() => "COALESCE(?, 0)").join(", ")}, ?, ?)
    ON CONFLICT(record_at, record_type) DO UPDATE SET
      ${fields.map(field => `${field} = CASE WHEN ? IS NULL THEN v2_stat.${field} ELSE excluded.${field} END`).join(",\n      ")},
      updated_at = excluded.updated_at`)
    .bind(recordAt, ...values, ts, ts, ...values)];
  await runOnce(env, event.event_id, "stat", event, statements);
}

async function handle(env: Env, event: any) {
  if (!event?.event_id) throw new Error("Queue event is missing event_id");
  if (event.type === "traffic") await traffic(env, event);
  else if (event.type === "mail") await mail(env, event);
  else if (event.type === "telegram") await telegram(env, event);
  else if (event.type === "stat") await stat(env, event);
  else if (event.type === "node_sync") throw new Error("node_sync events must use the xboard-server service binding and cannot be acknowledged by xboard-jobs");
  else throw new Error(`Unsupported queue event type: ${String(event.type || "unknown")}`);
}

export const __test = { dayStart, render, claimEvent, completeClaim, failClaim, ensureTrafficDedupSchema, stableBatchId, aggregateTrafficEvents, splitTrafficEvents, trafficEventGroups, traffic, trafficBatch, trafficCandidates };

export default {
  async fetch(request: Request, env: Env) {
    env = { ...env, XBOARD_DB: primaryDatabase(env.XBOARD_DB) };
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/internal/traffic/replay") return ok({ delivered: await replayOutbox(env, 500) });
    if (request.method === "POST" && path === "/internal/traffic/materialize") {
      const url = new URL(request.url);
      return ok(await materializeTraffic(env, Number(url.searchParams.get("record_at") || 0) || undefined, url.searchParams.get("force") === "1"));
    }
    if (request.method === "POST" && path === "/internal/traffic/flush") {
      await replayOutbox(env, 500);
      const response = await trafficStatsStub(env).fetch("https://traffic-stats.internal/flush", { method: "POST" });
      return new Response(response.body, response);
    }
    if (request.method === "POST" && path === "/internal/traffic/reset") {
      await env.XBOARD_DB.prepare("DELETE FROM v2_traffic_stats_outbox").run();
      const response = await trafficStatsStub(env).fetch("https://traffic-stats.internal/reset", { method: "POST" });
      return new Response(response.body, response);
    }
    if (request.method === "POST" && path === "/internal/analytics/backfill") {
      const url = new URL(request.url);
      const dataset = url.searchParams.get("dataset") === "server" ? "server" : "user";
      return ok(await backfillTrafficAnalytics(env, dataset, Number(url.searchParams.get("limit") || 20)));
    }
    return ok({ service: "xboard-jobs", time: now() });
  },
  async queue(batch: MessageBatch, env: Env) {
    env = { ...env, XBOARD_DB: primaryDatabase(env.XBOARD_DB) };
    const trafficMessages = batch.messages.filter(message => (message.body as any)?.type === "traffic");
    if (trafficMessages.length) {
      try {
        for (const events of trafficEventGroups(splitTrafficEvents(trafficMessages.map(message => message.body as any)))) {
          await trafficBatch(env, events);
        }
        for (const message of trafficMessages) message.ack();
      } catch (error) {
        for (const message of trafficMessages) message.retry();
        console.error("Failed to process traffic queue batch", { error, events: trafficMessages.map(message => (message.body as any)?.event_id) });
      }
    }
    for (const message of batch.messages.filter(message => (message.body as any)?.type !== "traffic")) {
      try {
        await handle(env, message.body);
        message.ack();
      } catch (error) {
        try { await recordFailure(env, message.body, error); }
        catch (logError) { console.error("Failed to record queue error", { error, logError }); }
        message.retry();
      }
    }
  }
};
