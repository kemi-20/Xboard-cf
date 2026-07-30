import type { D1Database, KVNamespace } from "./types";
export function primaryDatabase(db: D1Database) {
  return db.withSession("first-primary");
}

// Kept as a compatibility hook for migration and tests. Edge settings are no
// longer cached, so invalidation intentionally has no work to do.
export function invalidateSettingsCache() {}
export function parseSettingValue(value: unknown) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try { return JSON.parse(text); } catch { return value; }
  }
  return value;
}

export async function freshSettings(db: D1Database) {
  const result = await db.prepare("SELECT name, value FROM v2_settings").all<{ name: string; value: string }>();
  return Object.fromEntries((result.results || []).map(row => [row.name, parseSettingValue(row.value)]));
}

export async function list(db: D1Database, table: string, page = 1, pageSize = 20) {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  const offset = Math.max(0, page - 1) * pageSize;
  const [rows, total] = await db.batch([
    db.prepare(`SELECT * FROM ${safe} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset),
    db.prepare(`SELECT COUNT(*) AS c FROM ${safe}`)
  ]);
  return { data: rows.results || [], total: Number((total.results?.[0] as { c?: number } | undefined)?.c || 0), current_page: page, per_page: pageSize };
}
export async function rows(db: D1Database, table: string, limit = 500) {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  let result;
  try {
    result = await db.prepare(`SELECT * FROM ${safe} ORDER BY sort DESC, id DESC LIMIT ?`).bind(limit).all();
  } catch {
    result = await db.prepare(`SELECT * FROM ${safe} ORDER BY id DESC LIMIT ?`).bind(limit).all();
  }
  return result.results || [];
}
export async function settings(db: D1Database, kv?: KVNamespace, memoryScope = "primary") {
  void kv;
  void memoryScope;
  return freshSettings(db);
}
