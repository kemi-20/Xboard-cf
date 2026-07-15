import type { D1Database } from "./types";
const SETTINGS_CACHE_TTL_MS = 60_000;
const SETTINGS_NAMES = [
  "app_name",
  "email_from_address",
  "resend_api_key",
  "resend_api_url",
  "resend_from_address",
  "resend_from_name",
  "telegram_bot_token",
  "telegram_discuss_id"
] as const;
let settingsCache: { value: Record<string, string>; expiresAt: number } | null = null;
let settingsPromise: Promise<Record<string, string>> | null = null;
export async function list(db: D1Database, table: string, page = 1, pageSize = 20) {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  const offset = Math.max(0, page - 1) * pageSize;
  const rows = await db.prepare(`SELECT * FROM ${safe} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all();
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM ${safe}`).first<{ c: number }>();
  return { data: rows.results || [], total: total?.c || 0, current_page: page, per_page: pageSize };
}
export async function settings(db: D1Database) {
  if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;
  if (!settingsPromise) {
    const placeholders = SETTINGS_NAMES.map(() => "?").join(", ");
    settingsPromise = db.prepare(`SELECT name, value FROM v2_settings WHERE name IN (${placeholders})`).bind(...SETTINGS_NAMES).all<{ name: string; value: string }>()
      .then(rows => {
        const value = Object.fromEntries((rows.results || []).map(r => [r.name, r.value]));
        settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
        return value;
      })
      .finally(() => { settingsPromise = null; });
  }
  return settingsPromise;
}
