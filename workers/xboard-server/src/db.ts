import type { D1Database } from "./types";
export async function list(db: D1Database, table: string, page = 1, pageSize = 20) {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  const offset = Math.max(0, page - 1) * pageSize;
  const rows = await db.prepare(`SELECT * FROM ${safe} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all();
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM ${safe}`).first<{ c: number }>();
  return { data: rows.results || [], total: total?.c || 0, current_page: page, per_page: pageSize };
}
export async function settings(db: D1Database) {
  const rows = await db.prepare("SELECT name, value FROM v2_settings").all<{ name: string; value: string }>();
  return Object.fromEntries((rows.results || []).map(r => [r.name, r.value]));
}
