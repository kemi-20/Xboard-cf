import type { D1Database, D1PreparedStatement, MessageBatch } from "./types";
import { now, ok } from "./compat";

export interface Env { XBOARD_DB: D1Database; MAIL_ENDPOINT?: string; TELEGRAM_BOT_TOKEN?: string; }

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
  const rate = Number(event.rate || 1);
  const recordAt = Math.floor(now() / 86400) * 86400;
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
      env.XBOARD_DB.prepare("UPDATE v2_user SET u = u + ?, d = d + ?, updated_at = ? WHERE id = ?").bind(u, d, ts, uid),
      env.XBOARD_DB.prepare("INSERT INTO v2_stat_user(user_id, server_id, server_type, u, d, rate, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, server_id, server_type, record_at) DO UPDATE SET u = u + excluded.u, d = d + excluded.d, rate = excluded.rate, updated_at = excluded.updated_at")
        .bind(uid, event.server_id || 0, event.server_type || "unknown", u, d, rate, recordAt, ts, ts)
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
}

async function handle(env: Env, event: any) {
  if (!event?.event_id) throw new Error("Queue event is missing event_id");
  if (event.type === "traffic") await traffic(env, event);
  else await runOnce(env, event.event_id, event.type || "unknown", event, []);
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
