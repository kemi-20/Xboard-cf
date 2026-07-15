import type { D1Database, D1PreparedStatement, KVNamespace, MessageBatch } from "./types.ts";
import { now, ok } from "./compat.ts";
import { settings as loadSettings } from "./db.ts";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; MAILEROO_API_KEY?: string; BREVO_API_KEY?: string; TELEGRAM_BOT_TOKEN?: string; }

const SHANGHAI_OFFSET = 8 * 3600;
let statAggregateSchemaReady = false;

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

async function ensureStatAggregateSchema(env: Env) {
  if (statAggregateSchemaReady) return;
  try {
    if (await env.XBOARD_KV.get("schema:v2_stat_record_type:v1")) {
      statAggregateSchemaReady = true;
      return;
    }
  } catch {}
  await env.XBOARD_DB.prepare("UPDATE v2_stat SET record_type = 'd' WHERE record_type IS NULL OR record_type = ''").run();
  await env.XBOARD_DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_stat_record_type ON v2_stat(record_at, record_type)").run();
  statAggregateSchemaReady = true;
  try { await env.XBOARD_KV.put("schema:v2_stat_record_type:v1", "1"); } catch {}
}

async function resolveMailContent(env: Env, payload: any) {
  const defaults: Record<string, { subject: string; content: string }> = {
    verify: { subject: "{{name}} - 邮箱验证码", content: "您的验证码是：{{code}}。返回 {{url}}" },
    notify: { subject: "{{name}} - 站点通知", content: "{{content}}\n\n{{url}}" },
    remindExpire: { subject: "{{name}} - 服务即将到期", content: "您的服务即将到期，请及时续费。{{url}}" },
    remindTraffic: { subject: "{{name}} - 流量使用提醒", content: "您的流量使用量已接近上限。{{url}}" }
  };
  const name = String(payload.template_name || "notify");
  const legacyAliases: Record<string, string> = { remindExpire: "remind_expire", remindTraffic: "remind_traffic", remind_expire: "remindExpire", remind_traffic: "remindTraffic" };
  let row = await env.XBOARD_DB.prepare("SELECT subject, content FROM v2_mail_templates WHERE name = ?").bind(name).first<{ subject: string; content: string }>();
  if (!row && legacyAliases[name]) row = await env.XBOARD_DB.prepare("SELECT subject, content FROM v2_mail_templates WHERE name = ?").bind(legacyAliases[name]).first<{ subject: string; content: string }>();
  const template = row || defaults[name] || defaults.notify;
  const vars = payload.template_value?.vars || payload.vars || {};
  const subject = render(String(template.subject || ""), vars) || render(String(payload.subject || ""), vars);
  const renderedContent = render(String(template.content), vars);
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

async function signalTrafficPending(env: Env, eventId: string, ts: number) {
  const signalEventId = `traffic-signal:${eventId}`;
  const claim = await claimEvent(env, signalEventId, "traffic_signal", { event_id: eventId, created_at: ts });
  if (!claim) return;
  try {
    await env.XBOARD_KV.put("traffic:pending_check", String(ts), { expirationTtl: 3600 });
    await completeClaim(env, signalEventId, claim, []);
  } catch (error) {
    await failClaim(env, signalEventId, claim, error);
    throw error;
  }
}

async function traffic(env: Env, event: any) {
  await ensureStatAggregateSchema(env);
  const rows = Array.isArray(event.payload) ? event.payload : Array.isArray(event.payload?.data) ? event.payload.data : [event.payload];
  const parsedRate = Number(event.rate);
  const rate = Number.isFinite(parsedRate) ? parsedRate : 1;
  const recordAt = dayStart();
  const users = new Map<number, { u: number; d: number }>();
  let serverU = 0;
  let serverD = 0;
  let userU = 0;
  let userD = 0;

  for (const row of rows) {
    const uid = Number(row?.user_id || row?.uid || row?.id);
    if (!uid) continue;
    const rawU = Math.trunc(Number(row.u || row.upload || 0));
    const rawD = Math.trunc(Number(row.d || row.download || 0));
    const u = Math.trunc(rawU * rate);
    const d = Math.trunc(rawD * rate);
    serverU += rawU;
    serverD += rawD;
    userU += u;
    userD += d;
    const current = users.get(uid) || { u: 0, d: 0 };
    current.u += u; current.d += d;
    users.set(uid, current);
  }

  const ts = now();
  const statements: D1PreparedStatement[] = [];
  const pendingResultIndexes: number[] = [];
  for (const [uid, value] of users) {
    statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET u = u + ?, d = d + ?, t = ?, updated_at = ? WHERE id = ?").bind(value.u, value.d, ts, ts, uid));
    pendingResultIndexes.push(statements.length);
    statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_pending_check(user_id, updated_at)
      SELECT id, ? FROM v2_user WHERE id = ? AND banned = 0 AND transfer_enable > 0 AND u + d >= transfer_enable
      ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`).bind(ts, uid));
    statements.push(env.XBOARD_DB.prepare("INSERT INTO v2_stat_user(user_id, server_id, server_type, u, d, rate, server_rate, record_type, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'd', ?, ?, ?) ON CONFLICT(user_id, server_id, server_type, record_at) DO UPDATE SET u = u + excluded.u, d = d + excluded.d, rate = excluded.rate, server_rate = excluded.server_rate, updated_at = excluded.updated_at")
      .bind(uid, event.server_id || 0, event.server_type || "unknown", value.u, value.d, rate, rate, recordAt, ts, ts));
  }
  if (event.server_id && (serverU || serverD)) {
    statements.push(env.XBOARD_DB.prepare("UPDATE v2_server SET u = u + ?, d = d + ?, updated_at = ? WHERE id = ?").bind(serverU, serverD, ts, event.server_id));
    if (event.server_type) {
      statements.push(env.XBOARD_DB.prepare("INSERT INTO v2_stat_server(server_id, server_type, u, d, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(server_id, server_type, record_at) DO UPDATE SET u = u + excluded.u, d = d + excluded.d, updated_at = excluded.updated_at")
        .bind(event.server_id, event.server_type, serverU, serverD, recordAt, ts, ts));
    }
  }
  if (userU || userD) {
    statements.push(env.XBOARD_DB.prepare("INSERT INTO v2_stat(record_at, record_type, user_count, order_count, transfer_used, created_at, updated_at) VALUES (?, 'd', 0, 0, ?, ?, ?) ON CONFLICT(record_at, record_type) DO UPDATE SET transfer_used = v2_stat.transfer_used + excluded.transfer_used, updated_at = excluded.updated_at")
      .bind(recordAt, userU + userD, ts, ts));
  }
  const results = await runOnce(env, event.event_id, "traffic", event, statements);
  let hasPending = results && pendingResultIndexes.some(index => Number((results[index]?.meta as any)?.changes || 0) > 0);
  if (!results && users.size) {
    const ids = [...users.keys()];
    const row = await env.XBOARD_DB.prepare(`SELECT COUNT(*) AS total FROM v2_traffic_pending_check WHERE user_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).first<{ total: number }>();
    hasPending = Number(row?.total || 0) > 0;
  }
  if (hasPending) {
    await signalTrafficPending(env, event.event_id, ts);
  }
}

async function mail(env: Env, event: any) {
  const claim = await claimEvent(env, event.event_id, "mail", event);
  if (!claim) return;
  try {
  const payload = await resolveMailContent(env, event.payload || {});
  const provider = String(await setting(env, "email_driver")).toLowerCase() === "brevo" ? "brevo" : "maileroo";
  const apiKey = (provider === "brevo" ? env.BREVO_API_KEY : env.MAILEROO_API_KEY) || await setting(env, "email_password");
  const fromAddress = await setting(env, "email_from_address");
  const fromName = (await setting(env, "email_username") || await setting(env, "app_name") || "XBoard").trim().replace(/[<>]/g, "");
  const providerName = provider === "brevo" ? "Brevo" : "Maileroo";
  if (!apiKey) throw new Error(`${providerName} API Key 未配置`);
  if (!fromAddress) throw new Error(`${providerName} 发件人地址未配置`);
  if (!payload.to || !payload.subject || (!payload.html && !payload.text)) throw new Error("邮件任务参数不完整");
  const recipients: string[] = Array.isArray(payload.to) ? payload.to.map(String) : [String(payload.to)];
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
  const parseMode = String(payload.parse_mode || "markdown").toLowerCase();
  const text = parseMode === "markdown" ? String(payload.text).replaceAll("_", "\\_") : String(payload.text);
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: payload.disable_web_page_preview })
  });
  if (!response.ok) throw new Error(`Telegram ${response.status}: ${(await response.text()).slice(0, 500)}`);
  await completeClaim(env, event.event_id, claim, []);
  } catch (error) {
    await failClaim(env, event.event_id, claim, error);
    throw error;
  }
}

async function stat(env: Env, event: any) {
  const payload = event.payload || {};
  const recordAt = Number(payload.record_at || dayStart());
  const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_stat WHERE record_at = ? ORDER BY id ASC LIMIT 1").bind(recordAt).first<any>();
  const ts = now();
  const statements = existing
    ? [env.XBOARD_DB.prepare("UPDATE v2_stat SET user_count = COALESCE(?, user_count), order_count = COALESCE(?, order_count), transfer_used = COALESCE(?, transfer_used), updated_at = ? WHERE id = ?").bind(payload.user_count ?? null, payload.order_count ?? null, payload.transfer_used ?? null, ts, existing.id)]
    : [env.XBOARD_DB.prepare("INSERT INTO v2_stat(record_at, user_count, order_count, transfer_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(recordAt, Number(payload.user_count || 0), Number(payload.order_count || 0), Number(payload.transfer_used || 0), ts, ts)];
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

export const __test = { dayStart, render, claimEvent, completeClaim, failClaim, traffic };

export default {
  async fetch() { return ok({ service: "xboard-jobs", time: now() }); },
  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) {
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
