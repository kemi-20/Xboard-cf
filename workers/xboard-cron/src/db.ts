import type { D1Database, KVNamespace } from "./types";
const SETTINGS_CACHE_TTL_MS = 300_000;
const SETTINGS_VERSION_CHECK_MS = 30_000;
const SETTINGS_SNAPSHOT_TTL_SECONDS = 86_400;
const SETTINGS_CACHE_SCOPE = "cron";
const SETTINGS_NAMES = [
  "app_name",
  "app_url",
  "commission_auto_check_enable",
  "commission_distribution_enable",
  "commission_distribution_l1",
  "commission_distribution_l2",
  "commission_distribution_l3",
  "internal_sync_token",
  "remind_mail_enable",
  "reset_traffic_method",
  "server_token",
  "withdraw_close_enable"
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
      let version = settingsCache?.version || "0";
      let availableKv = kv;
      if (availableKv) {
        try { version = await availableKv.get("settings_version") || "0"; }
        catch {
          availableKv = undefined;
          if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;
        }
      }
      if (settingsCache && settingsCache.expiresAt > Date.now() && settingsCache.version === version) {
        settingsCache.versionCheckedAt = Date.now();
        return settingsCache.value;
      }
      const snapshotKey = `settings:snapshot:${SETTINGS_CACHE_SCOPE}:${version}`;
      if (availableKv) {
        try {
          const snapshot = await availableKv.get(snapshotKey);
          if (snapshot) {
            const value = JSON.parse(snapshot) as Record<string, string>;
            settingsCache = { value, version, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS, versionCheckedAt: Date.now() };
            return value;
          }
        } catch {}
      }
      const placeholders = SETTINGS_NAMES.map(() => "?").join(", ");
      const rows = await db.prepare(`SELECT name, value FROM v2_settings WHERE name IN (${placeholders})`).bind(...SETTINGS_NAMES).all<{ name: string; value: string }>();
      const value = Object.fromEntries((rows.results || []).map(r => [r.name, r.value]));
      settingsCache = { value, version, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS, versionCheckedAt: Date.now() };
      if (availableKv) {
        try { await availableKv.put(snapshotKey, JSON.stringify(value), { expirationTtl: SETTINGS_SNAPSHOT_TTL_SECONDS }); } catch {}
      }
      return value;
    })()
      .finally(() => { settingsPromise = null; });
  }
  return settingsPromise;
}
