import type { D1Database, KVNamespace, Queue } from "./types";
import { now, ok } from "./compat";
export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; MAIL_EVENTS: Queue; }

async function sendReminders(env: Env, ts: number, day: number) {
  const settings = await env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('remind_mail_enable', 'app_name', 'app_url')").all<{ name: string; value: string }>();
  const config = Object.fromEntries((settings.results || []).map(row => [row.name, row.value]));
  if (!Number(config.remind_mail_enable || 0)) return;
  const users = await env.XBOARD_DB.prepare(`SELECT id, email, expired_at, transfer_enable, u, d, remind_expire, remind_traffic
    FROM v2_user WHERE banned = 0 AND email IS NOT NULL AND email != '' AND (remind_expire = 1 OR remind_traffic = 1)`).all<Record<string, any>>();
  const events: { body: any }[] = [];
  for (const user of users.results || []) {
    const vars = { name: config.app_name || "XBoard", url: config.app_url || "" };
    if (Number(user.remind_expire) && user.expired_at !== null && Number(user.expired_at) > ts && Number(user.expired_at) - 86400 < ts) {
      events.push({ body: { event_id: `mail:remind-expire:${day}:${user.id}`, type: "mail", payload: { to: user.email, subject: `The service in ${vars.name} is about to expire`, template_name: "remind_expire", vars } } });
    }
    const total = Number(user.transfer_enable || 0);
    if (Number(user.remind_traffic) && total > 0 && (Number(user.u || 0) + Number(user.d || 0)) / total >= 0.8) {
      events.push({ body: { event_id: `mail:remind-traffic:${day}:${user.id}`, type: "mail", payload: { to: user.email, subject: `The traffic usage in ${vars.name} has reached 80%`, template_name: "remind_traffic", vars } } });
    }
  }
  for (let start = 0; start < events.length; start += 100) await env.MAIL_EVENTS.sendBatch(events.slice(start, start + 100));
}

async function run(env: Env, task = "manual") {
  const ts = now();
  const day = Math.floor(ts / 86400) * 86400;
  await env.XBOARD_KV.put(`schedule:last_run:${task}`, String(ts));
  await env.XBOARD_DB.prepare("UPDATE v2_user SET banned = 1, updated_at = ? WHERE expired_at IS NOT NULL AND expired_at > 0 AND expired_at < ?").bind(ts, ts).run();
  await env.XBOARD_DB.prepare("UPDATE v2_user SET banned = 1, updated_at = ? WHERE transfer_enable > 0 AND (u + d) >= transfer_enable").bind(ts).run();
  try {
    await env.XBOARD_DB.prepare("UPDATE v2_user SET u = 0, d = 0, reset_count = reset_count + 1, last_reset_at = ?, updated_at = ? WHERE next_reset_at IS NOT NULL AND next_reset_at <= ?")
      .bind(ts, ts, ts).run();
  } catch {
    // Older databases may not have reset columns until schema migration is applied.
  }
  const lastStat = await env.XBOARD_KV.get("schedule:last_run:xboard:statistics");
  if (!lastStat || Math.floor(Number(lastStat) / 86400) * 86400 < day) {
    await env.XBOARD_DB.prepare("INSERT INTO v2_stat(record_at, user_count, transfer_used, created_at, updated_at) SELECT ?, COUNT(*), COALESCE(SUM(u + d), 0), ?, ? FROM v2_user").bind(day, ts, ts).run();
    await env.XBOARD_KV.put("schedule:last_run:xboard:statistics", String(ts));
  }
  await sendReminders(env, ts, day);
}
export default {
  async fetch(request: Request, env: Env) {
    await run(env, new URL(request.url).searchParams.get("task") || "manual");
    return ok({ service: "xboard-cron", time: now() });
  },
  async scheduled(_event: unknown, env: Env) {
    await run(env, "scheduled");
  }
};
