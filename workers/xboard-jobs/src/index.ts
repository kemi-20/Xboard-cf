import type { D1Database, MessageBatch } from "./types";
import { now, ok } from "./compat";
export interface Env { XBOARD_DB: D1Database; MAIL_ENDPOINT?: string; TELEGRAM_BOT_TOKEN?: string; }
async function seen(env: Env, event: any) {
  try {
    await env.XBOARD_DB.prepare("INSERT INTO v2_job_logs(event_id, type, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(event.event_id, event.type || "unknown", "processing", JSON.stringify(event), now(), now()).run();
    return false;
  } catch {
    return true;
  }
}
async function traffic(env: Env, event: any) {
  const rows = Array.isArray(event.payload) ? event.payload : Array.isArray(event.payload?.data) ? event.payload.data : [event.payload];
  for (const row of rows) {
    const uid = Number(row.user_id || row.uid || row.id);
    const rate = Number(event.rate || 1);
    const u = Math.round(Number(row.u || row.upload || 0) * rate);
    const d = Math.round(Number(row.d || row.download || 0) * rate);
    if (!uid) continue;
    await env.XBOARD_DB.prepare("UPDATE v2_user SET u = u + ?, d = d + ?, updated_at = ? WHERE id = ?").bind(u, d, now(), uid).run();
    await env.XBOARD_DB.prepare("INSERT INTO v2_stat_user(user_id, server_id, server_type, u, d, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, server_id, server_type, record_at) DO UPDATE SET u = u + excluded.u, d = d + excluded.d, updated_at = excluded.updated_at")
      .bind(uid, event.server_id || 0, event.server_type || "unknown", u, d, Math.floor(now() / 86400) * 86400, now(), now()).run();
    if (event.server_id && event.server_type) {
      await env.XBOARD_DB.prepare("INSERT INTO v2_stat_server(server_id, server_type, u, d, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(server_id, server_type, record_at) DO UPDATE SET u = u + excluded.u, d = d + excluded.d, updated_at = excluded.updated_at")
        .bind(event.server_id, event.server_type, u, d, Math.floor(now() / 86400) * 86400, now(), now()).run();
    }
  }
}
async function handle(env: Env, event: any) {
  if (await seen(env, event)) return;
  try {
    if (event.type === "traffic") await traffic(env, event);
    await env.XBOARD_DB.prepare("UPDATE v2_job_logs SET status = ?, updated_at = ? WHERE event_id = ?").bind("done", now(), event.event_id).run();
  } catch (e: any) {
    await env.XBOARD_DB.prepare("UPDATE v2_job_logs SET status = ?, error = ?, updated_at = ? WHERE event_id = ?").bind("failed", String(e?.message || e), now(), event.event_id).run();
    throw e;
  }
}
export default {
  async fetch() { return ok({ service: "xboard-jobs", time: now() }); },
  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) {
      await handle(env, message.body);
      message.ack();
    }
  }
};
