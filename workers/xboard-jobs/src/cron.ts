import type { D1Database, D1PreparedStatement, Fetcher, KVNamespace, Queue } from "./types.ts";
import { now } from "./compat.ts";
import { primaryDatabase, settings as loadSettings } from "./db.ts";
import { internalAuthHeaders } from "./internal-auth.ts";

export interface CronEnv { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; NOTIFICATION_EVENTS: Queue; XBOARD_SERVER: Fetcher; INTERNAL_SYNC_TOKEN?: string; }

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

function nextServerResetAt(previous: number, after = now()) {
  let candidate = previous;
  for (let attempts = 0; attempts < 120 && candidate <= after; attempts++) {
    const current = shanghaiParts(candidate);
    const month = current.month === 11 ? 0 : current.month + 1;
    const year = current.year + (current.month === 11 ? 1 : 0);
    candidate = shanghaiTimestamp(year, month, Math.min(current.day, daysInMonth(year, month)), current.hour, current.minute, current.second);
  }
  return candidate > after ? candidate : null;
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
    let candidate = shanghaiTimestamp(current.year, current.month, expiry.day, expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    const month = current.month === 11 ? 0 : current.month + 1;
    const year = current.year + (current.month === 11 ? 1 : 0);
    candidate = shanghaiTimestamp(year, month, Math.min(expiry.day, daysInMonth(year, month)), expiry.hour, expiry.minute, expiry.second);
    return candidate;
  }
  if (method === 3) return shanghaiTimestamp(current.year + 1, 0, 1);
  if (method === 4) {
    let candidate = shanghaiTimestamp(current.year, expiry.month, expiry.day, expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    const year = current.year + 1;
    return shanghaiTimestamp(year, expiry.month, Math.min(expiry.day, daysInMonth(year, expiry.month)), expiry.hour, expiry.minute, expiry.second);
  }
  return null;
}

async function optionalKvGet(env: CronEnv, key: string) {
  try { return await env.XBOARD_KV.get(key); } catch { return null; }
}

async function optionalKvPut(env: CronEnv, key: string, value: string, expirationTtl?: number) {
  try { await env.XBOARD_KV.put(key, value, expirationTtl ? { expirationTtl } : undefined); } catch {}
}

async function updateScheduleHeartbeat(env: CronEnv, ts: number) {
  const previous = Number(await optionalKvGet(env, "schedule:last_check_at") || 0);
  if (!previous || ts - previous >= 480) await optionalKvPut(env, "schedule:last_check_at", String(ts), 900);
}

async function setting(env: CronEnv, name: string, fallback = "") {
  const values = await loadSettings(env.XBOARD_DB, env.XBOARD_KV);
  return values[name] ?? fallback;
}

function booleanSetting(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

async function usersByIds(env: CronEnv, ids: number[]) {
  const unique = [...new Set(ids.map(Number).filter(id => id > 0))];
  if (!unique.length) return new Map<number, Record<string, any>>();
  const statements = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100);
    statements.push(env.XBOARD_DB.prepare(`SELECT id, invite_user_id FROM v2_user WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  const results = await env.XBOARD_DB.batch(statements);
  const users = results.flatMap(result => result.results || []) as Record<string, any>[];
  return new Map(users.map(user => [Number(user.id), user]));
}

async function sendReminders(env: CronEnv, ts: number, day: number) {
  const config = await loadSettings(env.XBOARD_DB, env.XBOARD_KV);
  if (!booleanSetting(config.remind_mail_enable)) return;
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
        events.push({ body: { event_id: `mail:remind-expire:${day}:${user.id}`, type: "mail", payload: { to: user.email, template_name: "remindExpire", vars } } });
      }
      const total = Number(user.transfer_enable || 0);
      const ratio = total > 0 ? (Number(user.u || 0) + Number(user.d || 0)) / total : 0;
      const trafficReminderKey = `remind:traffic:${user.id}`;
      if (Number(user.remind_traffic) && ratio >= 0.8 && ratio < 1 && !await optionalKvGet(env, trafficReminderKey)) {
        events.push({ body: { event_id: `mail:remind-traffic:${day}:${user.id}`, type: "mail", payload: { to: user.email, template_name: "remindTraffic", vars } } });
        await optionalKvPut(env, trafficReminderKey, String(ts), 86400);
      }
    }
    for (let start = 0; start < events.length; start += 100) await env.NOTIFICATION_EVENTS.sendBatch(events.slice(start, start + 100));
    cursor = Number(page[page.length - 1].id);
    if (page.length < 500) break;
  }
}

async function checkCommission(env: CronEnv, ts: number) {
  if (booleanSetting(await setting(env, "commission_auto_check_enable", "1"), true)) {
    await env.XBOARD_DB.prepare("UPDATE v2_order SET commission_status = 1 WHERE commission_status = 0 AND invite_user_id IS NOT NULL AND status = 3 AND updated_at <= ?")
      .bind(ts - 3 * 86400).run();
  }
  const settings = {
    distribution: Number(booleanSetting(await setting(env, "commission_distribution_enable", "0"))),
    l1: Number(await setting(env, "commission_distribution_l1", "100")),
    l2: Number(await setting(env, "commission_distribution_l2", "0")),
    l3: Number(await setting(env, "commission_distribution_l3", "0")),
    closeWithdraw: Number(booleanSetting(await setting(env, "withdraw_close_enable", "0")))
  };
  const shares = settings.distribution ? [settings.l1, settings.l2, settings.l3] : [100];
  while (true) {
    const orders = await env.XBOARD_DB.prepare("SELECT id, user_id, invite_user_id, trade_no, total_amount, commission_balance FROM v2_order WHERE commission_status = 1 AND invite_user_id IS NOT NULL ORDER BY id ASC LIMIT 500").all<Record<string, any>>();
    const page = orders.results || [];
    if (!page.length) break;
    const inviters = new Map<number, Record<string, any>>();
    let levelIds = page.map(order => Number(order.invite_user_id || 0)).filter(Boolean);
    for (let depth = 0; depth < shares.length && levelIds.length; depth++) {
      const level = await usersByIds(env, levelIds.filter(id => !inviters.has(id)));
      for (const [id, user] of level) inviters.set(id, user);
      levelIds = [...level.values()].map(user => Number(user.invite_user_id || 0)).filter(Boolean);
    }
    for (const order of page) {
      let inviterId = Number(order.invite_user_id);
      let actual = 0;
      const statements = [];
      for (const share of shares) {
        if (!inviterId) continue;
        const inviter = inviters.get(inviterId);
        if (!inviter) continue;
        const amount = Number(order.commission_balance || 0) * share / 100;
        if (!amount) continue;
        const column = settings.closeWithdraw ? "balance" : "commission_balance";
        statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET ${column} = COALESCE(${column}, 0) + ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM v2_order WHERE id = ? AND commission_status = 1)`)
          .bind(amount, ts, inviter.id, order.id));
        statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_commission_log(invite_user_id, user_id, order_id, trade_no, order_amount, get_amount, amount, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM v2_order WHERE id = ? AND commission_status = 1)`)
          .bind(Number(inviter.id), Number(order.user_id), Number(order.id), String(order.trade_no || ""), Number(order.total_amount || 0), amount, amount, ts, ts, order.id));
        actual += amount;
        inviterId = Number(inviter.invite_user_id || 0);
      }
      statements.push(env.XBOARD_DB.prepare("UPDATE v2_order SET commission_status = 2, actual_commission_balance = ?, updated_at = ? WHERE id = ? AND commission_status = 1").bind(actual, ts, order.id));
      await env.XBOARD_DB.batch(statements);
    }
  }
}

async function resetTraffic(env: CronEnv, ts: number) {
  const systemMethod = Number(await setting(env, "reset_traffic_method", "1"));
  while (true) {
    const users = await env.XBOARD_DB.prepare(`SELECT u.id, u.u, u.d, u.expired_at, u.next_reset_at, u.reset_count, p.id AS plan_exists, p.reset_traffic_method
      FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id
      WHERE u.next_reset_at IS NOT NULL AND u.next_reset_at <= ? AND u.plan_id IS NOT NULL
        AND u.banned = 0 AND (u.expired_at IS NULL OR u.expired_at > ?)
      ORDER BY u.id ASC LIMIT 100`).bind(ts, ts).all<any>();
    if (!(users.results || []).length) break;
    const versionKeys: string[] = [];
    for (const user of users.results || []) {
      if (user.plan_exists === null || user.plan_exists === undefined) {
        await env.XBOARD_DB.prepare("UPDATE v2_user SET next_reset_at = NULL, updated_at = ? WHERE id = ?").bind(ts, user.id).run();
        continue;
      }
      const next = nextResetAt(user, systemMethod, ts + 1);
      const oldU = Number(user.u || 0), oldD = Number(user.d || 0);
      const method = user.reset_traffic_method === null || user.reset_traffic_method === undefined ? systemMethod : Number(user.reset_traffic_method);
      const resetTypes: Record<number, string> = { 0: "first_day_month", 1: "monthly", 3: "first_day_year", 4: "yearly" };
      await env.XBOARD_DB.batch([
        env.XBOARD_DB.prepare("UPDATE v2_user SET u = 0, d = 0, reset_count = COALESCE(reset_count, 0) + 1, last_reset_at = ?, next_reset_at = ?, updated_at = ? WHERE id = ? AND next_reset_at IS NOT NULL AND next_reset_at <= ? AND banned = 0 AND (expired_at IS NULL OR expired_at > ?)")
          .bind(ts, next, ts, user.id, ts, ts),
        env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_reset_logs(user_id, reset_type, old_u, old_d, old_upload, old_download, old_total, new_upload, new_download, new_total, trigger_source, metadata, reset_time, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'cron', ?, ?, ?)`).bind(user.id, resetTypes[method] || "manual", oldU, oldD, oldU, oldD, oldU + oldD, JSON.stringify({ trigger_source: "cron" }), ts, ts)
      ]);
      versionKeys.push(`user_version:${user.id}`);
    }
    await Promise.all(versionKeys.map(key => optionalKvPut(env, key, String(Date.now()))));
  }
  await resetServerTraffic(env, ts);
}

async function resetServerTraffic(env: CronEnv, ts: number) {
  let resetCount = 0;
  while (true) {
    let servers: { id: number; next_reset_at: number }[];
    try {
      const due = await env.XBOARD_DB.prepare(`SELECT id, next_reset_at FROM v2_server
        WHERE transfer_enable > 0 AND next_reset_at IS NOT NULL AND next_reset_at <= ?
        ORDER BY id ASC LIMIT 100`).bind(ts).all<{ id: number; next_reset_at: number }>();
      servers = due.results || [];
    } catch (error) {
      // During a rolling deploy Jobs may run before Edge adds the optional column.
      // Treat only that legacy-schema case as no scheduled server resets.
      if (/no such column:\s*next_reset_at/i.test(String(error))) return 0;
      throw error;
    }
    if (!servers.length) break;
    const statements: D1PreparedStatement[] = [];
    for (const server of servers) {
      const next = nextServerResetAt(Number(server.next_reset_at), ts);
      statements.push(env.XBOARD_DB.prepare(`UPDATE v2_server SET u = 0, d = 0, next_reset_at = ?, updated_at = ?
        WHERE id = ? AND transfer_enable > 0 AND next_reset_at = ? AND next_reset_at <= ?`)
        .bind(next, ts, server.id, server.next_reset_at, ts));
    }
    const results = await env.XBOARD_DB.batch(statements);
    resetCount += results.reduce((total, result) => total + Number((result.meta as any)?.changes || 0), 0);
  }
  if (resetCount > 0) {
    await optionalKvPut(env, "servers_version", String(Date.now()));
    try {
      await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/sync", {
        method: "POST",
        headers: { "content-type": "application/json", ...await internalAuthHeaders(env) },
        body: JSON.stringify({ scope: "all" })
      });
    } catch {
      // Polling and the versioned subscription cache remain the fallback.
    }
  }
  return resetCount;
}

let nextResetBackfillDone = false;

async function repairMissingNextResetAt(env: CronEnv, ts: number) {
  if (nextResetBackfillDone) return;
  const markerName = "system_next_reset_backfill_v1";
  const marker = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = ?").bind(markerName).first<{ value: string }>();
  if (marker?.value === "done") { nextResetBackfillDone = true; return; }
  const cursor = Math.max(0, Number(marker?.value || 0));
  const systemMethod = Number(await setting(env, "reset_traffic_method", "1"));
  const result = await env.XBOARD_DB.prepare(`SELECT u.id, u.expired_at, p.reset_traffic_method
    FROM v2_user u JOIN v2_plan p ON p.id = u.plan_id
    WHERE u.id > ? AND u.next_reset_at IS NULL AND u.banned = 0
      AND (u.expired_at IS NULL OR u.expired_at > ?)
    ORDER BY u.id ASC LIMIT 100`).bind(cursor, ts).all<Record<string, any>>();
  const users = result.results || [];
  const statements: D1PreparedStatement[] = [];
  for (const user of users) {
    const next = nextResetAt(user, systemMethod, ts);
    if (next !== null) statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET next_reset_at = ?, updated_at = ? WHERE id = ? AND next_reset_at IS NULL").bind(next, ts, user.id));
  }
  const value = users.length < 100 ? "done" : String(users[users.length - 1].id);
  statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(markerName, value, ts, ts));
  await env.XBOARD_DB.batch(statements);
  if (value === "done") nextResetBackfillDone = true;
}

async function statistics(env: CronEnv, ts: number, day: number) {
  const recordDay = day - 86400;
  const markerId = `schedule:statistics:${recordDay}`;
  const marker = await env.XBOARD_DB.prepare("SELECT status FROM v2_job_logs WHERE event_id = ?").bind(markerId).first<{ status: string }>();
  if (marker?.status === "done") return;
  const [usersResult, trafficResult, ordersResult, paidResult, commissionsResult, registrationsResult] = await env.XBOARD_DB.batch([
    env.XBOARD_DB.prepare("SELECT COUNT(*) AS user_count FROM v2_user"),
    env.XBOARD_DB.prepare("SELECT COALESCE(SUM(u), 0) + COALESCE(SUM(d), 0) AS transfer_used FROM v2_stat_server WHERE created_at >= ? AND created_at < ?").bind(recordDay, day),
    env.XBOARD_DB.prepare("SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount), 0) AS order_total FROM v2_order WHERE created_at >= ? AND created_at < ?").bind(recordDay, day),
    env.XBOARD_DB.prepare("SELECT COUNT(*) AS paid_count, COALESCE(SUM(total_amount), 0) AS paid_total FROM v2_order WHERE paid_at >= ? AND paid_at < ? AND status NOT IN (0, 2)").bind(recordDay, day),
    env.XBOARD_DB.prepare("SELECT COUNT(*) AS commission_count, COALESCE(SUM(get_amount), 0) AS commission_total FROM v2_commission_log WHERE created_at >= ? AND created_at < ?").bind(recordDay, day),
    env.XBOARD_DB.prepare("SELECT COUNT(*) AS register_count, COALESCE(SUM(CASE WHEN invite_user_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS invite_count FROM v2_user WHERE created_at >= ? AND created_at < ?").bind(recordDay, day)
  ]);
  const users = usersResult.results?.[0] as any;
  const traffic = trafficResult.results?.[0] as any;
  const orders = ordersResult.results?.[0] as any;
  const paid = paidResult.results?.[0] as any;
  const commissions = commissionsResult.results?.[0] as any;
  const registrations = registrationsResult.results?.[0] as any;
  const userCount = Number(users?.user_count || 0);
  const transferUsedTotal = Number(traffic?.transfer_used || 0);
  const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_stat WHERE record_at = ? AND record_type = 'd' ORDER BY id ASC LIMIT 1").bind(recordDay).first<any>();
  if (existing) {
    await env.XBOARD_DB.prepare("UPDATE v2_stat SET user_count = ?, order_count = ?, order_total = ?, paid_count = ?, paid_total = ?, commission_count = ?, commission_total = ?, register_count = ?, invite_count = ?, transfer_used_total = ?, record_type = 'd', updated_at = ? WHERE id = ?")
      .bind(userCount, Number(orders?.order_count || 0), Number(orders?.order_total || 0), Number(paid?.paid_count || 0), Number(paid?.paid_total || 0), Number(commissions?.commission_count || 0), Number(commissions?.commission_total || 0), Number(registrations?.register_count || 0), Number(registrations?.invite_count || 0), transferUsedTotal, ts, existing.id).run();
  } else {
    await env.XBOARD_DB.prepare("INSERT INTO v2_stat(record_at, record_type, user_count, order_count, order_total, paid_count, paid_total, commission_count, commission_total, register_count, invite_count, transfer_used, transfer_used_total, created_at, updated_at) VALUES (?, 'd', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(recordDay, userCount, Number(orders?.order_count || 0), Number(orders?.order_total || 0), Number(paid?.paid_count || 0), Number(paid?.paid_total || 0), Number(commissions?.commission_count || 0), Number(commissions?.commission_total || 0), Number(registrations?.register_count || 0), Number(registrations?.invite_count || 0), 0, transferUsedTotal, ts, ts).run();
  }
  await env.XBOARD_DB.prepare(`INSERT INTO v2_job_logs(event_id, type, status, payload, error, created_at, updated_at)
    VALUES (?, 'schedule', 'done', '{}', NULL, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET status = 'done', error = NULL, updated_at = excluded.updated_at`)
    .bind(markerId, ts, ts).run();
}

let lastOnlineCleanupWarningAt = 0;
const ONLINE_RETENTION_SECONDS = 900;

async function cleanupOnlineStatus(env: CronEnv, ts: number) {
  try {
    await env.XBOARD_DB.prepare("UPDATE v2_user SET online_count = 0 WHERE online_count > 0 AND (last_online_at IS NULL OR last_online_at < ?)").bind(ts - ONLINE_RETENTION_SECONDS).run();
  } catch (error) {
    if (Date.now() - lastOnlineCleanupWarningAt >= 300_000) {
      lastOnlineCleanupWarningAt = Date.now();
      console.warn("Failed to clean stale online status", { error: String((error as Error)?.message || error) });
    }
  }
}

async function checkTickets(env: CronEnv, ts: number) {
  await env.XBOARD_DB.prepare(`UPDATE v2_ticket SET status = 1, updated_at = ?
    WHERE status = 0 AND reply_status = 1 AND updated_at <= ? AND (last_reply_user_id IS NULL OR last_reply_user_id != user_id)`)
    .bind(ts, ts - 86400).run();
}

function addOrderMonths(timestamp: number, months: number) {
  const date = new Date((timestamp + SHANGHAI_OFFSET) * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000) - SHANGHAI_OFFSET;
}

async function openProcessingOrder(env: CronEnv, order: Record<string, any>, ts: number) {
  const [planResult, userResult] = await env.XBOARD_DB.batch<Record<string, any>>([
    env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(order.plan_id),
    env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(order.user_id)
  ]);
  const plan = planResult.results?.[0] || null;
  const user = userResult.results?.[0] || null;
  if (!plan || !user) throw new Error(`Order ${order.trade_no} references a missing user or plan`);

  const period = String(order.period || "");
  const statements = [];
  const orderGuard = "EXISTS (SELECT 1 FROM v2_order WHERE id = ? AND status = 1)";
  if (order.surplus_order_ids) {
    let ids: number[] = [];
    try { ids = JSON.parse(String(order.surplus_order_ids)).map(Number).filter(Boolean); } catch {}
    if (ids.length) statements.push(env.XBOARD_DB.prepare(`UPDATE v2_order SET status = 4, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND ${orderGuard}`).bind(ts, ...ids, order.id));
  }

  const systemMethod = Number(await setting(env, "reset_traffic_method", "1"));
  const eventSetting = Number(order.type) === 1 ? "new_order_event_id" : Number(order.type) === 2 ? "renew_order_event_id" : Number(order.type) === 3 ? "change_order_event_id" : "";
  const orderEventId = eventSetting ? Number(await setting(env, eventSetting, "0")) : 0;
  let resetTraffic = orderEventId === 1;
  let nextReset: number | null = user.next_reset_at == null ? null : Number(user.next_reset_at);
  if (period === "reset_traffic") {
    resetTraffic = true;
    nextReset = nextResetAt({ ...user, reset_traffic_method: plan.reset_traffic_method }, systemMethod, ts);
    statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET u = 0, d = 0, balance = COALESCE(balance, 0) + ?, last_reset_at = ?, next_reset_at = ?, reset_count = COALESCE(reset_count, 0) + 1, updated_at = ? WHERE id = ? AND ${orderGuard}`)
      .bind(Number(order.surplus_credit || 0), ts, nextReset, ts, user.id, order.id));
  } else {
    const transferEnable = Number(plan.transfer_enable || 0) * 1073741824;
    resetTraffic = resetTraffic || period === "onetime" || user.expired_at == null || Number(order.type) === 1;
    let expiredAt: number | null = null;
    if (period !== "onetime") {
      const months: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12, two_yearly: 24, three_yearly: 36 };
      if (!months[period]) throw new Error(`Order ${order.trade_no} has unsupported period ${period}`);
      const base = Number(order.type) === 3 ? ts : Math.max(ts, Number(user.expired_at || 0));
      expiredAt = addOrderMonths(base, months[period]);
    }
    if (resetTraffic) nextReset = nextResetAt({ ...user, expired_at: expiredAt, reset_traffic_method: plan.reset_traffic_method }, systemMethod, ts);
    statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET plan_id = ?, group_id = ?, transfer_enable = ?, speed_limit = ?, device_limit = ?, expired_at = ?, u = ?, d = ?, balance = COALESCE(balance, 0) + ?, last_reset_at = ?, next_reset_at = ?, reset_count = COALESCE(reset_count, 0) + ?, updated_at = ? WHERE id = ? AND ${orderGuard}`)
      .bind(plan.id, plan.group_id, transferEnable, plan.speed_limit ?? null, plan.device_limit ?? null, expiredAt, resetTraffic ? 0 : Number(user.u || 0), resetTraffic ? 0 : Number(user.d || 0), Number(order.surplus_credit || 0), resetTraffic ? ts : user.last_reset_at ?? null, nextReset, resetTraffic ? 1 : 0, ts, user.id, order.id));
  }
  if (resetTraffic) {
    const method = plan.reset_traffic_method === null || plan.reset_traffic_method === undefined ? systemMethod : Number(plan.reset_traffic_method);
    const resetTypes: Record<number, string> = { 0: "first_day_month", 1: "monthly", 3: "first_day_year", 4: "yearly" };
    statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_reset_logs(user_id, reset_type, old_u, old_d, old_upload, old_download, old_total, new_upload, new_download, new_total, trigger_source, metadata, reset_time, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'order', ?, ?, ? WHERE ${orderGuard}`)
      .bind(user.id, resetTypes[method] || "manual", Number(user.u || 0), Number(user.d || 0), Number(user.u || 0), Number(user.d || 0), Number(user.u || 0) + Number(user.d || 0), JSON.stringify({ order_id: order.id, trade_no: order.trade_no, event_id: orderEventId || null }), ts, ts, order.id));
  }
  statements.push(env.XBOARD_DB.prepare("UPDATE v2_order SET status = 3, updated_at = ? WHERE id = ? AND status = 1").bind(ts, order.id));
  const results = await env.XBOARD_DB.batch(statements);
  if (Number((results.at(-1)?.meta as any)?.changes || 0) !== 1) return;
  await optionalKvPut(env, `user_version:${user.id}`, String(ts));
  const authHeaders = await internalAuthHeaders(env);
  if (authHeaders["x-xboard-internal-token"]) {
    try {
      await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/sync", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ scope: "user", user_id: Number(user.id) })
      });
    } catch {}
  }
}

async function checkOrders(env: CronEnv, ts: number) {
  while (true) {
    const expired = await env.XBOARD_DB.prepare("SELECT id, user_id, balance_amount FROM v2_order WHERE status = 0 AND created_at <= ? ORDER BY id ASC LIMIT 200")
      .bind(ts - 7200).all<Record<string, any>>();
    if (!(expired.results || []).length) break;
    for (const order of expired.results || []) {
      const statements = [];
      if (Number(order.balance_amount || 0) > 0) {
        statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET balance = COALESCE(balance, 0) + COALESCE((SELECT balance_amount FROM v2_order WHERE id = ? AND status = 0), 0), updated_at = ? WHERE id = ?")
          .bind(order.id, ts, order.user_id));
      }
      statements.push(env.XBOARD_DB.prepare("UPDATE v2_order SET status = 2, updated_at = ? WHERE id = ? AND status = 0").bind(ts, order.id));
      await env.XBOARD_DB.batch(statements);
    }
  }
  let lastProcessingId = 0;
  while (true) {
    const processing = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE status = 1 AND id > ? ORDER BY id ASC LIMIT 200").bind(lastProcessingId).all<Record<string, any>>();
    const orders = processing.results || [];
    if (!orders.length) break;
    for (const order of orders) {
      lastProcessingId = Number(order.id);
      try { await openProcessingOrder(env, order, ts); }
      catch (error) {
        const message = String((error as any)?.message || error);
        console.error("Failed to open processing order", { trade_no: order.trade_no, error });
        await env.XBOARD_DB.prepare("INSERT INTO v2_job_logs(event_id, type, status, payload, error, created_at, updated_at) VALUES (?, 'order_handle', 'failed', ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET status = 'failed', payload = excluded.payload, error = excluded.error, updated_at = excluded.updated_at")
          .bind(`order:${order.id}`, JSON.stringify({ id: order.id, trade_no: order.trade_no }), message, ts, ts).run();
      }
    }
  }
}

async function checkTrafficExceeded(env: CronEnv) {
  const authHeaders = await internalAuthHeaders(env);
  while (true) {
    const pending = await env.XBOARD_DB.prepare("SELECT u.id, u.banned, u.transfer_enable, u.u, u.d FROM v2_traffic_pending_check p JOIN v2_user u ON u.id = p.user_id ORDER BY p.updated_at ASC LIMIT 1000").all<any>();
    const rows = pending.results || [];
    if (!rows.length) break;
    const ids = rows.filter(row => !Number(row.banned) && Number(row.transfer_enable) > 0 && Number(row.u || 0) + Number(row.d || 0) >= Number(row.transfer_enable)).map(row => Number(row.id));
    if (ids.length) {
      const response = await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/sync", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ scope: "users", user_ids: ids })
      });
      if (!response.ok) throw new Error(`Traffic exceeded sync failed: HTTP ${response.status}`);
    }
    await env.XBOARD_DB.prepare(`DELETE FROM v2_traffic_pending_check WHERE user_id IN (
      SELECT user_id FROM v2_traffic_pending_check ORDER BY updated_at ASC LIMIT 1000
    )`).run();
  }
}

async function resetLogs(env: CronEnv, ts: number) {
  const monthThreshold = (months: number) => {
    const date = new Date((ts + SHANGHAI_OFFSET) * 1000);
    date.setUTCMonth(date.getUTCMonth() - months);
    return Math.floor(date.getTime() / 1000) - SHANGHAI_OFFSET;
  };
  await env.XBOARD_DB.batch([
    env.XBOARD_DB.prepare("DELETE FROM v2_stat_user WHERE record_at < ?").bind(monthThreshold(2)),
    env.XBOARD_DB.prepare("DELETE FROM v2_stat_server WHERE record_at < ?").bind(monthThreshold(2)),
    env.XBOARD_DB.prepare("DELETE FROM v2_admin_audit_log WHERE created_at < ?").bind(monthThreshold(3)),
    env.XBOARD_DB.prepare("DELETE FROM failed_jobs WHERE failed_at < ?").bind(ts - 7 * 86400),
    env.XBOARD_DB.prepare("DELETE FROM v2_job_logs WHERE COALESCE(updated_at, created_at) < ?").bind(ts - 7 * 86400),
    env.XBOARD_DB.prepare("DELETE FROM v2_traffic_dedup WHERE created_at < ?").bind(ts - 7 * 86400)
  ]);
}

async function acquireTaskLock(env: CronEnv, task: string, ts: number) {
  const doClaim = `do:${crypto.randomUUID()}`;
  try {
    const authHeaders = await internalAuthHeaders(env);
    if (authHeaders["x-xboard-internal-token"]) {
      const response = await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/status/locks/acquire", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ name: task, claim: doClaim, timestamp: ts, ttl: 1800 })
      });
      if (response.ok) {
        const result = await response.json() as { data?: { acquired?: boolean } };
        if (result.data?.acquired === true) return doClaim;
        if (result.data?.acquired === false) return null;
      }
    }
  } catch { /* Fall back to D1 so scheduled business tasks remain available. */ }
  const eventId = `schedule:lock:${task}`;
  const claim = `running:d1:${crypto.randomUUID()}`;
  const result = await env.XBOARD_DB.prepare(`INSERT INTO v2_job_logs(event_id, type, status, payload, created_at, updated_at)
    VALUES (?, 'schedule', ?, '{}', ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    WHERE v2_job_logs.status NOT LIKE 'running:%' OR v2_job_logs.updated_at < ?`).bind(eventId, claim, ts, ts, ts - 1800).run();
  return Number((result.meta as any)?.changes || 0) === 1 ? claim : null;
}

async function releaseTaskLock(env: CronEnv, task: string, claim: string, ts: number) {
  if (claim.startsWith("do:")) {
    try {
      const authHeaders = await internalAuthHeaders(env);
      if (authHeaders["x-xboard-internal-token"]) await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/status/locks/release", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ name: task, claim })
      });
    } catch { /* The DO lock expires automatically. */ }
    return;
  }
  await env.XBOARD_DB.prepare("UPDATE v2_job_logs SET status = 'done', updated_at = ? WHERE event_id = ? AND status = ?")
    .bind(ts, `schedule:lock:${task}`, claim).run();
}

function scheduledTasks(ts: number) {
  const time = shanghaiParts(ts);
  return [
    "check:order",
    "check:ticket",
    "check:commission",
    "check:traffic-exceeded",
    "reset:traffic",
    ...(time.minute % 5 === 0 ? ["cleanup:online-status"] : []),
    ...(time.hour === 0 && time.minute === 0 ? ["reset:log"] : []),
    ...(time.hour === 0 && time.minute >= 10 && time.minute < 15 ? ["xboard:statistics"] : []),
    ...(time.hour === 11 && time.minute === 30 ? ["send:remindMail"] : [])
  ];
}

async function run(env: CronEnv, replayOutbox: () => Promise<number>, task = "scheduled") {
  const ts = now();
  await updateScheduleHeartbeat(env, ts);
  if (task === "scheduled" || task === "all") {
    try {
      await replayOutbox();
    } catch (error) {
      console.warn("Traffic statistics Outbox replay deferred", { error: String((error as Error)?.message || error) });
    }
  }
  const day = dayStart(ts);
  const tasks = task === "all"
    ? ["check:order", "check:ticket", "check:commission", "check:traffic-exceeded", "reset:traffic", "cleanup:online-status", "reset:log", "xboard:statistics", "send:remindMail"]
    : task === "scheduled"
      ? scheduledTasks(ts)
      : [task];
  const scheduledClaim = task === "scheduled" ? await acquireTaskLock(env, "scheduled", ts) : null;
  if (task === "scheduled" && !scheduledClaim) return;
  try {
    if (task === "scheduled" || task === "all" || task === "reset:traffic") await repairMissingNextResetAt(env, ts);
    for (const current of tasks) {
      const claim = task === "scheduled" ? null : await acquireTaskLock(env, current, now());
      if (task !== "scheduled" && !claim) continue;
      try {
        if (current === "check:order") await checkOrders(env, ts);
        else if (current === "check:ticket") await checkTickets(env, ts);
        else if (current === "check:commission") await checkCommission(env, ts);
        else if (current === "check:traffic-exceeded") await checkTrafficExceeded(env);
        else if (current === "reset:traffic") await resetTraffic(env, ts);
        else if (current === "cleanup:online-status") await cleanupOnlineStatus(env, ts);
        else if (current === "reset:log") await resetLogs(env, ts);
        else if (current === "xboard:statistics") await statistics(env, ts, day);
        else if (current === "send:remindMail") await sendReminders(env, ts, day);
      } catch (error) {
        console.error("Scheduled task failed", { task: current, error });
        if (task !== "scheduled") throw error;
      } finally {
        if (claim) await releaseTaskLock(env, current, claim, now());
      }
    }
  } finally {
    if (scheduledClaim) await releaseTaskLock(env, "scheduled", scheduledClaim, now());
  }
}

export const cronTest = { dayStart, nextResetAt, nextServerResetAt, resetServerTraffic, addOrderMonths, acquireTaskLock, releaseTaskLock, scheduledTasks, checkTrafficExceeded, cleanupOnlineStatus };

export async function runScheduled<T extends CronEnv>(env: T, replayOutbox: (sessionEnv: T) => Promise<number>) {
  const sessionEnv = { ...env, XBOARD_DB: primaryDatabase(env.XBOARD_DB) } as T;
  await run(sessionEnv, () => replayOutbox(sessionEnv), "scheduled");
}
