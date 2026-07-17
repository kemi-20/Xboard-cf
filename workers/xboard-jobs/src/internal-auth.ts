import type { D1Database } from "./types.ts";

export type InternalAuthEnv = {
  XBOARD_DB: D1Database;
  INTERNAL_SYNC_TOKEN?: string;
};

let cachedDatabaseToken: { value: string; expiresAt: number } | null = null;

function generatedToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function internalSyncToken(env: InternalAuthEnv, create = true) {
  const secret = String(env.INTERNAL_SYNC_TOKEN || "").trim();
  if (secret) return secret;
  if (cachedDatabaseToken && cachedDatabaseToken.expiresAt > Date.now()) return cachedDatabaseToken.value;

  const result = await env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('internal_sync_token', 'server_token')")
    .all<{ name: string; value: string }>();
  const values = Object.fromEntries((result.results || []).map(row => [row.name, String(row.value || "").trim()]));
  let token = values.internal_sync_token || "";
  const serverToken = values.server_token || "";
  if (token && token !== serverToken) {
    cachedDatabaseToken = { value: token, expiresAt: Date.now() + 300_000 };
    return token;
  }
  if (!create) return "";

  const candidate = generatedToken();
  const timestamp = Math.floor(Date.now() / 1000);
  if (token) {
    await env.XBOARD_DB.prepare("UPDATE v2_settings SET value = ?, updated_at = ? WHERE name = 'internal_sync_token' AND value = ?")
      .bind(candidate, timestamp, token).run();
  } else {
    await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES ('internal_sync_token', ?, ?, ?) ON CONFLICT(name) DO NOTHING")
      .bind(candidate, timestamp, timestamp).run();
  }
  const stored = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'internal_sync_token'").first<{ value: string }>();
  token = String(stored?.value || "").trim();
  if (!token || token === serverToken) throw new Error("A distinct internal synchronization token is unavailable");
  cachedDatabaseToken = { value: token, expiresAt: Date.now() + 300_000 };
  return token;
}

export function invalidateInternalTokenCache() {
  cachedDatabaseToken = null;
}
