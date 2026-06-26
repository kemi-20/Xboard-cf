import type { D1Database, KVNamespace, Queue } from "./types";
import { now, ok } from "./compat";
export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; MAIL_EVENTS: Queue; }
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
