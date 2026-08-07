import type { D1Database } from "./types.ts";
export function replicaDatabase(db: D1Database) {
  return db.withSession("first-unconstrained");
}
const SETTINGS_NAMES = [
  "app_name",
  "app_url",
  "show_info_to_server_enable",
  "show_protocol_to_server_enable",
  "subscribe_path",
  "subscribe_url"
] as const;
export async function settings(db: D1Database) {
  const placeholders = SETTINGS_NAMES.map(() => "?").join(", ");
  const rows = await db.prepare(`SELECT name, value FROM v2_settings WHERE name IN (${placeholders})`).bind(...SETTINGS_NAMES).all<{ name: string; value: string }>();
  return Object.fromEntries((rows.results || []).map(row => [row.name, row.value]));
}
