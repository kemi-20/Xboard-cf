import type { D1Database, KVNamespace } from "./types";
export function primaryDatabase(db: D1Database) {
  return db.withSession("first-primary");
}
const SETTINGS_CACHE_TTL_MS = 300_000;
const SETTINGS_VERSION_CHECK_MS = 30_000;
const SETTINGS_SNAPSHOT_TTL_SECONDS = 86_400;
const SETTINGS_CACHE_SCOPE = "jobs";
const SETTINGS_NAMES = [
  "app_name",
  "email_driver",
  "email_password",
  "email_username",
  "email_from_address",
  "resend_api_key",
  "resend_api_url",
  "resend_from_address",
  "resend_from_name",
  "telegram_bot_token",
  "telegram_discuss_id"
] as const;
let settingsCache: { value: Record<string, string>; version: string; expiresAt: number; versionCheckedAt: number } | null = null;
let settingsPromise: Promise<Record<string, string>> | null = null;
export async function list(db: D1Database, table: string, page = 1, pageSize = 20) {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  const offset = Math.max(0, page - 1) * pageSize;
  const rows = await db.prepare(`SELECT * FROM ${safe} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all();
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM ${safe}`).first<{ c: number }>();
  return { data: rows.results || [], total: total?.c || 0, current_page: page, per_page: pageSize };
}
export async function settings(db: D1Database, kv?: KVNamespace) {
  const current = Date.now();
  if (settingsCache && settingsCache.expiresAt > current && (!kv || current - settingsCache.versionCheckedAt < SETTINGS_VERSION_CHECK_MS)) return settingsCache.value;
  if (!settingsPromise) {
    settingsPromise = (async () => {
      let version: string | null = settingsCache?.version || null;
      let availableKv = kv;
      let kvVersionFailed = false;
      if (availableKv) {
        try { version = await availableKv.get("settings_version"); }
        catch {
          availableKv = undefined;
          kvVersionFailed = true;
        }
      }
      if (!kvVersionFailed && version && settingsCache && settingsCache.expiresAt > Date.now() && settingsCache.version === version) {
        settingsCache.versionCheckedAt = Date.now();
        return settingsCache.value;
      }
      const snapshotKey = version ? `settings:snapshot:${SETTINGS_CACHE_SCOPE}:${version}` : null;
      if (availableKv && snapshotKey) {
        try {
          const snapshot = await availableKv.get(snapshotKey);
          if (snapshot) {
            const value = JSON.parse(snapshot) as Record<string, string>;
            settingsCache = { value, version: version!, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS, versionCheckedAt: Date.now() };
            return value;
          }
        } catch {}
      }
      const placeholders = SETTINGS_NAMES.map(() => "?").join(", ");
      const rows = await db.prepare(`SELECT name, value FROM v2_settings WHERE name IN (${placeholders})`).bind(...SETTINGS_NAMES).all<{ name: string; value: string }>();
      const value = Object.fromEntries((rows.results || []).map(r => [r.name, r.value]));
      settingsCache = { value, version: version || "", expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS, versionCheckedAt: Date.now() };
      if (availableKv && snapshotKey) {
        try { await availableKv.put(snapshotKey, JSON.stringify(value), { expirationTtl: SETTINGS_SNAPSHOT_TTL_SECONDS }); } catch {}
      }
      return value;
    })()
      .finally(() => { settingsPromise = null; });
  }
  return settingsPromise;
}
