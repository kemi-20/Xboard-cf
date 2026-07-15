import type { D1Database, D1PreparedStatement, KVNamespace, MessageBatch } from "./types";
import { now, ok } from "./compat";
import { settings as loadSettings } from "./db";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; MAILEROO_API_KEY?: string; BREVO_API_KEY?: string; TELEGRAM_BOT_TOKEN?: string; }

const SHANGHAI_OFFSET = 8 * 3600;

function dayStart(ts = now()) {
  return Math.floor((ts + SHANGHAI_OFFSET) / 86400) * 86400 - SHANGHAI_OFFSET;
}

async function setting(env: Env, name: string) {
  const values = await loadSettings(env.XBOARD_DB);
  return values[name] || "";
}

function render(source: string, vars: Record<string, unknown>) {
  return source.replace(/\{\{\s*([^}|]+?)(?:\|([^}]*))?\s*\}\}/g, (_match, key: string, fallback: string | undefined) => String(vars[key.trim()] ?? fallback?.trim() ?? ""));
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
  const vars = payload.vars || {};
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

async function alreadyDone(env: Env, eventId: string) {
  const existing = await env.XBOARD_DB.prepare("SELECT status FROM v2_job_logs WHERE event_id = ?").bind(eventId).first<{ status: string }>();
  return existing?.status === "done";
}

async function recordFailure(env: Env, event: any, error: unknown) {
  const ts = now();
  await env.XBOARD_DB.prepare("INSERT INTO v2_job_logs(event_id, type, status, payload, error, created_at, updated_at) VALUES (?, ?, 'failed', ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at")
    .bind(event.event_id, event.type || "unknown", JSON.stringify(event), String((error as any)?.message || error), ts, ts).run();
}

async function runOnce(env: Env, eventId: string, type: string, payload: unknown, statements: D1PreparedStatement[]) {
  const existing = await env.XBOARD_DB.prepare("SELECT status FROM v2_job_logs WHERE event_id = ?").bind(eventId).first<{ status: string }>();
  if (existing?.status === "done") return false;
  if (existing) await env.XBOARD_DB.prepare("DELETE FROM v2_job_logs WHERE event_id = ?").bind(eventId).run();
  const ts = now();
  try {
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("INSERT INTO v2_job_logs(event_id, type, status, payload, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)")
        .bind(eventId, type, JSON.stringify(payload), ts, ts),
      ...statements
    ]);
    return true;
  } catch (error: any) {
    const completed = await env.XBOARD_DB.prepare("SELECT status FROM v2_job_logs WHERE event_id = ?").bind(eventId).first<{ status: string }>();
    if (completed?.status === "done") return false;
    await env.XBOARD_DB.prepare("INSERT INTO v2_job_logs(event_id, type, status, payload, error, created_at, updated_at) VALUES (?, ?, 'failed', ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at")
      .bind(eventId, type, JSON.stringify(payload), String(error?.message || error), ts, now()).run();
    throw error;
  }
}

async function traffic(env: Env, event: any) {
  const rows = Array.isArray(event.payload) ? event.payload : Array.isArray(event.payload?.data) ? event.payload.data : [event.payload];
  const parsedRate = Number(event.rate);
  const rate = Number.isFinite(parsedRate) ? parsedRate : 1;
  const recordAt = dayStart();
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
    const ts = now();
    await runOnce(env, `${event.event_id}:user:${uid}`, "traffic:user", row, [
      env.XBOARD_DB.prepare("UPDATE v2_user SET u = u + ?, d = d + ?, t = ?, updated_at = ? WHERE id = ?").bind(u, d, ts, ts, uid),
      env.XBOARD_DB.prepare("INSERT INTO v2_traffic_pending_check(user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at").bind(uid, ts),
      env.XBOARD_DB.prepare("INSERT INTO v2_stat_user(user_id, server_id, server_type, u, d, rate, server_rate, record_type, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'd', ?, ?, ?) ON CONFLICT(user_id, server_id, server_type, record_at) DO UPDATE SET u = u + excluded.u, d = d + excluded.d, rate = excluded.rate, server_rate = excluded.server_rate, updated_at = excluded.updated_at")
        .bind(uid, event.server_id || 0, event.server_type || "unknown", u, d, rate, rate, recordAt, ts, ts)
    ]);
  }

  const ts = now();
  const aggregate: D1PreparedStatement[] = [];
  if (event.server_id && (serverU || serverD)) {
    aggregate.push(env.XBOARD_DB.prepare("UPDATE v2_server SET u = u + ?, d = d + ?, updated_at = ? WHERE id = ?").bind(serverU, serverD, ts, event.server_id));
    if (event.server_type) {
      aggregate.push(env.XBOARD_DB.prepare("INSERT INTO v2_stat_server(server_id, server_type, u, d, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(server_id, server_type, record_at) DO UPDATE SET u = u + excluded.u, d = d + excluded.d, updated_at = excluded.updated_at")
        .bind(event.server_id, event.server_type, serverU, serverD, recordAt, ts, ts));
    }
  }
  if (userU || userD) {
    aggregate.push(env.XBOARD_DB.prepare("UPDATE v2_stat SET transfer_used = transfer_used + ?, updated_at = ? WHERE record_at = ?")
      .bind(userU + userD, ts, recordAt));
    aggregate.push(env.XBOARD_DB.prepare("INSERT INTO v2_stat(record_at, user_count, order_count, transfer_used, created_at, updated_at) SELECT ?, 0, 0, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM v2_stat WHERE record_at = ?)")
      .bind(recordAt, userU + userD, ts, ts, recordAt));
  }
  await runOnce(env, event.event_id, "traffic", event, aggregate);
  try {
    await env.XBOARD_KV.put("traffic:pending_check", String(ts), { expirationTtl: 3600 });
  } catch {}
}

async function mail(env: Env, event: any) {
  if (await alreadyDone(env, event.event_id)) return;
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
  await runOnce(env, event.event_id, "mail", { ...event, provider, provider_id: providerId }, recipients.map(email =>
    env.XBOARD_DB.prepare("INSERT INTO v2_mail_log(email, subject, template_name, error, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)")
      .bind(email, String(payload.subject), String(payload.template_name || "notify"), ts, ts)
  ));
}

async function telegram(env: Env, event: any) {
  const payload = event.payload || {};
  const botToken = env.TELEGRAM_BOT_TOKEN || await setting(env, "telegram_bot_token");
  const chatId = payload.chat_id || payload.chatId || await setting(env, "telegram_discuss_id");
  if (!botToken || !chatId || !payload.text) throw new Error("Telegram 任务参数不完整");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(payload.text), parse_mode: payload.parse_mode, disable_web_page_preview: payload.disable_web_page_preview })
  });
  if (!response.ok) throw new Error(`Telegram ${response.status}: ${(await response.text()).slice(0, 500)}`);
  await runOnce(env, event.event_id, "telegram", event, []);
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
  else if (event.type === "node_sync") await runOnce(env, event.event_id, "node_sync", { ...event, skipped: "Use the xboard-server service binding for synchronous node updates" }, []);
  else await runOnce(env, event.event_id, event.type || "unknown", event, []);
}

export const __test = { dayStart, render };

export default {
  async fetch() { return ok({ service: "xboard-jobs", time: now() }); },
  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) {
      try {
        await handle(env, message.body);
        message.ack();
      } catch (error) {
        await recordFailure(env, message.body, error);
        message.retry();
      }
    }
  }
};
