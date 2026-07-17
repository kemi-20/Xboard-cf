import type { D1Database } from "./types";

export type InternalAuthEnv = {
  XBOARD_DB: D1Database;
  INTERNAL_SYNC_TOKEN?: string;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function internalToken(env: InternalAuthEnv, forceRefresh = false) {
  const secret = String(env.INTERNAL_SYNC_TOKEN || "").trim();
  if (secret) return secret;
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const result = await env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('internal_sync_token', 'server_token')")
    .all<{ name: string; value: string }>();
  const values = Object.fromEntries((result.results || []).map(row => [row.name, String(row.value || "").trim()]));
  const token = values.internal_sync_token || "";
  if (!token || token === values.server_token) return null;
  cachedToken = { value: token, expiresAt: Date.now() + 300_000 };
  return token;
}

export function invalidateInternalTokenCache() {
  cachedToken = null;
}
