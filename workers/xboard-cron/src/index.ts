import type { D1Database, Fetcher, KVNamespace, Queue } from "./types";
import { now, ok } from "./compat";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; MAIL_EVENTS: Queue; XBOARD_SERVER: Fetcher; }

const SHANGHAI_OFFSET = 8 * 3600;

function dayStart(ts = now()) {
  return Math.floor((ts + SHANGHAI_OFFSET) / 86400) * 86400 - SHANGHAI_OFFSET;
}

function shanghaiParts(ts: number) {
  const date = new Date((ts + SHANGHAI_OFFSET) * 1000);
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds()
  };
}

function shanghaiTimestamp(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000) - SHANGHAI_OFFSET;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function nextResetAt(user: any, systemMethod: number, from = now()) {
  if (user.expired_at === null || user.expired_at === undefined) return null;
  let method = user.reset_traffic_method === null || user.reset_traffic_method === undefined ? systemMethod : Number(user.reset_traffic_method);
  if (method === 2) return null;
  const current = shanghaiParts(from);
  const expiry = shanghaiParts(Number(user.expired_at));
  if (method === 0) {
    const nextMonth = current.month === 11 ? 0 : current.month + 1;
    const nextYear = current.year + (current.month === 11 ? 1 : 0);
    return shanghaiTimestamp(nextYear, nextMonth, 1);
  }
  if (method === 1) {
    const currentDay = Math.min(expiry.day, daysInMonth(current.year, current.month));
    let candidate = shanghaiTimestamp(current.year, current.month, currentDay, expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    const month = current.month === 11 ? 0 : current.month + 1;
    const year = current.year + (current.month === 11 ? 1 : 0);
    candidate = shanghaiTimestamp(year, month, Math.min(expiry.day, daysInMonth(year, month)), expiry.hour, expiry.minute, expiry.second);
    return candidate;
  }
  if (method === 3) return shanghaiTimestamp(current.year + 1, 0, 1);
  if (method === 4) {
    const currentDay = Math.min(expiry.day, daysInMonth(current.year, expiry.month));
    let candidate = shanghaiTimestamp(current.year, expiry.month, currentDay, expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    const year = current.year + 1;
    return shanghaiTimestamp(year, expiry.month, Math.min(expiry.day, daysInMonth(year, expiry.month)), expiry.hour, expiry.minute, expiry.second);
  }
  return null;
}

async function optionalKvGet(env: Env, key: string) {
  try { return await env.XBOARD_KV.get(key); } catch { return null; }
}

async function optionalKvPut(env: Env, key: string, value: string) {
  try { await env.XBOARD_KV.put(key, value); } catch {}
}

async function setting(env: Env, name: string, fallback = "") {
  const row = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = ?").bind(name).first<{ value: string }>();
  return row?.value ?? fallback;
}

async function sendReminders(env: Env, ts: number, day: number) {
  const settings = await env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('remind_mail_enable', 'app_name', 'app_url')").all<{ name: string; value: string }>();
  const config = Object.fromEntries((settings.results || []).map(row => [row.name, row.value]));
  if (!Number(config.remind_mail_enable || 0)) return;
  let cursor = 0;
  for (;;) {
    const users = await env.XBOARD_DB.prepare(`SELECT id, email, expired_at, transfer_enable, u, d, remind_expire, remind_traffic
      FROM v2_user WHERE id > ? AND banned = 0 AND email IS NOT NULL AND email != '' AND (remind_expire = 1 OR remind_traffic = 1)
      ORDER BY id ASC LIMIT 500`).bind(cursor).all<Record<string, any>>();
    const page = users.results || [];
    if (!page.length) break;
    const events: { body: any }[] = [];
    for (const user of page) {
      const vars = { name: config.app_name || "XBoard", url: config.app_url || "" };
      if (Number(user.remind_expire) && user.expired_at !== null && Number(user.expired_at) > ts && Number(user.expired_at) - 86400 < ts) {
        events.push({ body: { event_id: `mail:remind-expire:${day}:${user.id}`, type: "mail", payload: { to: user.email, template_name: "remind_expire", vars } } });
      }
      const total = Number(user.transfer_enable || 0);
      const ratio = total > 0 ? (Number(user.u || 0) + Number(user.d || 0)) / total : 0;
      if (Number(user.remind_traffic) && ratio >= 0.8 && ratio < 1) {
        events.push({ body: { event_id: `mail:remind-traffic:${day}:${user.id}`, type: "mail", payload: { to: user.email, template_name: "remind_traffic", vars } } });
      }
    }
    for (let start = 0; start < events.length; start += 100) await env.MAIL_EVENTS.sendBatch(events.slice(start, start + 100));
    cursor = Number(page[page.length - 1].id);
    if (page.length < 500) break;
  }
}

async function checkCommission(env: Env, ts: number) {
  if (Number(await setting(env, "commission_auto_check_enable", "1"))) {
    await env.XBOARD_DB.prepare("UPDATE v2_order SET commission_status = 1 WHERE commission_status = 0 AND invite_user_id IS NOT NULL AND status = 3 AND updated_at <= ?")
      .bind(ts - 3 * 86400).run();
  }
  const settings = {
    distribution: Number(await setting(env, "commission_distribution_enable", "0")),
    l1: Number(await setting(env, "commission_distribution_l1", "100")),
    l2: Number(await setting(env, "commission_distribution_l2", "0")),
    l3: Number(await setting(env, "commission_distribution_l3", "0")),
    closeWithdraw: Number(await setting(env, "withdraw_close_enable", "0"))
  };
  const shares = settings.distribution ? [settings.l1, settings.l2, settings.l3] : [100];
  const orders = await env.XBOARD_DB.prepare("SELECT id, user_id, invite_user_id, trade_no, total_amount, commission_balance FROM v2_order WHERE commission_status = 1 AND invite_user_id IS NOT NULL ORDER BY id ASC LIMIT 500").all<Record<string, any>>();
  for (const order of orders.results || []) {
    let inviterId = Number(order.invite_user_id);
    let actual = 0;
    const statements = [];
    for (const share of shares) {
      if (!inviterId || share <= 0) break;
      const inviter = await env.XBOARD_DB.prepare("SELECT id, invite_user_id FROM v2_user WHERE id = ?").bind(inviterId).first<Record<string, any>>();
      if (!inviter) break;
      const amount = Math.trunc(Number(order.commission_balance || 0) * share / 100);
      if (amount > 0) {
        const column = settings.closeWithdraw ? "balance" : "commission_balance";
        statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET ${column} = COALESCE(${column}, 0) + ?, updated_at = ? WHERE id = ?`).bind(amount, ts, inviter.id));
        statements.push(env.XBOARD_DB.prepare("INSERT INTO v2_commission_log(invite_user_id, user_id, order_id, trade_no, order_amount, get_amount, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(Number(inviter.id), Number(order.user_id), Number(order.id), String(order.trade_no || ""), Number(order.total_amount || 0), amount, amount, ts, ts));
        actual += amount;
      }
      inviterId = Number(inviter.invite_user_id || 0);
    }
    statements.push(env.XBOARD_DB.prepare("UPDATE v2_order SET commission_status = 2, actual_commission_balance = ?, updated_at = ? WHERE id = ? AND commission_status = 1").bind(actual, ts, order.id));
    await env.XBOARD_DB.batch(statements);
  }
}

async function resetTraffic(env: Env, ts: number) {
  const systemMethod = Number(await setting(env, "reset_traffic_method", "1"));
  const users = await env.XBOARD_DB.prepare(`SELECT u.id, u.u, u.d, u.expired_at, u.next_reset_at, u.reset_count, p.reset_traffic_method
    FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id
    WHERE u.next_reset_at IS NOT NULL AND u.next_reset_at <= ? AND u.plan_id IS NOT NULL
      AND u.banned = 0 AND (u.expired_at IS NULL OR u.expired_at > ?)`).bind(ts, ts).all<any>();
  for (const user of users.results || []) {
    const next = nextResetAt(user, systemMethod, ts + 1);
    const oldU = Number(user.u || 0), oldD = Number(user.d || 0);
    const method = user.reset_traffic_method === null || user.reset_traffic_method === undefined ? systemMethod : Number(user.reset_traffic_method);
    const resetTypes: Record<number, string> = { 0: "first_day_month", 1: "monthly", 3: "first_day_year", 4: "yearly" };
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("UPDATE v2_user SET u = 0, d = 0, reset_count = COALESCE(reset_count, 0) + 1, last_reset_at = ?, next_reset_at = ?, updated_at = ? WHERE id = ? AND next_reset_at IS NOT NULL AND next_reset_at <= ?")
        .bind(ts, next, ts, user.id, ts),
      env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_reset_logs(user_id, reset_type, old_u, old_d, old_upload, old_download, old_total, new_upload, new_download, new_total, trigger_source, metadata, reset_time, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'cron', ?, ?, ?)`).bind(user.id, resetTypes[method] || "manual", oldU, oldD, oldU, oldD, oldU + oldD, JSON.stringify({ trigger_source: "cron" }), ts, ts)
    ]);
    await optionalKvPut(env, `user_version:${user.id}`, String(Date.now()));
  }
}

async function statistics(env: Env, ts: number, day: number) {
  const last = await optionalKvGet(env, "schedule:last_run:xboard:statistics");
  if (last && dayStart(Number(last)) >= day) return;
  const totals = await env.XBOARD_DB.prepare("SELECT COUNT(*) AS user_count, COALESCE(SUM(u + d), 0) AS transfer_used FROM v2_user").first<any>();
  const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_stat WHERE record_at = ? ORDER BY id ASC LIMIT 1").bind(day).first<any>();
  if (existing) {
    await env.XBOARD_DB.prepare("UPDATE v2_stat SET user_count = ?, transfer_used = ?, updated_at = ? WHERE id = ?").bind(Number(totals?.user_count || 0), Number(totals?.transfer_used || 0), ts, existing.id).run();
  } else {
    await env.XBOARD_DB.prepare("INSERT INTO v2_stat(record_at, user_count, order_count, transfer_used, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)").bind(day, Number(totals?.user_count || 0), Number(totals?.transfer_used || 0), ts, ts).run();
  }
  await optionalKvPut(env, "schedule:last_run:xboard:statistics", String(ts));
}

async function cleanupOnlineStatus(env: Env, ts: number) {
  try {
    await env.XBOARD_DB.prepare("UPDATE v2_user SET online_count = 0 WHERE last_online_at IS NOT NULL AND last_online_at < ?").bind(ts - 600).run();
  } catch {}
  await env.XBOARD_DB.prepare("DELETE FROM v2_server_machine_load_history WHERE COALESCE(recorded_at, created_at) < ?").bind(ts - 86400).run();
  await env.XBOARD_DB.prepare("UPDATE v2_gift_card_code SET status = 2, updated_at = ? WHERE status = 0 AND expires_at IS NOT NULL AND expires_at < ?").bind(ts, ts).run();
}

async function checkTickets(env: Env, ts: number) {
  await env.XBOARD_DB.prepare(`UPDATE v2_ticket SET status = 1, updated_at = ?
    WHERE status = 0 AND reply_status = 1 AND updated_at <= ? AND (last_reply_user_id IS NULL OR last_reply_user_id != user_id)`)
    .bind(ts, ts - 86400).run();
}

async function checkOrders(env: Env, ts: number) {
  await env.XBOARD_DB.prepare("UPDATE v2_order SET status = 2, updated_at = ? WHERE status = 0 AND created_at <= ?")
    .bind(ts, ts - 7200).run();
}

async function checkTrafficExceeded(env: Env) {
  if (!await optionalKvGet(env, "traffic:pending_check")) return;
  try { await env.XBOARD_KV.delete("traffic:pending_check"); } catch {}
  const users = await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE banned = 0 AND transfer_enable > 0 AND u + d >= transfer_enable").all<{ id: number }>();
  const token = await setting(env, "internal_sync_token", await setting(env, "server_token"));
  for (const user of users.results || []) {
    try {
      await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "x-xboard-internal-token": token },
        body: JSON.stringify({ scope: "user", user_id: Number(user.id) })
      });
    } catch {}
  }
}

async function resetLogs(env: Env, ts: number) {
  await env.XBOARD_DB.batch([
    env.XBOARD_DB.prepare("DELETE FROM v2_stat_user WHERE record_at < ?").bind(ts - 62 * 86400),
    env.XBOARD_DB.prepare("DELETE FROM v2_stat_server WHERE record_at < ?").bind(ts - 62 * 86400),
    env.XBOARD_DB.prepare("DELETE FROM v2_admin_audit_log WHERE created_at < ?").bind(ts - 93 * 86400)
  ]);
}

async function run(env: Env, task = "scheduled") {
  const ts = now();
  const day = dayStart(ts);
  const time = shanghaiParts(ts);
  const tasks = task === "all"
    ? ["check:order", "check:ticket", "check:commission", "check:traffic-exceeded", "reset:traffic", "cleanup:online-status", "reset:log", "xboard:statistics", "send:remindMail"]
    : task === "scheduled"
      ? ["check:order", "check:ticket", "check:commission", "check:traffic-exceeded", "reset:traffic",
          ...(time.minute % 5 === 0 ? ["cleanup:online-status"] : []),
          ...(time.hour === 0 && time.minute === 0 ? ["reset:log"] : []),
          ...(time.hour === 0 && time.minute >= 10 && time.minute < 15 ? ["xboard:statistics"] : []),
          ...(time.hour === 11 && time.minute === 30 ? ["send:remindMail"] : [])]
      : [task];
  for (const current of tasks) {
    if (current === "check:order") await checkOrders(env, ts);
    else if (current === "check:ticket") await checkTickets(env, ts);
    else if (current === "check:commission") await checkCommission(env, ts);
    else if (current === "check:traffic-exceeded") await checkTrafficExceeded(env);
    else if (current === "reset:traffic") await resetTraffic(env, ts);
    else if (current === "cleanup:online-status") await cleanupOnlineStatus(env, ts);
    else if (current === "reset:log") await resetLogs(env, ts);
    else if (current === "xboard:statistics") await statistics(env, ts, day);
    else if (current === "send:remindMail") await sendReminders(env, ts, day);
    await optionalKvPut(env, `schedule:last_run:${current}`, String(ts));
  }
}

export const __test = { dayStart, nextResetAt };

export default {
  async fetch(request: Request, env: Env) {
    await run(env, new URL(request.url).searchParams.get("task") || "all");
    return ok({ service: "xboard-cron", time: now() });
  },
  async scheduled(_event: unknown, env: Env) {
    await run(env, "scheduled");
  }
};
