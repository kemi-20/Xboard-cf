import type { D1Database } from "./types";
const SETTINGS_CACHE_TTL_MS = 60_000;
let settingsCache: { value: Record<string, unknown>; expiresAt: number } | null = null;
let settingsPromise: Promise<Record<string, unknown>> | null = null;

export function invalidateSettingsCache() {
  settingsCache = null;
  settingsPromise = null;
}
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
export async function list(db: D1Database, table: string, page = 1, pageSize = 20) {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  const offset = Math.max(0, page - 1) * pageSize;
  const rows = await db.prepare(`SELECT * FROM ${safe} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all();
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM ${safe}`).first<{ c: number }>();
  return { data: rows.results || [], total: total?.c || 0, current_page: page, per_page: pageSize };
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
export async function settings(db: D1Database) {
  if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;
  if (!settingsPromise) {
    settingsPromise = db.prepare("SELECT name, value FROM v2_settings").all<{ name: string; value: string }>()
      .then(rows => {
        const value = Object.fromEntries((rows.results || []).map(r => [r.name, parseSettingValue(r.value)]));
        settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
        return value;
      })
      .finally(() => { settingsPromise = null; });
  }
  return settingsPromise;
}
