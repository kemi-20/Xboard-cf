import type { D1Database, KVNamespace } from "./types";
export function primaryDatabase(db: D1Database) {
  return db.withSession("first-primary");
}

export function unconstrainedDatabase(db: D1Database) {
  return db.withSession("first-unconstrained");
}
const SETTINGS_CACHE_TTL_MS = 300_000;
const SETTINGS_VERSION_CHECK_MS = 30_000;
const SETTINGS_SNAPSHOT_TTL_SECONDS = 86_400;
const SETTINGS_CACHE_SCOPE = "edge";
type SettingsCache = { value: Record<string, unknown>; version: string; expiresAt: number; versionCheckedAt: number };
const settingsCaches = new Map<string, SettingsCache>();
const settingsPromises = new Map<string, Promise<Record<string, unknown>>>();

export function invalidateSettingsCache() {
  settingsCaches.clear();
  settingsPromises.clear();
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
export async function settings(db: D1Database, kv?: KVNamespace, memoryScope = "primary") {
  const current = Date.now();
  let settingsCache = settingsCaches.get(memoryScope) || null;
  if (settingsCache && settingsCache.expiresAt > current && (!kv || current - settingsCache.versionCheckedAt < SETTINGS_VERSION_CHECK_MS)) return settingsCache.value;
  let settingsPromise = settingsPromises.get(memoryScope);
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
            const value = JSON.parse(snapshot) as Record<string, unknown>;
            settingsCache = { value, version: version!, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS, versionCheckedAt: Date.now() };
            settingsCaches.set(memoryScope, settingsCache!);
            return value;
          }
        } catch {}
      }
      const rows = await db.prepare("SELECT name, value FROM v2_settings").all<{ name: string; value: string }>();
      const value = Object.fromEntries((rows.results || []).map(r => [r.name, parseSettingValue(r.value)]));
      settingsCache = { value, version: version || "", expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS, versionCheckedAt: Date.now() };
      settingsCaches.set(memoryScope, settingsCache);
      if (availableKv && snapshotKey) {
        try { await availableKv.put(snapshotKey, JSON.stringify(value), { expirationTtl: SETTINGS_SNAPSHOT_TTL_SECONDS }); } catch {}
      }
      return value;
    })()
      .finally(() => { settingsPromises.delete(memoryScope); });
    settingsPromises.set(memoryScope, settingsPromise);
  }
  return settingsPromise;
}
