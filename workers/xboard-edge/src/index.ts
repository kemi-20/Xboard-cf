import type { D1Database, D1PreparedStatement, ExecutionContext, Fetcher, KVNamespace, Queue } from "./types";
import { body, fail, json, now, ok, randomString, token, uuid } from "./compat";
import { createSession, currentUser, hashPassword, sessionTokenDigest, verifyPassword } from "./auth";
import { invalidateSettingsCache, list, primaryDatabase, rows, settings, unconstrainedDatabase } from "./db";
import { bump } from "./kv";
import { handleAdminGiftCard, handleUserGiftCard } from "./gift-card";
import { authorizeMigration, handleAdminMigration } from "./migration";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { handleSubscriptionRequest } from "./subscription/index.ts";
import { analyticsData } from "./analytics.ts";

export interface Env {
  XBOARD_DB: D1Database;
  SUBSCRIPTION_DB?: D1Database;
  XBOARD_KV: KVNamespace;
  ASSETS: Fetcher;
  XBOARD_SERVER: Fetcher;
  XBOARD_JOBS: Fetcher;
  NOTIFICATION_EVENTS: Queue;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
  PUBLIC_READ_DB?: D1Database;
  SETTINGS_MEMORY_SCOPE?: string;
}

const responseDataCache = new Map<string, { value: unknown; expiresAt: number }>();
let storageOptimizationReady = false;
let analyticsCutoverCache: { live: number; backfillStart: number; backfillEnd: number; expiresAt: number } | null = null;
let trafficMaterializedAt = 0;

async function cachedData<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const current = Date.now();
  const memory = responseDataCache.get(key);
  if (memory && memory.expiresAt > current) return memory.value as T;
  const cache = (globalThis as any).caches?.default;
  const request = new Request(`https://xboard-cache.internal/${encodeURIComponent(key)}`);
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        const value = await hit.json() as T;
        responseDataCache.set(key, { value, expiresAt: current + ttlSeconds * 1000 });
        return value;
      }
    } catch {}
  }
  const value = await loader();
  responseDataCache.set(key, { value, expiresAt: current + ttlSeconds * 1000 });
  if (cache) {
    try {
      await cache.put(request, new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` }
      }));
    } catch {}
  }
  return value;
}

async function analyticsCutover(env: Env) {
  if (analyticsCutoverCache && analyticsCutoverCache.expiresAt > Date.now()) return analyticsCutoverCache;
  const rows = await env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('analytics_cutover_at','analytics_backfill_start','analytics_backfill_end')").all<{ name: string; value: string }>();
  const values = Object.fromEntries((rows.results || []).map(row => [row.name, Number(row.value || 0)]));
  analyticsCutoverCache = {
    live: Number(values.analytics_cutover_at || Number.MAX_SAFE_INTEGER),
    backfillStart: Number(values.analytics_backfill_start || 0),
    backfillEnd: Number(values.analytics_backfill_end || 0),
    expiresAt: Date.now() + 300_000
  };
  return analyticsCutoverCache;
}

async function analyticsRangeAvailable(env: Env, start: number, end: number) {
  const coverage = await analyticsCutover(env);
  return start >= coverage.live || (coverage.backfillStart > 0 && start >= coverage.backfillStart && end <= coverage.backfillEnd);
}

async function materializeCurrentTraffic(env: Env) {
  if (Date.now() - trafficMaterializedAt < 300_000) return;
  const response = await env.XBOARD_JOBS.fetch(`https://xboard-jobs.internal/internal/traffic/materialize?record_at=${dayStart()}`, { method: "POST" });
  if (!response.ok) throw new Error(`Traffic statistics materialization failed (${response.status})`);
  trafficMaterializedAt = Date.now();
}

async function ensureStorageOptimization(env: Env) {
  if (storageOptimizationReady) return;
  const markerKey = "bootstrap:storage:v3";
  if (await optionalKvGet(env, markerKey)) {
    storageOptimizationReady = true;
    return;
  }
  try {
    const persisted = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'system_storage_optimization_version'").first<{ value: string }>();
    if (persisted?.value === "v3") {
      storageOptimizationReady = true;
      await optionalKvPut(env, markerKey, String(now()));
      return;
    }
    for (const sql of [
      "DROP INDEX IF EXISTS idx_v2_stat_user_u",
      "DROP INDEX IF EXISTS idx_v2_stat_user_d",
      "DROP INDEX IF EXISTS idx_v2_stat_user_record",
      "DROP INDEX IF EXISTS idx_v2_stat_server_upload",
      "DROP INDEX IF EXISTS idx_v2_stat_server_download",
      "DROP INDEX IF EXISTS idx_v2_stat_server_record",
      "DROP INDEX IF EXISTS idx_v2_job_logs_status_time",
      "CREATE INDEX IF NOT EXISTS idx_v2_job_logs_failed_time ON v2_job_logs(updated_at, created_at) WHERE status = 'failed'",
      "CREATE INDEX IF NOT EXISTS idx_v2_stat_server_record_server ON v2_stat_server(record_at, server_id, server_type)"
    ]) await runSqlIgnore(env, sql);
    const timestamp = now();
    await runSqlIgnore(env, `UPDATE v2_mail_templates SET subject = '{{name}} - 站点通知', updated_at = ?
      WHERE name = 'notify' AND subject = 'Notification from {{app.name}}'`, [timestamp]);
    await env.XBOARD_DB.prepare(`INSERT INTO v2_settings(name, value, created_at, updated_at)
      VALUES ('system_storage_optimization_version', 'v3', ?, ?)
      ON CONFLICT(name) DO UPDATE SET value = 'v3', updated_at = excluded.updated_at`).bind(timestamp, timestamp).run();
    storageOptimizationReady = true;
    await optionalKvPut(env, markerKey, String(timestamp));
  } catch {
    // A fresh database may not have v2_settings until the main bootstrap completes.
  }
}

const adminTableRoutes: Array<[string, string]> = [
  ["/server/group/", "v2_server_group"],
  ["/server/route/", "v2_server_route"],
  ["/server/machine/", "v2_server_machine"],
  ["/server/manage/", "v2_server"],
  ["/mail/template/", "v2_mail_templates"],
  ["/user/", "v2_user"],
  ["/plan/", "v2_plan"],
  ["/notice/", "v2_notice"],
  ["/knowledge/", "v2_knowledge"],
  ["/ticket/", "v2_ticket"],
  ["/audit/", "v2_admin_audit_log"]
];

function adminTableForPath(path: string) {
  return adminTableRoutes.find(([route]) => path.includes(route))?.[1];
}

function leftRotate(value: number, amount: number) { return (value << amount) | (value >>> (32 - amount)); }
function md5(input: string) {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) * 64;
  const data = new Uint8Array(paddedLength); data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer); view.setUint32(paddedLength - 8, bitLength >>> 0, true); view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  for (let offset = 0; offset < data.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const next = d; d = c; c = b; b = (b + leftRotate((a + f + constants[i] + words[g]) >>> 0, shifts[i])) >>> 0; a = next;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0,b0,c0,d0].map(value => [0,8,16,24].map(shift => ((value >>> shift) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

function concatBytes(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function uint16(value: number) { return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]); }
function base64UrlBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), char => char.charCodeAt(0));
}
function pem(label: string, bytes: Uint8Array) {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
}
async function generateEch(publicName: string) {
  if (!publicName || new TextEncoder().encode(publicName).length > 253) return null;
  const pair = await crypto.subtle.generateKey({ name: "X25519" } as any, true, ["deriveBits"] as any) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey); const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = base64UrlBytes(String(privateJwk.d || "")); const publicKey = base64UrlBytes(String(publicJwk.x || ""));
  if (privateKey.length !== 32 || publicKey.length !== 32) throw new Error("X25519 key export failed");
  const name = new TextEncoder().encode(publicName); const configId = crypto.getRandomValues(new Uint8Array(1))[0];
  const contents = concatBytes(new Uint8Array([configId]), uint16(0x0020), uint16(32), publicKey, uint16(8), uint16(1), uint16(1), uint16(1), uint16(3), new Uint8Array([0, name.length]), name, uint16(0));
  const config = concatBytes(uint16(0xfe0d), uint16(contents.length), contents);
  return { key: pem("ECH KEYS", concatBytes(uint16(32), privateKey, uint16(config.length), config)), config: pem("ECH CONFIGS", concatBytes(uint16(config.length), config)) };
}

const directFetchTables: Record<string, string> = {
  "/server/manage/getNodes": "v2_server",
  "/server/machine/fetch": "v2_server_machine",
  "/server/group/fetch": "v2_server_group",
  "/server/route/fetch": "v2_server_route",
  "/notice/fetch": "v2_notice",
  "/knowledge/fetch": "v2_knowledge",
  "/plan/fetch": "v2_plan",
  "/payment/fetch": "v2_payment"
};

const pagedFetchTables: Record<string, string> = {
  "/user/fetch": "v2_user",
  "/ticket/fetch": "v2_ticket",
  "/order/fetch": "v2_order",
  "/coupon/fetch": "v2_coupon",
  "/gift-card/templates": "v2_gift_card_template",
  "/gift-card/codes": "v2_gift_card_code",
  "/gift-card/usages": "v2_gift_card_usage"
};

const adminRouteMethods: Record<string, string[]> = {
  "/config/fetch": ["GET"], "/config/save": ["POST"], "/config/getEmailTemplate": ["GET"], "/config/getThemeTemplate": ["GET"],
  "/config/setTelegramWebhook": ["POST"], "/config/testSendMail": ["POST"],
  "/mail/template/list": ["GET"], "/mail/template/get": ["GET"], "/mail/template/save": ["POST"], "/mail/template/reset": ["POST"], "/mail/template/test": ["POST"],
  "/plan/fetch": ["GET"], "/plan/save": ["POST"], "/plan/drop": ["POST"], "/plan/update": ["POST"], "/plan/sort": ["POST"],
  "/server/group/fetch": ["GET"], "/server/group/save": ["POST"], "/server/group/drop": ["POST"],
  "/server/route/fetch": ["GET"], "/server/route/save": ["POST"], "/server/route/drop": ["POST"],
  "/server/manage/getNodes": ["GET"], "/server/manage/update": ["POST"], "/server/manage/save": ["POST"], "/server/manage/drop": ["POST"],
  "/server/manage/copy": ["POST"], "/server/manage/sort": ["POST"], "/server/manage/batchDelete": ["POST"], "/server/manage/batchUpdate": ["POST"],
  "/server/manage/resetTraffic": ["POST"], "/server/manage/batchResetTraffic": ["POST"], "/server/manage/generateEchKey": ["GET"],
  "/server/machine/fetch": ["GET"], "/server/machine/save": ["POST"], "/server/machine/drop": ["POST"], "/server/machine/resetToken": ["POST"],
  "/server/machine/getToken": ["GET"], "/server/machine/installCommand": ["GET"], "/server/machine/nodes": ["GET"], "/server/machine/history": ["GET"],
  "/order/fetch": ["GET", "POST"], "/order/update": ["POST"], "/order/assign": ["POST"], "/order/paid": ["POST"], "/order/cancel": ["POST"], "/order/detail": ["POST"],
  "/user/fetch": ["GET", "POST"], "/user/update": ["POST"], "/user/getUserInfoById": ["GET"], "/user/generate": ["POST"], "/user/dumpCSV": ["POST"],
  "/user/sendMail": ["POST"], "/user/ban": ["POST"], "/user/resetSecret": ["POST"], "/user/setInviteUser": ["POST"], "/user/destroy": ["POST"], "/user/getSubscribe": ["GET"],
  "/stat/getOverride": ["GET"], "/stat/getStats": ["GET"], "/stat/getServerLastRank": ["GET"], "/stat/getServerYesterdayRank": ["GET"],
  "/stat/getOrder": ["GET"], "/stat/getStatUser": ["GET", "POST"], "/stat/getRanking": ["GET"], "/stat/getStatRecord": ["GET"], "/stat/getTrafficRank": ["GET"],
  "/notice/fetch": ["GET"], "/notice/save": ["POST"], "/notice/update": ["POST"], "/notice/drop": ["POST"], "/notice/show": ["POST"], "/notice/sort": ["POST"],
  "/ticket/fetch": ["GET", "POST"], "/ticket/reply": ["POST"], "/ticket/close": ["POST"],
  "/coupon/fetch": ["GET", "POST"], "/coupon/generate": ["POST"], "/coupon/drop": ["POST"], "/coupon/show": ["POST"], "/coupon/update": ["POST"],
  "/knowledge/fetch": ["GET"], "/knowledge/getCategory": ["GET"], "/knowledge/save": ["POST"], "/knowledge/show": ["POST"], "/knowledge/drop": ["POST"], "/knowledge/sort": ["POST"],
  "/payment/fetch": ["GET"], "/payment/getPaymentMethods": ["GET"], "/payment/getPaymentForm": ["POST"], "/payment/save": ["POST"], "/payment/drop": ["POST"], "/payment/show": ["POST"], "/payment/sort": ["POST"],
  "/system/getSystemStatus": ["GET"], "/system/getQueueStats": ["GET"], "/system/getQueueWorkload": ["GET"], "/system/getQueueMasters": ["GET"],
  "/system/getHorizonFailedJobs": ["GET"], "/system/getAuditLog": ["GET", "POST"],
  "/system/backfillAnalytics": ["POST"],
  "/theme/getThemes": ["GET"], "/theme/upload": ["POST"], "/theme/delete": ["POST"], "/theme/saveThemeConfig": ["POST"], "/theme/getThemeConfig": ["POST"],
  "/plugin/types": ["GET"], "/plugin/getPlugins": ["GET"], "/plugin/upload": ["POST"], "/plugin/delete": ["POST"], "/plugin/install": ["POST"],
  "/plugin/uninstall": ["POST"], "/plugin/enable": ["POST"], "/plugin/disable": ["POST"], "/plugin/config": ["GET", "POST"], "/plugin/upgrade": ["POST"],
  "/traffic-reset/logs": ["GET"], "/traffic-reset/stats": ["GET"], "/traffic-reset/reset-user": ["POST"]
  , "/migration/status": ["GET"], "/migration/export/manifest": ["GET"], "/migration/export/table": ["POST"],
  "/migration/start": ["POST"], "/migration/snapshot/table": ["POST"], "/migration/snapshot/finish": ["POST"],
  "/migration/prepare": ["POST"], "/migration/batch": ["POST"], "/migration/redis/import": ["POST"],
  "/migration/abort": ["POST"], "/migration/rollback/start": ["POST"], "/migration/rollback/table": ["POST"],
  "/migration/rollback/finish": ["POST"], "/migration/finish": ["POST"]
};

const allowedConfigSettings = new Set([
  "invite_force", "invite_commission", "invite_gen_limit", "invite_never_expire", "commission_first_time_enable", "commission_auto_check_enable",
  "commission_withdraw_limit", "commission_withdraw_method", "withdraw_close_enable", "commission_distribution_enable", "commission_distribution_l1",
  "commission_distribution_l2", "commission_distribution_l3", "logo", "force_https", "stop_register", "app_name", "app_description", "app_url",
  "subscribe_url", "try_out_enable", "try_out_plan_id", "try_out_hour", "tos_url", "currency", "currency_symbol", "ticket_must_wait_reply",
  "plan_change_enable", "reset_traffic_method", "surplus_enable", "new_order_event_id", "renew_order_event_id", "change_order_event_id",
  "show_info_to_server_enable", "show_protocol_to_server_enable", "subscribe_path", "server_token", "server_pull_interval", "server_push_interval",
  "device_limit_mode", "server_ws_enable", "server_ws_url", "frontend_theme", "frontend_theme_sidebar", "frontend_theme_header", "frontend_theme_color",
  "frontend_background_url", "email_driver", "email_host", "email_port", "email_username", "email_password", "email_from_address",
  "remind_mail_enable", "resend_api_url", "resend_api_key", "resend_from_name", "resend_from_address", "telegram_bot_enable", "telegram_bot_token",
  "telegram_webhook_url", "telegram_discuss_id", "telegram_channel_id", "telegram_discuss_link", "windows_version", "windows_download_url",
  "macos_version", "macos_download_url", "android_version", "android_download_url", "email_whitelist_enable", "email_whitelist_suffix",
  "email_gmail_limit_enable", "captcha_enable", "captcha_type", "recaptcha_enable", "recaptcha_key", "recaptcha_site_key", "recaptcha_v3_secret_key",
  "recaptcha_v3_site_key", "recaptcha_v3_score_threshold", "turnstile_secret_key", "turnstile_site_key", "email_verify", "safe_mode_enable",
  "register_limit_by_ip_enable", "register_limit_count", "register_limit_expire", "secure_path", "password_limit_enable", "password_limit_count",
  "password_limit_expire", "default_remind_expire", "default_remind_traffic", "login_with_mail_link_enable", "frontend_admin_path"
]);

const integerConfigSettings = new Set([
  "invite_force", "invite_commission", "invite_gen_limit", "invite_never_expire", "commission_first_time_enable", "commission_auto_check_enable",
  "withdraw_close_enable", "commission_distribution_enable", "force_https", "stop_register", "try_out_enable", "try_out_plan_id", "ticket_must_wait_reply",
  "plan_change_enable", "reset_traffic_method", "surplus_enable", "new_order_event_id", "renew_order_event_id", "change_order_event_id",
  "show_info_to_server_enable", "show_protocol_to_server_enable", "server_pull_interval", "server_push_interval", "device_limit_mode", "server_ws_enable",
  "remind_mail_enable", "telegram_bot_enable", "email_whitelist_enable", "email_gmail_limit_enable", "captcha_enable", "recaptcha_enable",
  "email_verify", "safe_mode_enable", "register_limit_by_ip_enable", "register_limit_count", "register_limit_expire", "password_limit_enable",
  "password_limit_count", "password_limit_expire", "default_remind_expire", "default_remind_traffic", "login_with_mail_link_enable"
]);

const numericConfigSettings = new Set([
  "commission_withdraw_limit", "commission_distribution_l1", "commission_distribution_l2", "commission_distribution_l3", "try_out_hour",
  "recaptcha_v3_score_threshold"
]);

const urlConfigSettings = new Set([
  "logo", "app_url", "tos_url", "server_ws_url", "frontend_background_url", "telegram_webhook_url", "telegram_discuss_link",
  "windows_download_url", "macos_download_url", "android_download_url"
]);

function adminRouteAllowed(route: string, method: string) {
  if (/^\/traffic-reset\/user\/\d+\/history$/.test(route)) return method === "GET";
  if (/^\/gift-card\/(templates|codes|usages|statistics)$/.test(route)) return method === "GET" || method === "POST";
  if (/^\/gift-card\/(create-template|update-template|delete-template|generate-codes|toggle-code|update-code|delete-code)$/.test(route)) return method === "POST";
  if (/^\/gift-card\/(export-codes|types)$/.test(route)) return method === "GET";
  return adminRouteMethods[route]?.includes(method) === true;
}

const v2NodeProtocolPaths = new Set([
  "/api/v2/server/handshake", "/api/v2/server/report", "/api/v2/server/config",
  "/api/v2/server/user", "/api/v2/server/push", "/api/v2/server/alive",
  "/api/v2/server/alivelist", "/api/v2/server/status",
  "/api/v2/server/machine/nodes", "/api/v2/server/machine/status"
]);

function isNodeProtocolPath(pathname: string, method = "GET") {
  if (pathname === "/ws" || pathname.startsWith("/api/v1/server/")) return true;
  if (pathname === "/api/v2/server/machine/nodes" || pathname === "/api/v2/server/machine/status") return method === "POST";
  return v2NodeProtocolPaths.has(pathname);
}

async function internalSyncToken(env: Env) {
  const values = await settings(env.XBOARD_DB, env.XBOARD_KV);
  return String(values.internal_sync_token || values.server_token || "");
}

async function invalidateServerSettings(env: Env) {
  try {
    const token = await internalSyncToken(env);
    if (!token) return;
    await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/settings/invalidate", {
      method: "POST",
      headers: { "x-xboard-internal-token": token }
    });
  } catch { /* Other workers refresh their short cache naturally if the service is unavailable. */ }
}

type NodeSyncIntent = { scope: "all" } | { scope: "user"; user_id: number; old_group_id?: number };

async function notifyNodeSync(env: Env, intent: NodeSyncIntent = { scope: "all" }) {
  try {
    await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/sync", {
      method: "POST",
      headers: { "content-type": "application/json", "x-xboard-internal-token": await internalSyncToken(env) },
      body: JSON.stringify(intent)
    });
  } catch {
    // HTTP polling remains the compatibility fallback when no node is connected by WebSocket.
  }
}

async function nodeSyncIntent(request: Request, pathname: string, env: Env): Promise<NodeSyncIntent | null> {
  if (!shouldNotifyNodeSync(pathname, request.method)) return null;
  if (!pathname.includes("/user/")) return { scope: "all" };
  const input = await body<Record<string, any>>(request);
  const rawId = input.id ?? (Array.isArray(input.ids) && input.ids.length === 1 ? input.ids[0] : undefined);
  const userId = Number(rawId || 0);
  if (!userId) return { scope: "all" };
  const previous = await env.XBOARD_DB.prepare("SELECT group_id FROM v2_user WHERE id = ?").bind(userId).first<{ group_id: number | null }>();
  return { scope: "user", user_id: userId, old_group_id: Number(previous?.group_id || 0) };
}

function shouldNotifyNodeSync(pathname: string, method: string) {
  if (method !== "POST" && method !== "DELETE") return false;
  return [
    "/server/manage/save", "/server/manage/update", "/server/manage/drop", "/server/manage/sort",
    "/server/route/save", "/server/route/drop", "/server/route/sort",
    "/server/group/save", "/server/group/drop",
    "/server/machine/save", "/server/machine/update", "/server/machine/drop",
    "/user/update", "/user/destroy", "/user/ban", "/user/resetSecret", "/user/generate",
    "/plan/save", "/plan/drop", "/order/paid"
  ].some(suffix => pathname.endsWith(suffix));
}

async function runSqlIgnore(env: Env, sql: string, binds: any[] = []) {
  try {
    await env.XBOARD_DB.prepare(sql).bind(...binds).run();
  } catch {
    // Used by first-run schema compatibility. Existing columns/rows are fine.
  }
}

const DEFAULT_ADMIN_PASSWORD_HASH = "pbkdf2$sha256$100000$xboard-cloudflare-admin$8abd89496c7d7b0cfdc7b786fd49da099859e1167bbcf9f945c38415d6d56268";

const defaultSubscribeTemplates: Record<string, string> = {
  singbox: JSON.stringify({
    dns: { servers: [{ tag: "remote", address: "https://1.1.1.1/dns-query" }, { tag: "local", address: "https://223.5.5.5/dns-query" }] },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2334, sniff: true }],
    outbounds: [{ type: "selector", tag: "节点选择", outbounds: ["自动选择"] }, { type: "urltest", tag: "自动选择", outbounds: [] }, { type: "direct", tag: "direct" }, { type: "block", tag: "block" }],
    route: { rules: [{ ip_is_private: true, outbound: "direct" }] }
  }, null, 2),
  clash: `mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - DOMAIN-SUFFIX,local,DIRECT
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
`,
  clashmeta: `mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "故障转移", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
  - { name: "故障转移", type: fallback, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - DOMAIN-SUFFIX,local,DIRECT
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
`,
  stash: `mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
`,
  surge: `#!MANAGED-CONFIG $subs_link interval=43200 strict=true
[General]
loglevel = notify
dns-server = 223.5.5.5, 114.114.114.114
[Panel]
SubscribeInfo = $subscribe_info, style=info
[Proxy]
$proxies
[Proxy Group]
Proxy = select, auto, fallback, $proxy_group
auto = url-test, $proxy_group, url=http://www.gstatic.com/generate_204, interval=43200
fallback = fallback, $proxy_group, url=http://www.gstatic.com/generate_204, interval=43200
[Rule]
DOMAIN,$subs_domain,DIRECT
GEOIP,CN,DIRECT
FINAL,Proxy,dns-failed
`,
  surfboard: `#!MANAGED-CONFIG $subs_link interval=43200 strict=true
[General]
loglevel = notify
dns-server = 223.6.6.6, 119.29.29.29
[Panel]
SubscribeInfo = $subscribe_info, style=info
[Proxy]
$proxies
[Proxy Group]
Proxy = select, auto, fallback, $proxy_group
auto = url-test, $proxy_group, url=http://www.gstatic.com/generate_204, interval=43200
fallback = fallback, $proxy_group, url=http://www.gstatic.com/generate_204, interval=43200
[Rule]
DOMAIN,$subs_domain,DIRECT
GEOIP,CN,DIRECT
FINAL,Proxy
`
};

async function ensureBootstrap(env: Env) {
  await ensureStorageOptimization(env);
  const marker = await optionalKvGet(env, "bootstrap:edge:v20");
  if (marker) return;
  try {
    const persisted = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'system_bootstrap_edge_version'").first<{ value: string }>();
    if (persisted?.value === "v20") {
      await optionalKvPut(env, "bootstrap:edge:v20", String(now()));
      return;
    }
  } catch {
    // The schema initializer may be running against a database that has not created v2_settings yet.
  }
  const alters = [
    "ALTER TABLE v2_user ADD COLUMN speed_limit INTEGER DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN discount INTEGER DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN commission_rate INTEGER DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN commission_type INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_user ADD COLUMN remind_expire INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE v2_user ADD COLUMN remind_traffic INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE v2_user ADD COLUMN reset_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_user ADD COLUMN last_reset_at INTEGER DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN next_reset_at INTEGER DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN t INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_user ADD COLUMN last_login_ip TEXT DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN online_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_user ADD COLUMN last_online_at INTEGER DEFAULT NULL",
    "ALTER TABLE v2_plan ADD COLUMN capacity_limit INTEGER DEFAULT NULL",
    "ALTER TABLE v2_plan ADD COLUMN reset_traffic_method INTEGER DEFAULT 0",
    "ALTER TABLE v2_server_machine ADD COLUMN notes TEXT",
    "ALTER TABLE v2_server_machine ADD COLUMN is_active INTEGER DEFAULT 1",
    "ALTER TABLE v2_server_machine ADD COLUMN last_seen_at INTEGER",
    "ALTER TABLE v2_server ADD COLUMN u INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_server ADD COLUMN d INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_server ADD COLUMN listen_address TEXT",
    "ALTER TABLE v2_server ADD COLUMN rate_time_enable INTEGER DEFAULT 0",
    "ALTER TABLE v2_server ADD COLUMN rate_time_ranges TEXT",
    "ALTER TABLE v2_server ADD COLUMN metrics TEXT",
    "ALTER TABLE v2_server ADD COLUMN transfer_enable INTEGER DEFAULT 0",
    "ALTER TABLE v2_server ADD COLUMN excludes TEXT",
    "ALTER TABLE v2_server ADD COLUMN ips TEXT",
    "ALTER TABLE v2_server ADD COLUMN code TEXT",
    "ALTER TABLE v2_subscribe_templates ADD COLUMN content TEXT",
    "ALTER TABLE v2_subscribe_templates ADD COLUMN template TEXT",
    "ALTER TABLE v2_ticket ADD COLUMN reply_status INTEGER DEFAULT 0",
    "ALTER TABLE v2_ticket ADD COLUMN last_reply_user_id INTEGER DEFAULT NULL",
    "ALTER TABLE v2_notice ADD COLUMN img_url TEXT",
    "ALTER TABLE v2_notice ADD COLUMN tags TEXT",
    "ALTER TABLE v2_notice ADD COLUMN popup INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_coupon ADD COLUMN name TEXT",
    "ALTER TABLE v2_coupon ADD COLUMN limit_use INTEGER",
    "ALTER TABLE v2_coupon ADD COLUMN limit_use_with_user INTEGER",
    "ALTER TABLE v2_coupon ADD COLUMN limit_plan_ids TEXT",
    "ALTER TABLE v2_coupon ADD COLUMN limit_period TEXT",
    "ALTER TABLE v2_coupon ADD COLUMN started_at INTEGER",
    "ALTER TABLE v2_coupon ADD COLUMN ended_at INTEGER",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN cpu REAL NOT NULL DEFAULT 0",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN mem_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN mem_used INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN disk_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN disk_used INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN net_in_speed REAL",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN net_out_speed REAL",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN recorded_at INTEGER",
    "ALTER TABLE v2_server_machine_load_history ADD COLUMN updated_at INTEGER",
    "ALTER TABLE v2_stat_user ADD COLUMN server_rate REAL NOT NULL DEFAULT 1",
    "ALTER TABLE v2_stat_user ADD COLUMN record_type TEXT NOT NULL DEFAULT 'd'",
    "ALTER TABLE v2_settings ADD COLUMN `group` TEXT DEFAULT NULL",
    "ALTER TABLE v2_settings ADD COLUMN type TEXT DEFAULT NULL",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN trigger_source TEXT DEFAULT NULL",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN old_upload INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN old_download INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN old_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN new_upload INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN new_download INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN new_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_order ADD COLUMN plan_id INTEGER",
    "ALTER TABLE v2_order ADD COLUMN payment_id INTEGER",
    "ALTER TABLE v2_order ADD COLUMN period TEXT",
    "ALTER TABLE v2_order ADD COLUMN handling_amount INTEGER",
    "ALTER TABLE v2_order ADD COLUMN balance_amount INTEGER",
    "ALTER TABLE v2_order ADD COLUMN surplus_credit INTEGER",
    "ALTER TABLE v2_order ADD COLUMN surplus_amount INTEGER",
    "ALTER TABLE v2_order ADD COLUMN type INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE v2_order ADD COLUMN surplus_order_ids TEXT",
    "ALTER TABLE v2_order ADD COLUMN coupon_id INTEGER",
    "ALTER TABLE v2_order ADD COLUMN commission_status INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_order ADD COLUMN invite_user_id INTEGER",
    "ALTER TABLE v2_order ADD COLUMN actual_commission_balance INTEGER",
    "ALTER TABLE v2_order ADD COLUMN commission_rate INTEGER",
    "ALTER TABLE v2_order ADD COLUMN commission_auto_check INTEGER",
    "ALTER TABLE v2_order ADD COLUMN commission_balance INTEGER",
    "CREATE TABLE IF NOT EXISTS v2_traffic_pending_check (user_id INTEGER PRIMARY KEY, updated_at INTEGER NOT NULL)",
    "ALTER TABLE v2_order ADD COLUMN discount_amount INTEGER",
    "ALTER TABLE v2_order ADD COLUMN paid_at INTEGER",
    "ALTER TABLE v2_order ADD COLUMN callback_no TEXT",
    "ALTER TABLE v2_gift_card_template ADD COLUMN description TEXT",
    "ALTER TABLE v2_gift_card_template ADD COLUMN type INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE v2_gift_card_template ADD COLUMN status INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE v2_gift_card_template ADD COLUMN icon TEXT",
    "ALTER TABLE v2_gift_card_template ADD COLUMN background_image TEXT",
    "ALTER TABLE v2_gift_card_template ADD COLUMN theme_color TEXT NOT NULL DEFAULT '#1890ff'",
    "ALTER TABLE v2_gift_card_template ADD COLUMN sort INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_gift_card_template ADD COLUMN admin_id INTEGER",
    "ALTER TABLE v2_gift_card_code ADD COLUMN batch_id TEXT",
    "ALTER TABLE v2_gift_card_code ADD COLUMN user_id INTEGER",
    "ALTER TABLE v2_gift_card_code ADD COLUMN used_at INTEGER",
    "ALTER TABLE v2_gift_card_code ADD COLUMN expires_at INTEGER",
    "ALTER TABLE v2_gift_card_code ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_gift_card_code ADD COLUMN max_usage INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE v2_gift_card_code ADD COLUMN redemption_nonce TEXT",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN template_id INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN invite_user_id INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN user_level_at_use INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN plan_id_at_use INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN ip_address TEXT",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN user_agent TEXT",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN notes TEXT",
    "ALTER TABLE v2_knowledge ADD COLUMN language TEXT",
    "ALTER TABLE v2_stat ADD COLUMN transfer_used_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN register_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN invite_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN order_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN paid_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN paid_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN commission_total INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN commission_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_stat ADD COLUMN record_type TEXT",
    "ALTER TABLE v2_stat_server ADD COLUMN record_type TEXT",
    "ALTER TABLE v2_admin_audit_log ADD COLUMN method TEXT",
    "ALTER TABLE v2_admin_audit_log ADD COLUMN uri TEXT",
    "ALTER TABLE v2_admin_audit_log ADD COLUMN request_data TEXT",
    "ALTER TABLE v2_admin_audit_log ADD COLUMN updated_at INTEGER",
    "ALTER TABLE v2_traffic_reset_logs ADD COLUMN updated_at INTEGER",
    "ALTER TABLE v2_payment ADD COLUMN uuid TEXT",
    "ALTER TABLE v2_payment ADD COLUMN icon TEXT",
    "ALTER TABLE v2_payment ADD COLUMN handling_fee_fixed INTEGER",
    "ALTER TABLE v2_payment ADD COLUMN handling_fee_percent REAL",
    "ALTER TABLE v2_payment ADD COLUMN notify_domain TEXT",
    "ALTER TABLE v2_payment ADD COLUMN sort INTEGER DEFAULT 0",
    "ALTER TABLE v2_commission_log ADD COLUMN invite_user_id INTEGER",
    "ALTER TABLE v2_commission_log ADD COLUMN trade_no TEXT",
    "ALTER TABLE v2_commission_log ADD COLUMN order_amount INTEGER",
    "ALTER TABLE v2_commission_log ADD COLUMN get_amount INTEGER",
    "ALTER TABLE v2_migration_runs ADD COLUMN access_token_hash TEXT"
  ];
  for (const sql of alters) await runSqlIgnore(env, sql);
  await runSqlIgnore(env, "UPDATE v2_coupon SET type = CAST(type AS INTEGER) WHERE CAST(type AS TEXT) LIKE '%.0'");
  await runSqlIgnore(env, "UPDATE v2_order SET status = 2 WHERE status IS NULL OR CAST(status AS TEXT) NOT IN ('0','1','2','3','4')");
  await runSqlIgnore(env, "UPDATE v2_stat_server SET record_type = 'd' WHERE record_type IS NULL OR record_type = ''");
  await runSqlIgnore(env, "UPDATE v2_stat_user SET server_rate = COALESCE(rate, 1)");
  await runSqlIgnore(env, "CREATE INDEX IF NOT EXISTS idx_machine_load_recorded ON v2_server_machine_load_history(machine_id, recorded_at)");
  for (const sql of [
    "CREATE INDEX IF NOT EXISTS idx_gift_template_type_status ON v2_gift_card_template(type, status)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_template_id ON v2_gift_card_code(template_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_status ON v2_gift_card_code(status)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_batch_id ON v2_gift_card_code(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_expires_at ON v2_gift_card_code(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_user_id ON v2_gift_card_code(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_lookup ON v2_gift_card_code(code, status, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_gift_template_created_at ON v2_gift_card_template(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_code_id ON v2_gift_card_usage(code_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_invite_user_id ON v2_gift_card_usage(invite_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_user_id ON v2_gift_card_usage(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_created_at ON v2_gift_card_usage(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_user_usage ON v2_gift_card_usage(user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_template_stats ON v2_gift_card_usage(template_id, created_at)"
  ]) await runSqlIgnore(env, sql);
  await runSqlIgnore(env, "DELETE FROM v2_server_machine_load_history");
  await runSqlIgnore(env, "UPDATE v2_server_machine SET last_seen_at = NULL, load_status = NULL");
  await runSqlIgnore(env, "UPDATE v2_server SET last_check_at = NULL, last_push_at = NULL, online_user = 0, metrics = NULL");
  for (const sql of [
    "CREATE INDEX IF NOT EXISTS idx_v2_user_next_reset_at ON v2_user(next_reset_at)",
    "CREATE INDEX IF NOT EXISTS idx_v2_user_online ON v2_user(last_online_at, online_count)",
    "CREATE INDEX IF NOT EXISTS idx_traffic_reset_user_time ON v2_traffic_reset_logs(user_id, reset_time)",
    "CREATE INDEX IF NOT EXISTS idx_notice_sort ON v2_notice(sort)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_server_type_code ON v2_server(type, code) WHERE code IS NOT NULL AND code != ''"
  ]) await runSqlIgnore(env, sql);
  for (const sql of [
    "CREATE INDEX IF NOT EXISTS idx_v2_order_created_at ON v2_order(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_personal_access_tokens_tokenable ON personal_access_tokens(tokenable_type, tokenable_id)",
    "CREATE INDEX IF NOT EXISTS idx_v2_order_status ON v2_order(status)",
    "CREATE INDEX IF NOT EXISTS idx_v2_order_total_amount ON v2_order(total_amount)",
    "CREATE INDEX IF NOT EXISTS idx_v2_order_commission_status ON v2_order(commission_status)",
    "CREATE INDEX IF NOT EXISTS idx_v2_order_invite_user_id ON v2_order(invite_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_v2_order_commission_balance ON v2_order(commission_balance)",
    "CREATE INDEX IF NOT EXISTS idx_v2_order_updated_at ON v2_order(updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_v2_commission_user ON v2_commission_log(user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_v2_commission_order ON v2_commission_log(order_id)",
    "CREATE INDEX IF NOT EXISTS idx_v2_ticket_status ON v2_ticket(status)",
    "CREATE INDEX IF NOT EXISTS idx_v2_ticket_created_at ON v2_ticket(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_v2_stat_server_server ON v2_stat_server(server_id, record_at)",
    "CREATE INDEX IF NOT EXISTS idx_v2_user_availability ON v2_user(banned, expired_at, group_id, transfer_enable, u, d)",
    "CREATE INDEX IF NOT EXISTS idx_v2_commission_log_created_at ON v2_commission_log(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_failed_jobs_failed_at ON failed_jobs(failed_at)",
    "CREATE INDEX IF NOT EXISTS idx_v2_job_logs_failed_time ON v2_job_logs(updated_at, created_at) WHERE status = 'failed'",
    "CREATE INDEX IF NOT EXISTS idx_v2_commission_log_get_amount ON v2_commission_log(get_amount)",
    "CREATE INDEX IF NOT EXISTS idx_v2_user_t ON v2_user(t)",
    "CREATE INDEX IF NOT EXISTS idx_v2_user_online_count ON v2_user(online_count)",
    "CREATE INDEX IF NOT EXISTS idx_v2_user_created_at ON v2_user(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_v2_admin_audit_log_admin_id ON v2_admin_audit_log(admin_id)",
    "CREATE INDEX IF NOT EXISTS idx_v2_admin_audit_log_action ON v2_admin_audit_log(action)",
    "CREATE INDEX IF NOT EXISTS idx_v2_server_sort ON v2_server(sort)",
    "CREATE INDEX IF NOT EXISTS idx_v2_stat_user_record_user ON v2_stat_user(record_at, user_id)"
  ]) await runSqlIgnore(env, sql);
  await runSqlIgnore(env, "UPDATE v2_gift_card_code SET status = 3 WHERE status = 'disabled'");
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS v2_invite_code (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE, status INTEGER NOT NULL DEFAULT 0, pv INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS v2_mail_log (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, subject TEXT NOT NULL, template_name TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS v2_plugins (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, version TEXT NOT NULL, type TEXT, is_enabled INTEGER NOT NULL DEFAULT 0, config TEXT, installed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS failed_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, connection TEXT NOT NULL, queue TEXT NOT NULL, payload TEXT NOT NULL, exception TEXT NOT NULL, failed_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS v2_traffic_dedup (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS v2_traffic_stats_outbox (batch_id TEXT PRIMARY KEY, event_ids TEXT NOT NULL, user_aggregates TEXT NOT NULL, server_aggregates TEXT NOT NULL, transfer_used INTEGER NOT NULL DEFAULT 0, record_at INTEGER NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS v2_log (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, level TEXT, host TEXT, uri TEXT NOT NULL, method TEXT NOT NULL, data TEXT, ip TEXT, context TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    , "CREATE TABLE IF NOT EXISTS v2_migration_runs (id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_name TEXT, source_size INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'merge', status TEXT NOT NULL DEFAULT 'running', source_counts TEXT, progress TEXT, report TEXT, error TEXT, access_token_hash TEXT, admin_id INTEGER, snapshot_counts TEXT, snapshot_complete INTEGER NOT NULL DEFAULT 0, skip_backup INTEGER NOT NULL DEFAULT 0, prepared_at INTEGER, rollback_progress TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    , "CREATE TABLE IF NOT EXISTS v2_migration_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', table_name TEXT, message TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL)"
  ]) await runSqlIgnore(env, sql);
  const ts = now();
  const overwriteMigration = await env.XBOARD_DB.prepare("SELECT 1 AS found FROM v2_migration_runs WHERE mode = 'overwrite' AND status != 'rolled_back' LIMIT 1").first<{ found: number }>();
  const preserveMigratedData = Boolean(overwriteMigration?.found);
  const settingsDefaults: Record<string, any> = {
    app_name: "XBoard CF", app_description: "XBoard Cloudflare-native panel", app_url: "", logo: "", subscribe_url: "", stop_register: 0,
    subscribe_path: "s", frontend_admin_path: "admin", secure_path: "admin", frontend_theme: "Xboard",
    frontend_theme_sidebar: "light", frontend_theme_header: "dark", frontend_theme_color: "default",
    currency: "CNY", currency_symbol: "¥", try_out_plan_id: 1, try_out_hour: 1,
    plan_change_enable: 1, reset_traffic_method: 0, surplus_enable: 1, default_remind_expire: 1, default_remind_traffic: 1,
    server_token: "xboard-cf-server-token-change-me", server_pull_interval: 300, server_push_interval: 300, server_ws_enable: 1,
    server_ws_url: "", device_limit_mode: 0, payment_enabled: 0, invite_force: 0, invite_commission: 10,
    invite_gen_limit: 5, invite_never_expire: 0, commission_first_time_enable: 1, commission_auto_check_enable: 1,
    commission_withdraw_limit: 100, commission_withdraw_method: ["USDT", "支付宝"], email_verify: 0, safe_mode_enable: 0,
    email_whitelist_enable: 0, email_whitelist_suffix: ["gmail.com", "qq.com", "163.com"], email_gmail_limit_enable: 0,
    captcha_enable: 0, captcha_type: "recaptcha", recaptcha_key: "", recaptcha_site_key: "", recaptcha_v3_secret_key: "",
    recaptcha_v3_site_key: "", recaptcha_v3_score_threshold: 0.5, turnstile_secret_key: "", turnstile_site_key: "",
    register_limit_by_ip_enable: 0, register_limit_count: 3, register_limit_expire: 60, password_limit_enable: 1,
    password_limit_count: 5, password_limit_expire: 60, login_with_mail_link_enable: 0, resend_api_url: "", resend_api_key: "",
    resend_from_address: "", resend_from_name: "XBoard", email_driver: "maileroo", email_host: "", email_port: "", email_username: "XBoard",
    email_password: "", email_from_address: "", remind_mail_enable: 0,
    telegram_bot_enable: 0, telegram_bot_token: "", telegram_webhook_url: "", telegram_discuss_link: "",
    windows_version: "", windows_download_url: "", macos_version: "", macos_download_url: "", android_version: "", android_download_url: ""
  };
  if (!preserveMigratedData) {
    for (const [name, value] of Object.entries(settingsDefaults)) {
      await runSqlIgnore(env, "INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = CASE WHEN v2_settings.value IS NULL OR v2_settings.value = '' THEN excluded.value ELSE v2_settings.value END, updated_at = excluded.updated_at",
        [name, typeof value === "object" ? JSON.stringify(value) : String(value), ts, ts]);
    }
  }
  if (!preserveMigratedData) {
    // Preserve sender identity and initialize the provider choice for older builds.
    const emailSettings = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const legacyEmailUsername = String(firstNonEmpty(emailSettings.email_username, emailSettings.resend_from_name));
    const emailFromAddress = firstNonEmpty(emailSettings.email_from_address, emailSettings.resend_from_address, legacyEmailUsername.includes("@") ? legacyEmailUsername : "");
    const emailFromName = firstNonEmpty(legacyEmailUsername.includes("@") ? "" : legacyEmailUsername, emailSettings.resend_from_name, emailSettings.app_name, "XBoard");
    for (const [name, value] of Object.entries({
      email_driver: ["maileroo", "brevo"].includes(String(emailSettings.email_driver || "").toLowerCase()) ? String(emailSettings.email_driver).toLowerCase() : "maileroo",
      email_from_address: emailFromAddress,
      resend_from_address: emailFromAddress,
      email_username: emailFromName,
      resend_from_name: emailFromName
    })) {
      await runSqlIgnore(env, "INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [name, value, ts, ts]);
    }
  }
  if (!preserveMigratedData) {
    await runSqlIgnore(env, "INSERT INTO v2_server_group(id, name, created_at, updated_at) VALUES (1, 'Default', ?, ?) ON CONFLICT(id) DO NOTHING", [ts, ts]);
    await runSqlIgnore(env, "INSERT INTO v2_plan(id, group_id, transfer_enable, name, speed_limit, device_limit, capacity_limit, reset_traffic_method, prices, content, tags, show, sell, renew, sort, created_at, updated_at) VALUES (1, 1, 1024, 'Default Trial', NULL, NULL, NULL, 0, '{}', 'Default seeded plan for first-run compatibility.', '[]', 1, 1, 1, 1, ?, ?) ON CONFLICT(id) DO NOTHING", [ts, ts]);
    if (await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_user") === 0) {
      await runSqlIgnore(env, "INSERT INTO v2_user(email, password, password_algo, password_salt, uuid, token, transfer_enable, u, d, banned, is_admin, is_staff, plan_id, group_id, remind_expire, remind_traffic, created_at, updated_at) VALUES ('admin@admin.com', ?, 'pbkdf2', 'xboard-cloudflare-admin', '00000000-0000-4000-8000-000000000001', 'admin-default-token-change-me', 1099511627776, 0, 0, 0, 1, 1, 1, 1, 1, 1, ?, ?)", [DEFAULT_ADMIN_PASSWORD_HASH, ts, ts]);
    }
    await runSqlIgnore(env, "INSERT INTO v2_notice(id, title, content, show, sort, created_at, updated_at) VALUES (1, 'Welcome to XBoard CF', 'The Cloudflare-native XBoard panel is ready.', 1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, show = excluded.show, updated_at = excluded.updated_at", [ts, ts]);
    await runSqlIgnore(env, "INSERT INTO v2_knowledge(id, category, title, body, show, sort, created_at, updated_at) VALUES (1, 'Getting Started', 'First-run checklist', 'Update the default administrator password, configure app_url, and add real nodes before production use.', 1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title, body = excluded.body, show = excluded.show, updated_at = excluded.updated_at", [ts, ts]);
    for (const [name, subject, content] of [
      ["notify", "{{name}} - 站点通知", "{{content}}"],
      ["verify", "Email verification code", "Your verification code is {{code}}."],
      ["mailLogin", "Login to {{name}}", "Use this link to log in: {{link}}"],
      ["remind_expire", "Service expiry reminder", "Your service is about to expire."],
      ["remind_traffic", "Traffic usage reminder", "Your traffic usage is high."]
    ]) {
      await runSqlIgnore(env, "INSERT INTO v2_mail_templates(name, subject, content, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, content = excluded.content, enabled = excluded.enabled, updated_at = excluded.updated_at WHERE v2_mail_templates.content IS NULL OR v2_mail_templates.content = ''", [name, subject, content, ts, ts]);
    }
    for (const [name, content] of Object.entries(defaultSubscribeTemplates)) {
      await runSqlIgnore(env, "INSERT INTO v2_subscribe_templates(name, type, content, template, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET content = CASE WHEN v2_subscribe_templates.content IS NULL OR v2_subscribe_templates.content = '' THEN excluded.content ELSE v2_subscribe_templates.content END, template = CASE WHEN v2_subscribe_templates.template IS NULL OR v2_subscribe_templates.template = '' THEN excluded.template ELSE v2_subscribe_templates.template END, enabled = 1, updated_at = excluded.updated_at", [name, name, content, content, ts, ts]);
      await runSqlIgnore(env, "INSERT INTO v2_subscribe_templates(name, content, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = CASE WHEN v2_subscribe_templates.content IS NULL OR v2_subscribe_templates.content = '' THEN excluded.content ELSE v2_subscribe_templates.content END, updated_at = excluded.updated_at", [name, content, ts, ts]);
    }
    await runSqlIgnore(env, "UPDATE v2_user SET transfer_enable = transfer_enable * 1073741824, updated_at = ? WHERE plan_id IS NOT NULL AND transfer_enable > 0 AND EXISTS (SELECT 1 FROM v2_plan WHERE v2_plan.id = v2_user.plan_id AND v2_plan.transfer_enable = v2_user.transfer_enable)", [ts]);
  }
  await runSqlIgnore(env, "INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES ('system_bootstrap_edge_version', 'v20', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [ts, ts]);
  invalidateSettingsCache();
  await optionalKvPut(env, "bootstrap:edge:v20", String(ts));
  await ensureStorageOptimization(env);
}

async function firstNumber(env: Env, sql: string, fallback = 0) {
  try {
    const row = await env.XBOARD_DB.prepare(sql).first<Record<string, number>>();
    const value = row ? Object.values(row)[0] : fallback;
    return Number(value || fallback);
  } catch {
    return fallback;
  }
}

function pickSetting(all: Record<string, any>, key: string, fallback: any = "") {
  return all[key] ?? fallback;
}

function emailSuffixes(value: unknown) {
  return Array.isArray(value) ? value : String(value ?? "").split(",");
}

function firstNonEmpty(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

async function adminConfig(env: Env, request: Request) {
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const templates = await subscribeTemplateMap(env);
  const config: Record<string, any> = {
    invite: {
      invite_force: !!pickSetting(all, "invite_force", 0),
      invite_commission: pickSetting(all, "invite_commission", 10),
      invite_gen_limit: pickSetting(all, "invite_gen_limit", 5),
      invite_never_expire: !!pickSetting(all, "invite_never_expire", 0),
      commission_first_time_enable: !!pickSetting(all, "commission_first_time_enable", 1),
      commission_auto_check_enable: !!pickSetting(all, "commission_auto_check_enable", 1),
      commission_withdraw_limit: pickSetting(all, "commission_withdraw_limit", 100),
      commission_withdraw_method: pickSetting(all, "commission_withdraw_method", ["USDT", "支付宝"]),
      withdraw_close_enable: !!pickSetting(all, "withdraw_close_enable", 0),
      commission_distribution_enable: !!pickSetting(all, "commission_distribution_enable", 0),
      commission_distribution_l1: pickSetting(all, "commission_distribution_l1", ""),
      commission_distribution_l2: pickSetting(all, "commission_distribution_l2", ""),
      commission_distribution_l3: pickSetting(all, "commission_distribution_l3", "")
    },
    site: {
      logo: pickSetting(all, "logo", ""),
      force_https: Number(pickSetting(all, "force_https", 0)),
      stop_register: Number(pickSetting(all, "stop_register", 0)),
      app_name: pickSetting(all, "app_name", "XBoard"),
      app_description: pickSetting(all, "app_description", "XBoard is best!"),
      app_url: pickSetting(all, "app_url", ""),
      subscribe_url: pickSetting(all, "subscribe_url", ""),
      try_out_plan_id: Number(pickSetting(all, "try_out_plan_id", 0)),
      try_out_hour: Number(pickSetting(all, "try_out_hour", 1)),
      tos_url: pickSetting(all, "tos_url", ""),
      currency: pickSetting(all, "currency", "CNY"),
      currency_symbol: pickSetting(all, "currency_symbol", "¥"),
      ticket_must_wait_reply: !!pickSetting(all, "ticket_must_wait_reply", 0)
    },
    subscribe: {
      plan_change_enable: !!pickSetting(all, "plan_change_enable", 1),
      reset_traffic_method: Number(pickSetting(all, "reset_traffic_method", 0)),
      surplus_enable: !!pickSetting(all, "surplus_enable", 1),
      new_order_event_id: Number(pickSetting(all, "new_order_event_id", 0)),
      renew_order_event_id: Number(pickSetting(all, "renew_order_event_id", 0)),
      change_order_event_id: Number(pickSetting(all, "change_order_event_id", 0)),
      show_info_to_server_enable: !!pickSetting(all, "show_info_to_server_enable", 0),
      show_protocol_to_server_enable: !!pickSetting(all, "show_protocol_to_server_enable", 0),
      default_remind_expire: !!pickSetting(all, "default_remind_expire", 1),
      default_remind_traffic: !!pickSetting(all, "default_remind_traffic", 1),
      subscribe_path: pickSetting(all, "subscribe_path", "s")
    },
    frontend: {
      frontend_theme: pickSetting(all, "frontend_theme", "Xboard"),
      frontend_theme_sidebar: pickSetting(all, "frontend_theme_sidebar", "light"),
      frontend_theme_header: pickSetting(all, "frontend_theme_header", "dark"),
      frontend_theme_color: pickSetting(all, "frontend_theme_color", "default"),
      frontend_background_url: pickSetting(all, "frontend_background_url", "")
    },
    server: {
      server_token: pickSetting(all, "server_token", ""),
      server_pull_interval: pickSetting(all, "server_pull_interval", 300),
      server_push_interval: pickSetting(all, "server_push_interval", 300),
      device_limit_mode: Number(pickSetting(all, "device_limit_mode", 0)),
      server_ws_enable: !!pickSetting(all, "server_ws_enable", 1),
      server_ws_url: pickSetting(all, "server_ws_url", "")
    },
    email: {
      email_driver: ["maileroo", "brevo"].includes(String(all.email_driver || "").toLowerCase()) ? String(all.email_driver).toLowerCase() : "maileroo",
      email_username: firstNonEmpty(all.email_username, all.resend_from_name, all.app_name, "XBoard"),
      email_password: firstNonEmpty(all.email_password),
      email_from_address: firstNonEmpty(all.email_from_address, all.resend_from_address),
      remind_mail_enable: !!pickSetting(all, "remind_mail_enable", 0)
    },
    telegram: {
      telegram_bot_enable: !!pickSetting(all, "telegram_bot_enable", 0),
      telegram_bot_token: pickSetting(all, "telegram_bot_token", ""),
      telegram_webhook_url: pickSetting(all, "telegram_webhook_url", ""),
      telegram_discuss_link: pickSetting(all, "telegram_discuss_link", "")
    },
    app: {
      windows_version: pickSetting(all, "windows_version", ""),
      windows_download_url: pickSetting(all, "windows_download_url", ""),
      macos_version: pickSetting(all, "macos_version", ""),
      macos_download_url: pickSetting(all, "macos_download_url", ""),
      android_version: pickSetting(all, "android_version", ""),
      android_download_url: pickSetting(all, "android_download_url", "")
    },
    safe: {
      email_verify: !!pickSetting(all, "email_verify", 0),
      safe_mode_enable: !!pickSetting(all, "safe_mode_enable", 0),
      secure_path: pickSetting(all, "secure_path", "admin"),
      email_whitelist_enable: !!pickSetting(all, "email_whitelist_enable", 0),
      email_whitelist_suffix: pickSetting(all, "email_whitelist_suffix", ["gmail.com", "qq.com", "163.com"]),
      email_gmail_limit_enable: !!pickSetting(all, "email_gmail_limit_enable", 0),
      captcha_enable: !!pickSetting(all, "captcha_enable", 0),
      captcha_type: pickSetting(all, "captcha_type", "recaptcha"),
      recaptcha_key: pickSetting(all, "recaptcha_key", ""),
      recaptcha_site_key: pickSetting(all, "recaptcha_site_key", ""),
      recaptcha_v3_secret_key: pickSetting(all, "recaptcha_v3_secret_key", ""),
      recaptcha_v3_site_key: pickSetting(all, "recaptcha_v3_site_key", ""),
      recaptcha_v3_score_threshold: pickSetting(all, "recaptcha_v3_score_threshold", 0.5),
      turnstile_secret_key: pickSetting(all, "turnstile_secret_key", ""),
      turnstile_site_key: pickSetting(all, "turnstile_site_key", ""),
      register_limit_by_ip_enable: !!pickSetting(all, "register_limit_by_ip_enable", 0),
      register_limit_count: pickSetting(all, "register_limit_count", 3),
      register_limit_expire: pickSetting(all, "register_limit_expire", 60),
      password_limit_enable: !!pickSetting(all, "password_limit_enable", 1),
      password_limit_count: pickSetting(all, "password_limit_count", 5),
      password_limit_expire: pickSetting(all, "password_limit_expire", 60),
      recaptcha_enable: !!pickSetting(all, "captcha_enable", 0)
    },
    subscribe_template: {
      subscribe_template_singbox: templates.singbox || defaultSubscribeTemplates.singbox,
      subscribe_template_clash: templates.clash || defaultSubscribeTemplates.clash,
      subscribe_template_clashmeta: templates.clashmeta || defaultSubscribeTemplates.clashmeta,
      subscribe_template_stash: templates.stash || defaultSubscribeTemplates.stash,
      subscribe_template_surge: templates.surge || defaultSubscribeTemplates.surge,
      subscribe_template_surfboard: templates.surfboard || defaultSubscribeTemplates.surfboard
    }
  };
  const key = new URL(request.url).searchParams.get("key");
  return key && config[key] ? { [key]: config[key] } : config;
}

function parseJsonArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function routeMatchArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(item => String(item).trim()).filter(Boolean);
    if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
  } catch {
    // Legacy rows may contain newline-separated text instead of JSON.
  }
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isNilLike(value: unknown) {
  return value === null || value === undefined || value === "" || value === "null" || value === "undefined";
}

function bindValue(value: unknown) {
  if (isNilLike(value)) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value) || (value && typeof value === "object")) return JSON.stringify(value);
  return value;
}

function safeUser(row: Record<string, any>) {
  const { password, password_algo, password_salt, token: userToken, ...rest } = row;
  return {
    ...rest,
    banned: Boolean(boolNumber(row.banned, 0)),
    is_admin: Boolean(boolNumber(row.is_admin, 0)),
    is_staff: Boolean(boolNumber(row.is_staff, 0)),
    remind_expire: Boolean(boolNumber(row.remind_expire, 0)),
    remind_traffic: Boolean(boolNumber(row.remind_traffic, 0)),
    commission_auto_check: Boolean(boolNumber(row.commission_auto_check, 0)),
    token: userToken,
    has_password: !!password
  };
}

function paginated<T extends Record<string, any>>(data: T[], total: number, page: number, pageSize: number) {
  return {
    data,
    list: data,
    rows: data,
    total,
    current_page: page,
    currentPage: page,
    page,
    per_page: pageSize,
    page_size: pageSize,
    pageSize,
    last_page: Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  };
}

async function subscribeUrl(request: Request, env: Env, userToken: string) {
  const values = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const configuredList = String(values.subscribe_url || new URL(request.url).origin).split(",").map(value => value.trim()).filter(Boolean);
  const selectedBase = configuredList[Math.floor(Math.random() * configuredList.length)] || new URL(request.url).origin;
  const configuredBase = selectedBase
    .replace(/\[(\d+)-(\d+)\]/g, (_match, left, right) => {
      const minimum = Math.min(Number(left), Number(right));
      const maximum = Math.max(Number(left), Number(right));
      return String(minimum + Math.floor(Math.random() * (maximum - minimum + 1)));
    })
    .replaceAll("[uuid]", crypto.randomUUID());
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(configuredBase) ? configuredBase : `https://${configuredBase}`;
  const path = String(values.subscribe_path || "s").replace(/^\/+|\/+$/g, "") || "s";
  return `${base.replace(/\/$/, "")}/${path}/${userToken}`;
}

function telegramSubscriptionToken(value: string) {
  try {
    const url = new URL(value);
    return url.searchParams.get("token") || url.pathname.split("/").filter(Boolean).at(-1) || null;
  } catch {
    return value.split("/").filter(Boolean).at(-1) || null;
  }
}

function telegramGb(value: unknown) {
  return (Number(value || 0) / 1073741824).toFixed(2);
}

async function handleTelegramMessage(request: Request, env: Env, botToken: string, message: Record<string, any>) {
  if (!message?.text || !message?.chat?.id) return;
  const chatId = Number(message.chat.id);
  const privateChat = message.chat.type === "private";
  const parts = String(message.text).trim().split(/\s+/);
  const command = String(parts.shift() || "").split("@")[0].toLowerCase();
  const send = (text: string) => telegramRequest(botToken, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  if (["/bind", "/traffic", "/getlatesturl", "/subscribe", "/unbind"].includes(command) && !privateChat) return send("请在私聊中使用此命令");
  const bound = async () => {
    const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE telegram_id = ?").bind(chatId).first<Record<string, any>>();
    if (!user) await send("请先绑定账号");
    return user;
  };
  if (command === "/start") {
    const user = await env.XBOARD_DB.prepare("SELECT email FROM v2_user WHERE telegram_id = ?").bind(chatId).first<{ email: string }>();
    return send(user
      ? `欢迎使用 XBoard Telegram Bot！\n\n您已绑定账号：${user.email}\n\n可用命令：\n/traffic - 查看流量使用情况\n/getlatesturl - 获取订阅链接\n/unbind - 解绑账号`
      : "欢迎使用 XBoard Telegram Bot！\n\n请发送 /bind 加订阅链接绑定账号。\n例如：/bind https://example.com/s/token");
  }
  if (command === "/bind") {
    const subscription = parts[0];
    if (!subscription) return send("参数有误，请携带订阅地址发送");
    const userToken = telegramSubscriptionToken(subscription);
    if (!userToken) return send("订阅地址无效");
    const user = await env.XBOARD_DB.prepare("SELECT id, telegram_id FROM v2_user WHERE token = ?").bind(userToken).first<Record<string, any>>();
    if (!user) return send("用户不存在");
    if (user.telegram_id !== null && user.telegram_id !== undefined) return send("该账号已经绑定了Telegram账号");
    await env.XBOARD_DB.prepare("UPDATE v2_user SET telegram_id = ?, updated_at = ? WHERE id = ? AND telegram_id IS NULL").bind(chatId, now(), user.id).run();
    return send("绑定成功");
  }
  if (command === "/traffic") {
    const user = await bound(); if (!user) return;
    const used = Number(user.u || 0) + Number(user.d || 0); const total = Number(user.transfer_enable || 0);
    return send(`流量使用情况\n\n已用流量：${telegramGb(used)}G\n总流量：${telegramGb(total)}G\n剩余流量：${telegramGb(total - used)}G\n使用率：${(total > 0 ? used / total * 100 : 0).toFixed(2)}%`);
  }
  if (command === "/getlatesturl" || command === "/subscribe") {
    const user = await bound(); if (!user) return;
    return send(`您的订阅链接：\n\n${await subscribeUrl(request, env, String(user.token))}`);
  }
  if (command === "/unbind") {
    const user = await bound(); if (!user) return;
    await env.XBOARD_DB.prepare("UPDATE v2_user SET telegram_id = NULL, updated_at = ? WHERE id = ?").bind(now(), user.id).run();
    return send("解绑成功");
  }
  if (privateChat) return send("未知命令，请查看帮助");
}

async function guestApi(request: Request, env: Env, path: string) {
  if (request.method === "POST" && path === "/api/v1/guest/telegram/webhook") {
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV); const botToken = String(pickSetting(all, "telegram_bot_token", ""));
    if (new URL(request.url).searchParams.get("access_token") !== md5(botToken)) return fail("access_token is error", 401, 401);
    const update = await body<Record<string, any>>(request);
    const join = update.chat_join_request;
    if (join?.chat?.id && join?.from?.id) {
      const user = await env.XBOARD_DB.prepare("SELECT banned,expired_at,transfer_enable FROM v2_user WHERE telegram_id = ?").bind(Number(join.from.id)).first<Record<string, any>>();
      const available = !!user && userIsAvailable(user);
      try { await telegramRequest(botToken, available ? "approveChatJoinRequest" : "declineChatJoinRequest", { chat_id: join.chat.id, user_id: join.from.id }); } catch (error: any) { return fail(error?.message || "Telegram request failed", 400, 400); }
    }
    if (update.message) {
      try {
        await handleTelegramMessage(request, env, botToken, update.message);
      } catch {
        const chatId = update.message?.chat?.id;
        if (chatId) {
          try { await telegramRequest(botToken, "sendMessage", { chat_id: chatId, text: "系统繁忙，请稍后重试" }); } catch {}
        }
      }
    }
    return ok(true);
  }
  if (request.method === "GET" && path === "/api/v1/guest/plan/fetch") {
    const readEnv = env.PUBLIC_READ_DB ? { ...env, XBOARD_DB: env.PUBLIC_READ_DB, SETTINGS_MEMORY_SCOPE: "public" } : env;
    return ok((await publicPlanRows(request, readEnv)).filter(row => Number(row.show) === 1 && Number(row.sell) === 1));
  }
  if (request.method === "GET" && path === "/api/v1/guest/comm/config") {
    const readDb = env.PUBLIC_READ_DB || env.XBOARD_DB;
    const all = await settings(readDb, env.XBOARD_KV, env.PUBLIC_READ_DB ? "public" : "primary");
    return ok({
      tos_url: pickSetting(all, "tos_url", ""),
      is_email_verify: Number(Boolean(pickSetting(all, "email_verify", 0))),
      is_invite_force: Number(Boolean(pickSetting(all, "invite_force", 0))),
      email_whitelist_suffix: pickSetting(all, "email_whitelist_enable", 0) ? emailSuffixes(pickSetting(all, "email_whitelist_suffix", [])) : 0,
      is_captcha: Number(Boolean(pickSetting(all, "captcha_enable", 0))),
      captcha_type: pickSetting(all, "captcha_type", "recaptcha"),
      recaptcha_site_key: pickSetting(all, "recaptcha_site_key", ""),
      recaptcha_v3_site_key: pickSetting(all, "recaptcha_v3_site_key", ""),
      recaptcha_v3_score_threshold: Number(pickSetting(all, "recaptcha_v3_score_threshold", 0.5)),
      turnstile_site_key: pickSetting(all, "turnstile_site_key", ""),
      app_description: pickSetting(all, "app_description", ""),
      app_url: pickSetting(all, "app_url", ""),
      logo: pickSetting(all, "logo", ""),
      is_recaptcha: Number(Boolean(pickSetting(all, "captcha_enable", 0)))
    });
  }
  return json({ message: "Not Found" }, 404);
}

async function clientUser(request: Request, env: Env) {
  const url = new URL(request.url);
  let input: Record<string, any> = {};
  if (request.method !== "GET" && request.method !== "HEAD") {
    try { input = await body<Record<string, any>>(request.clone()); } catch { input = {}; }
  }
  const clientToken = url.searchParams.get("token") || input.token;
  if (!clientToken) return null;
  return await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE token = ?").bind(String(clientToken)).first<Record<string, any>>();
}

async function clientApi(request: Request, env: Env, path: string) {
  const user = await clientUser(request, env);
  if (!user) return fail(new URL(request.url).searchParams.get("token") ? "token is error" : "token is null", 403, 403);
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  if (request.method === "GET" && path.endsWith("/app/getVersion")) {
    const userAgent = request.headers.get("user-agent") || "";
    if (/tidalab\/4\.0\.0|tunnelab\/4\.0\.0/i.test(userAgent)) {
      const windows = /Win64/i.test(userAgent);
      return ok({
        version: pickSetting(all, windows ? "windows_version" : "macos_version", ""),
        download_url: pickSetting(all, windows ? "windows_download_url" : "macos_download_url", "")
      });
    }
    return ok({
      windows_version: pickSetting(all, "windows_version", ""),
      windows_download_url: pickSetting(all, "windows_download_url", ""),
      macos_version: pickSetting(all, "macos_version", ""),
      macos_download_url: pickSetting(all, "macos_download_url", ""),
      android_version: pickSetting(all, "android_version", ""),
      android_download_url: pickSetting(all, "android_download_url", "")
    });
  }
  if (request.method === "GET" && path === "/api/v1/client/app/getConfig") {
    const baseResponse = await env.ASSETS.fetch(new Request(new URL("/rules/app.clash.yaml", request.url)));
    if (!baseResponse.ok) return fail("Client config template is unavailable", 500, 500);
    const subscription = new URL(request.url);
    subscription.pathname = "/api/v1/client/subscribe";
    subscription.search = "";
    subscription.searchParams.set("token", String(user.token));
    subscription.searchParams.set("flag", "clash");
    const response = await handleSubscriptionRequest(new Request(subscription, { headers: { "user-agent": request.headers.get("user-agent") || "Clash" } }), env);
    if (!response.ok) return new Response(response.body, { status: response.status, headers: response.headers });
    const base = parseYaml(await baseResponse.text()) || {};
    const generated = parseYaml(await response.text()) || {};
    const supportedCiphers = new Set(["aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"]);
    const proxies = (Array.isArray(generated.proxies) ? generated.proxies : []).filter((proxy: Record<string, any>) =>
      proxy?.type === "vmess" || proxy?.type === "trojan" || (proxy?.type === "ss" && supportedCiphers.has(String(proxy.cipher || "")))
    );
    const proxyNames = proxies.map((proxy: Record<string, any>) => proxy.name).filter(Boolean);
    base.proxies = [...(Array.isArray(base.proxies) ? base.proxies : []), ...proxies];
    base["proxy-groups"] = (Array.isArray(base["proxy-groups"]) ? base["proxy-groups"] : []).map((group: Record<string, any>) => ({
      ...group,
      proxies: [...(Array.isArray(group.proxies) ? group.proxies : []), ...proxyNames]
    }));
    return new Response(stringifyYaml(base), { headers: { "content-type": "text/yaml; charset=utf-8" } });
  }
  if (request.method === "GET" && path === "/api/v2/client/app/getConfig") {
    const whitelistSuffix = pickSetting(all, "email_whitelist_suffix", 0);
    const config: Record<string, any> = {
      app_info: {
        app_name: pickSetting(all, "app_name", "XB加速器"),
        app_description: pickSetting(all, "app_description", "专业的网络加速服务"),
        app_url: pickSetting(all, "app_url", "https://app.example.com"),
        logo: pickSetting(all, "logo", "https://example.com/logo.png"),
        version: pickSetting(all, "app_version", "1.0.0")
      },
      features: {
        enable_register: Boolean(pickSetting(all, "app_enable_register", true)),
        enable_invite_system: Boolean(pickSetting(all, "app_enable_invite_system", true)),
        enable_telegram_bot: Boolean(pickSetting(all, "telegram_bot_enable", false)),
        enable_ticket_system: Boolean(pickSetting(all, "app_enable_ticket_system", true)),
        ticket_must_wait_reply: Boolean(pickSetting(all, "ticket_must_wait_reply", false)),
        enable_commission_system: Boolean(pickSetting(all, "app_enable_commission_system", true)),
        enable_traffic_log: Boolean(pickSetting(all, "app_enable_traffic_log", true)),
        enable_knowledge_base: Boolean(pickSetting(all, "app_enable_knowledge_base", true)),
        enable_announcements: Boolean(pickSetting(all, "app_enable_announcements", true)),
        enable_auto_renewal: Boolean(pickSetting(all, "app_enable_auto_renewal", false)),
        enable_coupon_system: Boolean(pickSetting(all, "app_enable_coupon_system", true)),
        enable_speed_test: Boolean(pickSetting(all, "app_enable_speed_test", true)),
        enable_server_ping: Boolean(pickSetting(all, "app_enable_server_ping", true))
      },
      ui_config: {
        theme: {
          primary_color: pickSetting(all, "app_primary_color", "#00C851"), secondary_color: pickSetting(all, "app_secondary_color", "#007E33"),
          accent_color: pickSetting(all, "app_accent_color", "#FF6B35"), background_color: pickSetting(all, "app_background_color", "#F5F5F5"),
          text_color: pickSetting(all, "app_text_color", "#333333")
        },
        home_screen: {
          show_speed_test: Boolean(pickSetting(all, "app_show_speed_test", true)), show_traffic_chart: Boolean(pickSetting(all, "app_show_traffic_chart", true)),
          show_server_ping: Boolean(pickSetting(all, "app_show_server_ping", true)), default_server_sort: pickSetting(all, "app_default_server_sort", "ping"),
          show_connection_status: Boolean(pickSetting(all, "app_show_connection_status", true))
        },
        server_list: {
          show_country_flags: Boolean(pickSetting(all, "app_show_country_flags", true)), show_ping_values: Boolean(pickSetting(all, "app_show_ping_values", true)),
          show_traffic_usage: Boolean(pickSetting(all, "app_show_traffic_usage", true)), group_by_country: Boolean(pickSetting(all, "app_group_by_country", false)),
          show_server_status: Boolean(pickSetting(all, "app_show_server_status", true))
        }
      },
      business_rules: {
        min_password_length: Number(pickSetting(all, "app_min_password_length", 8)), max_login_attempts: Number(pickSetting(all, "app_max_login_attempts", 5)),
        session_timeout_minutes: Number(pickSetting(all, "app_session_timeout_minutes", 30)), auto_disconnect_after_minutes: Number(pickSetting(all, "app_auto_disconnect_after_minutes", 60)),
        max_concurrent_connections: Number(pickSetting(all, "app_max_concurrent_connections", 3)), traffic_warning_threshold: Number(pickSetting(all, "app_traffic_warning_threshold", 0.8)),
        subscription_reminder_days: pickSetting(all, "app_subscription_reminder_days", [7, 3, 1]), connection_timeout_seconds: Number(pickSetting(all, "app_connection_timeout_seconds", 10)),
        health_check_interval_seconds: Number(pickSetting(all, "app_health_check_interval_seconds", 30))
      },
      server_config: {
        default_kernel: pickSetting(all, "app_default_kernel", "clash"), auto_select_fastest: Boolean(pickSetting(all, "app_auto_select_fastest", true)),
        fallback_servers: pickSetting(all, "app_fallback_servers", ["server1", "server2"]), enable_auto_switch: Boolean(pickSetting(all, "app_enable_auto_switch", true)),
        switch_threshold_ms: Number(pickSetting(all, "app_switch_threshold_ms", 1000))
      },
      security_config: {
        tos_url: pickSetting(all, "tos_url", "https://example.com/tos"), privacy_policy_url: pickSetting(all, "app_privacy_policy_url", "https://example.com/privacy"),
        is_email_verify: Number(pickSetting(all, "email_verify", 1)), is_invite_force: Number(pickSetting(all, "invite_force", 0)),
        email_whitelist_suffix: Array.isArray(whitelistSuffix) ? Number(whitelistSuffix.length > 0) : Number(whitelistSuffix), is_captcha: Number(pickSetting(all, "captcha_enable", 1)),
        captcha_type: pickSetting(all, "captcha_type", "recaptcha"), recaptcha_site_key: pickSetting(all, "recaptcha_site_key", "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"),
        recaptcha_v3_site_key: pickSetting(all, "recaptcha_v3_site_key", "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"),
        recaptcha_v3_score_threshold: Number(pickSetting(all, "recaptcha_v3_score_threshold", 0.5)), turnstile_site_key: pickSetting(all, "turnstile_site_key", "0x4AAAAAAAABkMYinukE8nzUg")
      },
      payment_config: {
        currency: pickSetting(all, "currency", "CNY"), currency_symbol: pickSetting(all, "currency_symbol", "¥"),
        withdraw_methods: pickSetting(all, "app_withdraw_methods", ["alipay", "wechat", "bank"]), min_withdraw_amount: Number(pickSetting(all, "app_min_withdraw_amount", 100)),
        withdraw_fee_rate: Number(pickSetting(all, "app_withdraw_fee_rate", 0.01))
      },
      notification_config: {
        enable_push_notifications: Boolean(pickSetting(all, "app_enable_push_notifications", true)), enable_email_notifications: Boolean(pickSetting(all, "app_enable_email_notifications", true)),
        enable_sms_notifications: Boolean(pickSetting(all, "app_enable_sms_notifications", false)),
        notification_schedule: {
          traffic_warning: Boolean(pickSetting(all, "app_notification_traffic_warning", true)), subscription_expiry: Boolean(pickSetting(all, "app_notification_subscription_expiry", true)),
          server_maintenance: Boolean(pickSetting(all, "app_notification_server_maintenance", true)), promotional_offers: Boolean(pickSetting(all, "app_notification_promotional_offers", false))
        }
      },
      cache_config: {
        config_cache_duration: Number(pickSetting(all, "app_config_cache_duration", 3600)), server_list_cache_duration: Number(pickSetting(all, "app_server_list_cache_duration", 1800)),
        user_info_cache_duration: Number(pickSetting(all, "app_user_info_cache_duration", 900))
      },
      last_updated: now()
    };
    config.config_hash = md5(JSON.stringify(config));
    return ok(config);
  }
  return json({ message: "Not Found" }, 404);
}

async function subscribeTemplateMap(env: Env) {
  try {
    const result = await env.XBOARD_DB.prepare("SELECT name, COALESCE(content, template, '') AS content FROM v2_subscribe_templates").all<{ name: string; content: string }>();
    return Object.fromEntries((result.results || []).map(row => [row.name, row.content || ""])) as Record<string, string>;
  } catch {
    try {
      const result = await env.XBOARD_DB.prepare("SELECT name, COALESCE(template, '') AS content FROM v2_subscribe_templates").all<{ name: string; content: string }>();
      return Object.fromEntries((result.results || []).map(row => [row.name, row.content || ""])) as Record<string, string>;
    } catch {
      return {};
    }
  }
}

async function saveSubscribeTemplate(env: Env, settingKey: string, value: unknown) {
  const names: Record<string, string> = {
    subscribe_template_singbox: "singbox",
    subscribe_template_clash: "clash",
    subscribe_template_clashmeta: "clashmeta",
    subscribe_template_stash: "stash",
    subscribe_template_surge: "surge",
    subscribe_template_surfboard: "surfboard"
  };
  const name = names[settingKey];
  if (!name) return false;
  const content = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const ts = now();
  await runSqlIgnore(env, "INSERT INTO v2_subscribe_templates(name, type, content, template, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content, template = excluded.template, enabled = 1, updated_at = excluded.updated_at", [name, name, content, content, ts, ts]);
  await runSqlIgnore(env, "INSERT INTO v2_subscribe_templates(name, content, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at", [name, content, ts, ts]);
  await bump(env.XBOARD_KV, "templates_version");
  return true;
}

const APP_TIMEZONE_OFFSET = 8 * 3600;

function dayStart(ts = now()) {
  const date = new Date((ts + APP_TIMEZONE_OFFSET) * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000) - APP_TIMEZONE_OFFSET;
}

function monthStart(ts = now()) {
  const date = new Date((ts + APP_TIMEZONE_OFFSET) * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000) - APP_TIMEZONE_OFFSET;
}

async function adminStats(env: Env) {
  const current = now();
  const today = dayStart();
  const yesterday = today - 86400;
  const month = monthStart();
  const lastMonth = monthStart(month - 1);
  const twoMonthsAgo = monthStart(lastMonth - 1);
  const nodes = await adminServerRows(env);
  const totalUsers = await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_user");
  const activeUsers = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE expired_at IS NULL OR expired_at >= ${current}`);
  const currentMonthNewUsers = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${month} AND created_at < ${current}`);
  const lastMonthNewUsers = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${lastMonth} AND created_at < ${month}`);
  const todayIncome = await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${today} AND created_at < ${current} AND status NOT IN (0,2)`);
  const yesterdayIncome = await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${yesterday} AND created_at < ${today} AND status NOT IN (0,2)`);
  const currentMonthIncome = await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${month} AND created_at < ${current} AND status NOT IN (0,2)`);
  const lastMonthIncome = await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${lastMonth} AND created_at < ${month} AND status NOT IN (0,2)`);
  const twoMonthsAgoIncome = await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${twoMonthsAgo} AND created_at < ${lastMonth} AND status NOT IN (0,2)`);
  const currentMonthCommissionPayout = await firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${month} AND created_at < ${current}`);
  const lastMonthCommissionPayout = await firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${lastMonth} AND created_at < ${month}`);
  const twoMonthsAgoCommission = await firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${twoMonthsAgo} AND created_at < ${lastMonth}`);
  const monthUpload = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${month} AND record_at < ${current}`);
  const monthDownload = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${month} AND record_at < ${current}`);
  const todayUpload = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${today} AND record_at < ${current}`);
  const todayDownload = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${today} AND record_at < ${current}`);
  const totalUpload = await firstNumber(env, "SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server");
  const totalDownload = await firstNumber(env, "SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server");
  const growth = (value: number, previous: number) => previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : 0;
  return {
    todayIncome,
    dayIncomeGrowth: growth(todayIncome, yesterdayIncome),
    currentMonthIncome,
    lastMonthIncome,
    monthIncomeGrowth: growth(currentMonthIncome, lastMonthIncome),
    lastMonthIncomeGrowth: growth(lastMonthIncome, twoMonthsAgoIncome),
    currentMonthCommissionPayout,
    lastMonthCommissionPayout,
    commissionGrowth: growth(lastMonthCommissionPayout, twoMonthsAgoCommission),
    ticketPendingTotal: await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_ticket WHERE status = 0"),
    commissionPendingTotal: await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_order WHERE commission_status = 0 AND invite_user_id IS NOT NULL AND status = 3 AND commission_balance > 0"),
    currentMonthNewUsers,
    userGrowth: growth(currentMonthNewUsers, lastMonthNewUsers),
    totalUsers,
    activeUsers,
    onlineUsers: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >= ${current - 600}`),
    onlineDevices: await firstNumber(env, `SELECT COALESCE(SUM(online_count), 0) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >= ${current - 600}`),
    onlineNodes: nodes.filter(node => Number((node as any).available_status) > 0).length,
    todayTraffic: { upload: todayUpload, download: todayDownload, total: todayUpload + todayDownload },
    monthTraffic: { upload: monthUpload, download: monthDownload, total: monthUpload + monthDownload },
    totalTraffic: { upload: totalUpload, download: totalDownload, total: totalUpload + totalDownload }
  };
}

function dateString(ts: number) {
  return new Date((ts + APP_TIMEZONE_OFFSET) * 1000).toISOString().slice(0, 10);
}

async function orderStats(env: Env, url: URL) {
  const start = url.searchParams.get("start_date");
  const end = url.searchParams.get("end_date");
  const type = url.searchParams.get("type");
  const allowedTypes = new Set(["paid_total", "paid_count", "commission_total", "commission_count"]);
  const clauses = ["record_type = 'd'"];
  const bindings: number[] = [];
  if (start) {
    clauses.push("record_at >= ?");
    bindings.push(Math.floor(Date.parse(`${start}T00:00:00+08:00`) / 1000));
  }
  if (end) {
    clauses.push("record_at <= ?");
    bindings.push(Math.floor(Date.parse(`${end}T23:59:59+08:00`) / 1000));
  }
  const result = await env.XBOARD_DB.prepare(`SELECT record_at,paid_total,paid_count,commission_total,commission_count FROM v2_stat WHERE ${clauses.join(" AND ")} ORDER BY record_at DESC`)
    .bind(...bindings).all<Record<string, any>>();
  const rows = result.results || [];
  const dailyStats = rows.map(row => {
    const date = dateString(Number(row.record_at || 0));
    if (type && allowedTypes.has(type)) {
      const labels: Record<string, string> = { paid_total: "收款金额", paid_count: "收款笔数", commission_total: "佣金金额", commission_count: "佣金笔数" };
      return { date, value: Number(row[type] || 0), type: labels[type] };
    }
    const paidTotal = Number(row.paid_total || 0);
    const paidCount = Number(row.paid_count || 0);
    const commissionTotal = Number(row.commission_total || 0);
    const commissionCount = Number(row.commission_count || 0);
    return {
      date,
      paid_total: paidTotal,
      paid_count: paidCount,
      commission_total: commissionTotal,
      commission_count: commissionCount,
      avg_order_amount: paidCount > 0 ? Math.round(paidTotal / paidCount * 100) / 100 : 0,
      avg_commission_amount: commissionCount > 0 ? Math.round(commissionTotal / commissionCount * 100) / 100 : 0
    };
  });
  const list = [...dailyStats].reverse();
  const fullRows = rows.map(row => ({
    paid_total: Number(row.paid_total || 0),
    paid_count: Number(row.paid_count || 0),
    commission_total: Number(row.commission_total || 0),
    commission_count: Number(row.commission_count || 0)
  }));
  const paidTotal = fullRows.reduce((sum, item) => sum + item.paid_total, 0);
  const paidCount = fullRows.reduce((sum, item) => sum + item.paid_count, 0);
  const commissionTotal = fullRows.reduce((sum, item) => sum + item.commission_total, 0);
  const commissionCount = fullRows.reduce((sum, item) => sum + item.commission_count, 0);
  return {
    summary: {
      start_date: start || (rows.length ? dateString(Number(rows.at(-1)?.record_at || 0)) : dateString(now())),
      end_date: end || (rows.length ? dateString(Number(rows[0]?.record_at || 0)) : dateString(now())),
      paid_total: paidTotal,
      paid_count: paidCount,
      commission_total: commissionTotal,
      commission_count: commissionCount,
      avg_paid_amount: paidCount ? Math.round(paidTotal / paidCount * 100) / 100 : 0,
      avg_commission_amount: commissionCount ? Math.round(commissionTotal / commissionCount * 100) / 100 : 0,
      commission_rate: paidTotal ? Math.round(commissionTotal / paidTotal * 10000) / 100 : 0
    },
    list
  };
}

async function trafficRank(env: Env, url: URL) {
  const type = url.searchParams.get("type") || "user";
  const start = Number(url.searchParams.get("start_time") || 0);
  const end = Number(url.searchParams.get("end_time") || now());
  const startBucket = Math.floor(start / 30);
  const endBucket = Math.floor(end / 30);
  return cachedData(`traffic-rank:${type}:${startBucket}:${endBucket}`, 30, async () => {
  const previousStart = start - Math.max(0, end - start);
  const calculateChange = (value: number, previousValue: number) => previousValue > 0
    ? Math.round(((value - previousValue) / previousValue) * 1000) / 10
    : 0;
  if (await analyticsRangeAvailable(env, previousStart, end)) {
    const route = type === "node" ? "/internal/traffic/server-rank" : "/internal/traffic/rank";
    const rows = await analyticsData<Record<string, any>[]>(env, route, { start, end, previous_start: previousStart, limit: 10 });
    if (rows?.length) {
      const ids = rows.map(row => Number(type === "node" ? row.server_id : row.user_id)).filter(Boolean);
      const names = ids.length ? await env.XBOARD_DB.prepare(`SELECT id, ${type === "node" ? "name" : "email AS name"} FROM ${type === "node" ? "v2_server" : "v2_user"} WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; name: string }>() : { results: [] as { id: number; name: string }[] };
      const byId = new Map((names.results || []).map(row => [Number(row.id), row.name]));
      return rows.map(row => {
        const id = Number(type === "node" ? row.server_id : row.user_id);
        const value = Number(row.total || 0); const previousValue = Number(row.previous_total || 0);
        return { id: String(id), name: byId.get(id) || `${type === "node" ? "Node" : "User"} ${id}`, value, previousValue, change: calculateChange(value, previousValue), timestamp: new Date(end * 1000).toISOString() };
      });
    }
  }
  if (type === "node") {
    try {
      const rows = await env.XBOARD_DB.prepare(
        `WITH traffic AS (
           SELECT server_id AS id,
             SUM(CASE WHEN record_at >= ? AND record_at <= ? THEN u + d ELSE 0 END) AS value,
             SUM(CASE WHEN record_at >= ? AND record_at < ? THEN u + d ELSE 0 END) AS previousValue
           FROM v2_stat_server
           WHERE record_at >= ? AND record_at <= ? AND COALESCE(record_type, 'd') = 'd'
           GROUP BY server_id
         )
         SELECT traffic.id, s.name, COALESCE(traffic.value, 0) AS value, COALESCE(traffic.previousValue, 0) AS previousValue
         FROM traffic LEFT JOIN v2_server s ON s.id = traffic.id
         WHERE traffic.value > 0 ORDER BY traffic.value DESC LIMIT 10`
      ).bind(start, end, previousStart, start, previousStart, end).all<{ id: number; name: string; value: number; previousValue: number }>();
      const ranked = (rows.results || []).map(row => {
        const value = Number(row.value || 0); const previousValue = Number(row.previousValue || 0);
        return { id: String(row.id), name: row.name || `Node ${row.id}`, value, previousValue, change: calculateChange(value, previousValue), timestamp: new Date(end * 1000).toISOString() };
      });
      if (ranked.length) return ranked;
      const fallback = await env.XBOARD_DB.prepare("SELECT name, COALESCE(u, 0) + COALESCE(d, 0) AS value FROM v2_server ORDER BY value DESC, id ASC LIMIT 10").all<{ name: string; value: number }>();
      return (fallback.results || []).map(row => ({ name: row.name || "Node", value: Number(row.value || 0), previousValue: 0, change: 0, timestamp: new Date(end * 1000).toISOString() }));
    } catch {
      return [];
    }
  }
  try {
    const rows = await env.XBOARD_DB.prepare(
      `WITH traffic AS (
         SELECT user_id AS id,
           SUM(CASE WHEN record_at >= ? AND record_at <= ? THEN u + d ELSE 0 END) AS value,
           SUM(CASE WHEN record_at >= ? AND record_at < ? THEN u + d ELSE 0 END) AS previousValue
         FROM v2_stat_user
         WHERE record_at >= ? AND record_at <= ? AND COALESCE(record_type, 'd') = 'd'
         GROUP BY user_id
       )
       SELECT traffic.id, u.email AS name, COALESCE(traffic.value, 0) AS value, COALESCE(traffic.previousValue, 0) AS previousValue
       FROM traffic LEFT JOIN v2_user u ON u.id = traffic.id
       WHERE traffic.value > 0 ORDER BY traffic.value DESC LIMIT 10`
    ).bind(start, end, previousStart, start, previousStart, end).all<{ id: number; name: string; value: number; previousValue: number }>();
    const ranked = (rows.results || []).map(row => {
      const value = Number(row.value || 0); const previousValue = Number(row.previousValue || 0);
      return { id: String(row.id), name: row.name || `User ${row.id}`, value, previousValue, change: calculateChange(value, previousValue), timestamp: new Date(end * 1000).toISOString() };
    });
    if (ranked.length) return ranked;
    const fallback = await env.XBOARD_DB.prepare("SELECT email AS name, COALESCE(u, 0) + COALESCE(d, 0) AS value FROM v2_user ORDER BY value DESC, id ASC LIMIT 10").all<{ name: string; value: number }>();
    return (fallback.results || []).map(row => ({ name: row.name || "User", value: Number(row.value || 0), previousValue: 0, change: 0, timestamp: new Date(end * 1000).toISOString() }));
  } catch {
    return [];
  }
  });
}

async function planById(env: Env, id: unknown) {
  if (!id) return null;
  return await env.XBOARD_DB.prepare("SELECT id, name FROM v2_plan WHERE id = ?").bind(id).first();
}

async function groupById(env: Env, id: unknown) {
  if (!id) return null;
  return await env.XBOARD_DB.prepare("SELECT id, name FROM v2_server_group WHERE id = ?").bind(id).first();
}

async function adminServerGroupRows(env: Env) {
  const [groupsResult, usersResult, serversResult] = await Promise.all([
    env.XBOARD_DB.prepare("SELECT * FROM v2_server_group ORDER BY id DESC").all<Record<string, any>>(),
    env.XBOARD_DB.prepare("SELECT group_id, COUNT(*) AS count FROM v2_user WHERE group_id IS NOT NULL GROUP BY group_id").all<{ group_id: number; count: number }>(),
    env.XBOARD_DB.prepare("SELECT group_ids FROM v2_server").all<{ group_ids: string | null }>()
  ]);
  const userCounts = new Map((usersResult.results || []).map(row => [Number(row.group_id), Number(row.count || 0)]));
  const serverCounts = new Map<number, number>();
  for (const server of serversResult.results || []) {
    for (const groupId of new Set(parseJsonArray(server.group_ids).map(Number).filter(Number.isFinite))) {
      serverCounts.set(groupId, (serverCounts.get(groupId) || 0) + 1);
    }
  }
  return (groupsResult.results || []).map(group => ({
    ...group,
    users_count: userCounts.get(Number(group.id)) || 0,
    server_count: serverCounts.get(Number(group.id)) || 0
  }));
}

const adminUserFields: Record<string, string> = {
  id: "u.id", email: "u.email", plan_id: "u.plan_id", group_id: "u.group_id", banned: "u.banned", is_admin: "u.is_admin",
  is_staff: "u.is_staff", balance: "u.balance", commission_balance: "u.commission_balance", transfer_enable: "u.transfer_enable",
  u: "u.u", d: "u.d", total_used: "(COALESCE(u.u, 0) + COALESCE(u.d, 0))", created_at: "u.created_at", updated_at: "u.updated_at",
  expired_at: "u.expired_at", plan_name: "p.name", "plan.name": "p.name", group_name: "g.name", "group.name": "g.name",
  "invite_user.email": "iu.email", invite_user_id: "u.invite_user_id", group_ids: "u.group_id"
};

function adminUserQuery(input: Record<string, any>) {
  const clauses: Array<{ sql: string; logic: "AND" | "OR" }> = [];
  const bindings: any[] = [];
  for (const filter of parseJsonArray(input.filter)) {
    const field = adminUserFields[String(filter?.id || "")];
    const value = filter?.value;
    if (!field || value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      clauses.push({ sql: `${field} IN (${value.map(() => "?").join(",")})`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      bindings.push(...value);
      continue;
    }
    const nullOperator = String(value).toLowerCase();
    if (nullOperator === "null" || nullOperator === "notnull") {
      clauses.push({ sql: `${field} IS ${nullOperator === "notnull" ? "NOT " : ""}NULL`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      continue;
    }
    const match = String(value).match(/^(eq|neq|gt|gte|lt|lte):(.*)$/s);
    if (match) {
      const operators: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
      clauses.push({ sql: `${field} ${operators[match[1]]} ?`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      bindings.push(match[2]);
    } else {
      clauses.push({ sql: `${field} LIKE ?`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      bindings.push(`%${String(value)}%`);
    }
  }
  const sort = parseJsonArray(input.sort)
    .map(item => ({ field: adminUserFields[String(item?.id || "")], direction: item?.desc ? "DESC" : "ASC" }))
    .filter(item => item.field);
  return {
    where: clauses.length ? ` WHERE ${clauses.map((clause, index) => `${index ? clause.logic : ""} (${clause.sql})`).join(" ")}` : "",
    bindings,
    order: [...sort.map(item => `${item.field} ${item.direction}`), "u.id DESC"].join(", ")
  };
}

async function adminUserList(env: Env, request: Request) {
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  const url = new URL(request.url);
  const page = Math.max(1, Number(input.page || input.current || url.searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.page_size || input.pageSize || input.limit || url.searchParams.get("page_size") || 20)));
  const query = adminUserQuery(input);
  const [usersResult, countResult] = await Promise.all([
    env.XBOARD_DB.prepare(`SELECT u.* FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id LEFT JOIN v2_server_group g ON g.id = u.group_id LEFT JOIN v2_user iu ON iu.id = u.invite_user_id${query.where} ORDER BY ${query.order} LIMIT ? OFFSET ?`)
      .bind(...query.bindings, pageSize, (page - 1) * pageSize).all<Record<string, any>>(),
    env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id LEFT JOIN v2_server_group g ON g.id = u.group_id LEFT JOIN v2_user iu ON iu.id = u.invite_user_id${query.where}`)
      .bind(...query.bindings).first<{ count: number }>()
  ]);
  const userRows = usersResult.results || [];
  const inviterIds = [...new Set(userRows.map(row => Number(row.invite_user_id || 0)).filter(Boolean))];
  const planIds = [...new Set(userRows.map(row => Number(row.plan_id || 0)).filter(Boolean))];
  const groupIds = [...new Set(userRows.map(row => Number(row.group_id || 0)).filter(Boolean))];
  const inviters = new Map<number, { id: number; email: string }>();
  const [inviterRows, planRows, groupRows] = await Promise.all([
    inviterIds.length ? env.XBOARD_DB.prepare(`SELECT id, email FROM v2_user WHERE id IN (${inviterIds.map(() => "?").join(",")})`).bind(...inviterIds).all<any>() : Promise.resolve({ results: [] }),
    planIds.length ? env.XBOARD_DB.prepare(`SELECT * FROM v2_plan WHERE id IN (${planIds.map(() => "?").join(",")})`).bind(...planIds).all<any>() : Promise.resolve({ results: [] }),
    groupIds.length ? env.XBOARD_DB.prepare(`SELECT * FROM v2_server_group WHERE id IN (${groupIds.map(() => "?").join(",")})`).bind(...groupIds).all<any>() : Promise.resolve({ results: [] })
  ]);
  for (const inviter of inviterRows.results || []) inviters.set(Number(inviter.id), { id: Number(inviter.id), email: String(inviter.email || "") });
  const plans = new Map((planRows.results || []).map((row: any) => [Number(row.id), { ...row, prices: parseJsonObject(row.prices), tags: parseJsonArray(row.tags) }]));
  const groups = new Map((groupRows.results || []).map((row: any) => [Number(row.id), row]));
  const data = await Promise.all(userRows.map(async row => ({
      ...safeUser(row),
      balance: Number(row.balance || 0) / 100,
      commission_balance: Number(row.commission_balance || 0) / 100,
      commission_type: Number(row.commission_type ?? 0),
      total_used: Number(row.u || 0) + Number(row.d || 0),
      used_traffic: Number(row.u || 0) + Number(row.d || 0),
      subscribe_url: await subscribeUrl(request, env, row.token),
      plan: plans.get(Number(row.plan_id || 0)) || null,
      group: groups.get(Number(row.group_id || 0)) || null,
      invite_user: inviters.get(Number(row.invite_user_id || 0)) || null,
      online_count: Number(row.online_count || 0)
    })));
  return paginated(data, Number(countResult?.count || 0), page, pageSize);
}

async function adminPlanRows(env: Env) {
  const plans = await rows(env.XBOARD_DB, "v2_plan", 1000) as any[];
  const out = [];
  for (const plan of plans) {
    out.push({
      ...plan,
      group: await groupById(env, plan.group_id),
      users_count: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE plan_id = ${Number(plan.id)}`),
      active_users_count: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE plan_id = ${Number(plan.id)} AND (expired_at IS NULL OR expired_at > ${now()})`),
      prices: typeof plan.prices === "string" ? (() => { try { return JSON.parse(plan.prices || "{}"); } catch { return {}; } })() : plan.prices,
      tags: parseJsonArray(plan.tags)
    });
  }
  return out;
}

function requestLanguage(request: Request) {
  const language = (request.headers.get("content-language") || request.headers.get("accept-language") || "").toLowerCase();
  if (language.startsWith("ru")) return "ru";
  if (language.startsWith("zh")) return "zh";
  return "en";
}

async function publicPlanRows(request: Request, env: Env) {
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV, env.SETTINGS_MEMORY_SCOPE || "primary");
  const language = requestLanguage(request);
  const text = {
    en: { unlimited: "No Limit", soldOut: "Sold out", reset: ["First Day of Month", "Monthly", "Never", "First Day of Year", "Yearly"] },
    zh: { unlimited: "无限制", soldOut: "已售罄", reset: ["每月1号", "按月重置", "不重置", "每年1月1日", "按年重置"] },
    ru: { unlimited: "Без ограничений", soldOut: "Распродано", reset: ["Первый день месяца", "Ежемесячно", "Никогда", "Первый день года", "Ежегодно"] }
  }[language];
  return (await adminPlanRows(env)).map(plan => {
    const prices = parseJsonObject(plan.prices);
    const resetMethod = plan.reset_traffic_method === null || plan.reset_traffic_method === undefined
      ? Number(pickSetting(all, "reset_traffic_method", 1))
      : Number(plan.reset_traffic_method);
    const replacements: Record<string, unknown> = {
      "{{transfer}}": plan.transfer_enable,
      "{{speed}}": plan.speed_limit === null || plan.speed_limit === undefined ? text.unlimited : plan.speed_limit,
      "{{devices}}": plan.device_limit === null || plan.device_limit === undefined ? text.unlimited : plan.device_limit,
      "{{reset_method}}": text.reset[resetMethod] || text.reset[1]
    };
    let content = String(plan.content || "");
    for (const [key, value] of Object.entries(replacements)) content = content.replaceAll(key, String(value));
    return {
      id: plan.id, group_id: plan.group_id, name: plan.name, tags: parseJsonArray(plan.tags), content,
      ...Object.fromEntries(Object.entries(orderPeriods).map(([legacy, current]) => {
        const value = prices[current];
        return [legacy, value === null || value === undefined || value === "" ? null : Number(value) * 100];
      })),
      capacity_limit: plan.capacity_limit === null || plan.capacity_limit === undefined
        ? null
        : Number(plan.capacity_limit) <= 0 ? text.soldOut : Number(plan.capacity_limit),
      transfer_enable: plan.transfer_enable, speed_limit: plan.speed_limit, device_limit: plan.device_limit,
      show: Boolean(Number(plan.show)), sell: Boolean(Number(plan.sell)), renew: Boolean(Number(plan.renew)),
      reset_traffic_method: plan.reset_traffic_method, sort: plan.sort, created_at: plan.created_at, updated_at: plan.updated_at
    };
  });
}

async function adminRouteRows(env: Env) {
  const routes = await rows(env.XBOARD_DB, "v2_server_route", 1000) as any[];
  return routes.map(route => ({
    ...route,
    match: routeMatchArray(route.match)
  }));
}

function nodeAvailableStatus(lastCheckAt: number | null, lastPushAt: number | null, timestamp = now()) {
  if (!lastCheckAt || timestamp - 300 >= lastCheckAt) return 0;
  if (!lastPushAt || timestamp - 300 >= lastPushAt) return 1;
  return 2;
}

function parseKvObject(value: string | null) {
  return value ? parseJsonObject(value) : null;
}

type StatusSnapshot = { machines: Record<string, Record<string, any>>; nodes: Record<string, Record<string, any>> };
let statusSnapshotCache: { value: StatusSnapshot; expiresAt: number } | null = null;

async function statusHubRequest(env: Env, path: string, init: RequestInit = {}) {
  return env.XBOARD_SERVER.fetch(`https://xboard-server.internal/internal/status/${path}`, {
    ...init,
    headers: { ...(init.headers || {}), "x-xboard-internal-token": await internalSyncToken(env) }
  });
}

async function statusSnapshot(env: Env): Promise<StatusSnapshot> {
  if (statusSnapshotCache && statusSnapshotCache.expiresAt > Date.now()) return statusSnapshotCache.value;
  try {
    const response = await statusHubRequest(env, "snapshot");
    if (!response.ok) throw new Error(`StatusHub returned ${response.status}`);
    const payload = await response.json() as { data?: StatusSnapshot };
    const value = payload.data || { machines: {}, nodes: {} };
    statusSnapshotCache = { value, expiresAt: Date.now() + 2_000 };
    return value;
  } catch {
    return { machines: {}, nodes: {} };
  }
}

async function clearStatus(env: Env, kind: "machine" | "node", id: number) {
  statusSnapshotCache = null;
  try {
    await statusHubRequest(env, "clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id })
    });
  } catch { /* Stale runtime state is ignored when its D1 configuration no longer exists. */ }
}

async function optionalKvGet(env: Env, key: string) {
  try { return await env.XBOARD_KV.get(key); } catch { return null; }
}

async function optionalKvPut(env: Env, key: string, value: string) {
  try { await env.XBOARD_KV.put(key, value); } catch { /* D1 remains the source of truth when KV is unavailable. */ }
}

async function optionalKvPutTtl(env: Env, key: string, value: string, expirationTtl: number) {
  try { await env.XBOARD_KV.put(key, value, { expirationTtl }); } catch { /* Verification mail can still be queued when KV is temporarily unavailable. */ }
}

function normalizePublicPort(value: unknown) {
  const port = String(value ?? "").trim();
  return /^\d+\.0+$/.test(port) ? port.slice(0, port.indexOf(".")) : port;
}

async function adminServerRows(env: Env): Promise<Record<string, any>[]> {
  const [serverResult, machineResult, live] = await Promise.all([
    env.XBOARD_DB.prepare("SELECT * FROM v2_server ORDER BY sort ASC, id ASC LIMIT 1000").all<Record<string, any>>(),
    env.XBOARD_DB.prepare("SELECT * FROM v2_server_machine ORDER BY id ASC LIMIT 1000").all<Record<string, any>>(),
    statusSnapshot(env)
  ]);
  const servers = serverResult.results || [];
  const machines = machineResult.results || [];
  const out = [];
  for (const server of servers) {
    const stateId = Number(server.parent_id || server.id);
    const ownId = Number(server.id);
    const machine = Number(server.machine_id) > 0 ? machines.find(item => Number(item.id) === Number(server.machine_id)) : null;
    const nodeState = live.nodes[String(stateId)] || (stateId !== ownId ? live.nodes[String(ownId)] : null) || {};
    const machineState = machine ? live.machines[String(machine.id)] || {} : {};
    const machineSeenAt = machine && Number(machine.is_active ?? machine.enabled ?? 1) === 1 && machineState.connected !== false ? Number(machineState.last_seen_at || 0) : 0;
    const machineOnline = machineSeenAt > 0 && now() - 300 < machineSeenAt;
    const lastCheckAt = Math.max(Number(nodeState.last_check_at || 0), machineOnline ? machineSeenAt : 0) || null;
    const lastPushAt = Math.max(Number(nodeState.last_push_at || 0), machineOnline ? machineSeenAt : 0) || null;
    const availableStatus = nodeAvailableStatus(lastCheckAt, lastPushAt);
    const loadStatus = nodeState.load_status || machineState.load_status || null;
    const metrics = nodeState.metrics || (loadStatus?.metrics && typeof loadStatus.metrics === "object" ? loadStatus.metrics : null);
    const groupIds = parseJsonArray(server.group_ids);
    const groups = [];
    for (const id of groupIds) {
      const group = await groupById(env, id);
      if (group) groups.push(group);
    }
    out.push({
      ...server,
      port: normalizePublicPort(server.port),
      show: Boolean(Number(server.show ?? 1)),
      enabled: Boolean(Number(server.enabled ?? 1)),
      rate_time_enable: Boolean(Number(server.rate_time_enable || 0)),
      rate_time_ranges: parseJsonArray(server.rate_time_ranges),
      group_ids: groupIds,
      route_ids: parseJsonArray(server.route_ids),
      tags: parseJsonArray(server.tags),
      protocol_settings: parseJsonObject(server.protocol_settings),
      custom_outbounds: parseJsonArray(server.custom_outbounds),
      custom_routes: parseJsonArray(server.custom_routes),
      cert_config: isNilLike(server.cert_config) ? null : parseJsonObject(server.cert_config),
      groups,
      parent: server.parent_id ? servers.find(s => Number(s.id) === Number(server.parent_id)) || null : null,
      machine: machine ? { ...machine, token: undefined, load_status: loadStatus } : null,
      last_check_at: lastCheckAt,
      last_push_at: lastPushAt,
      online: Number(nodeState.online || 0),
      is_online: availableStatus === 0 ? 0 : 1,
      available_status: availableStatus,
      cache_key: `${server.type}-${server.id}-${server.updated_at}-${availableStatus === 0 ? 0 : 1}`,
      load_status: loadStatus,
      metrics,
      online_conn: Number(metrics?.active_connections || 0)
    });
  }
  return out;
}

async function adminMachineRows(env: Env) {
  const [result, live] = await Promise.all([
    env.XBOARD_DB.prepare("SELECT * FROM v2_server_machine ORDER BY id ASC LIMIT 1000").all<Record<string, any>>(),
    statusSnapshot(env)
  ]);
  const machines = result.results || [];
  const out = [];
  for (const machine of machines) {
    const { token: _token, ...safeMachine } = machine;
    const machineState = live.machines[String(machine.id)] || {};
    out.push({
      ...safeMachine,
      notes: machine.notes || "",
      is_active: Boolean(Number(machine.is_active ?? machine.enabled ?? 1)),
      last_seen_at: machineState.last_seen_at || null,
      load_status: machineState.load_status || null,
      servers_count: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_server WHERE machine_id = ${Number(machine.id)}`)
    });
  }
  return out;
}

async function adminMachineHistory(env: Env, url: URL) {
  const machineIdValue = url.searchParams.get("machine_id") || url.searchParams.get("id");
  const limitValue = url.searchParams.get("limit");
  const rangeRaw = url.searchParams.get("range_hours") || url.searchParams.get("range");
  const rangeHoursValue = rangeRaw?.match(/^\d+h$/) ? rangeRaw.slice(0, -1) : rangeRaw;
  const machineId = nullableNumber(machineIdValue);
  const limit = limitValue === null || limitValue === "" ? 60 : nullableNumber(limitValue);
  const rangeHours = rangeHoursValue === null || rangeHoursValue === "" ? null : nullableNumber(rangeHoursValue);

  if (!machineId || !Number.isInteger(machineId)) return fail("machine_id 字段是必须的", 422, 422);
  if (!limit || !Number.isInteger(limit) || limit < 10 || limit > 1440) return fail("limit 必须在 10 到 1440 之间", 422, 422);
  if (rangeHours !== null && (!Number.isInteger(rangeHours) || rangeHours < 1 || rangeHours > 24)) {
    return fail("range_hours 必须在 1 到 24 之间", 422, 422);
  }

  const machine = await env.XBOARD_DB.prepare("SELECT id FROM v2_server_machine WHERE id = ?").bind(machineId).first();
  if (!machine) return fail("服务器不存在", 422, 422);
  const end = now();
  const aeRows = await analyticsData<Record<string, unknown>[]>(env, "/internal/runtime/load", {
    entity_id: machineId, start: end - (rangeHours || 24) * 3600, end, limit
  });
  const params = new URLSearchParams({ machine_id: String(machineId), limit: String(limit) });
  if (rangeHours !== null) params.set("range_hours", String(rangeHours));
  let statusRows: Record<string, unknown>[] | null = null;
  try {
    const response = await statusHubRequest(env, `history?${params}`);
    if (response.ok) {
      const payload = await response.json() as { data?: Record<string, unknown>[] };
      statusRows = Array.isArray(payload.data) ? payload.data : [];
    }
  } catch {}
  if (!statusRows && !aeRows) return fail("获取服务器负载历史失败", 500, 500);

  const merged = new Map<number, Record<string, unknown>>();
  for (const row of statusRows || []) {
    const recordedAt = Number(row.recorded_at || 0);
    if (recordedAt) merged.set(recordedAt, row);
  }
  // AE contains the post-cutover copy, so prefer it when both stores contain the same sample.
  for (const row of aeRows || []) {
    const recordedAt = Number(row.recorded_at || 0);
    if (recordedAt) merged.set(recordedAt, row);
  }
  return ok([...merged.values()]
    .sort((left, right) => Number(left.recorded_at || 0) - Number(right.recorded_at || 0))
    .slice(-limit));
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function machineInstallCommand(request: Request, env: Env, machineToken: string, machineId: number) {
  const configured = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const panelUrl = String(configured.app_url || new URL(request.url).origin).replace(/\/$/, "");
  const installerUrl = "https://raw.githubusercontent.com/cedar2025/xboard-node/dev/install.sh";
  return `curl -fsSL ${installerUrl} | sudo bash -s -- --mode machine --panel ${shellQuote(panelUrl)} --token ${shellQuote(machineToken)} --machine-id ${machineId}`;
}

async function saveMachine(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const id = nullableNumber(input.id);
  const name = String(input.name || "").trim();
  if (!name) return fail("服务器名称不能为空", 422, 422);
  const notes = isNilLike(input.notes) ? null : String(input.notes);
  const isActive = boolNumber(input.is_active ?? input.enabled, 1);
  const ts = now();
  if (id) {
    const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_server_machine WHERE id = ?").bind(id).first();
    if (!existing) return fail("服务器不存在", 404, 400202);
    const result = await env.XBOARD_DB.prepare("UPDATE v2_server_machine SET name = ?, notes = ?, is_active = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .bind(name, notes, isActive, isActive, ts, id).run();
    if (!result.success) return fail("保存服务器失败", 500, 500);
    return ok(true);
  }
  const machineToken = randomString(32);
  const result = await env.XBOARD_DB.prepare("INSERT INTO v2_server_machine(name, notes, token, enabled, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(name, notes, machineToken, isActive, isActive, ts, ts).run();
  if (!result.success) return fail("保存服务器失败", 500, 500);
  const machine = await env.XBOARD_DB.prepare("SELECT id FROM v2_server_machine WHERE token = ?").bind(machineToken).first<{ id: number }>();
  return ok({ id: machine?.id, token: machineToken, install_command: await machineInstallCommand(request, env, machineToken, Number(machine?.id)) });
}

function nullableNumber(value: unknown): number | null {
  if (value === "" || value === null || value === undefined || value === "null") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolNumber(value: unknown, fallback = 1) {
  if (value === "" || value === null || value === undefined || value === "null") return fallback;
  if (value === true || value === "true") return 1;
  if (value === false || value === "false") return 0;
  return Number(value) ? 1 : 0;
}

function userIsAvailable(user: Record<string, any>) {
  return !Number(user.banned)
    && (user.expired_at === null || user.expired_at === undefined || Number(user.expired_at) > now())
    && Number(user.transfer_enable || 0) > 0;
}

function phpUrlEncode(value: string) {
  return encodeURIComponent(value).replace(/%20/g, "+").replace(/~/g, "%7E");
}

function normalizeServerInput(input: Record<string, any>) {
  const protocolSettings = parseJsonObject(input.protocol_settings);
  const serverType = String(input.type || input.server_type || protocolSettings.type || "shadowsocks");
  // The public port may be an upstream-compatible dynamic range such as
  // "20000-30000". Keep its textual representation instead of coercing it.
  const port = normalizePublicPort(input.port);
  const serverPort = Number(input.server_port);
  return {
    type: serverType,
    name: String(input.name || `${serverType} Node`),
    parent_id: nullableNumber(input.parent_id) || null,
    group_ids: JSON.stringify(parseJsonArray(input.group_ids).length ? parseJsonArray(input.group_ids).map(Number) : [1]),
    route_ids: JSON.stringify(parseJsonArray(input.route_ids).map(Number)),
    host: String(input.host || input.address || "127.0.0.1"),
    port,
    server_port: serverPort,
    rate: Number(input.rate || 1),
    tags: JSON.stringify(parseJsonArray(input.tags)),
    protocol_settings: JSON.stringify(protocolSettings),
    custom_outbounds: JSON.stringify(parseJsonArray(input.custom_outbounds)),
    custom_routes: JSON.stringify(parseJsonArray(input.custom_routes)),
    cert_config: isNilLike(input.cert_config) ? null : JSON.stringify(input.cert_config),
    machine_id: nullableNumber(input.machine_id),
    show: boolNumber(input.show, 1),
    enabled: boolNumber(input.enabled, 1),
    sort: Number(input.sort || input.order || 0),
    listen_address: String(input.listen_address || ""),
    rate_time_enable: boolNumber(input.rate_time_enable, 0),
    rate_time_ranges: JSON.stringify(parseJsonArray(input.rate_time_ranges)),
    transfer_enable: input.transfer_enable ? Number(input.transfer_enable) : input.transfer_enable_gb ? Math.round(Number(input.transfer_enable_gb) * 1073741824) : 0,
    excludes: JSON.stringify(parseJsonArray(input.excludes)),
    ips: JSON.stringify(parseJsonArray(input.ips)),
    code: input.code ? String(input.code) : null
  };
}

const validServerTypes = new Set(["hysteria", "vless", "trojan", "vmess", "tuic", "shadowsocks", "anytls", "socks", "naive", "http", "mieru"]);

function validateServerInput(input: Record<string, any>): Response | null {
  const type = String(input.type || "");
  if (!validServerTypes.has(type)) return fail("type 的值不合法", 422, 422);
  if (!input.protocol_settings || typeof input.protocol_settings !== "object" || Array.isArray(input.protocol_settings)) return fail("protocol_settings 格式不正确", 422, 422);
  const settings = input.protocol_settings as Record<string, any>;
  const requiredString = (key: string, label: string) => typeof settings[key] === "string" && settings[key].trim() ? null : fail(`${label} 不能为空`, 422, 422);
  const requiredInteger = (key: string, label: string) => Number.isInteger(Number(settings[key])) ? null : fail(`${label} 必须是整数`, 422, 422);
  if (type === "shadowsocks") return requiredString("cipher", "加密方式");
  if (["vmess", "vless"].includes(type)) return requiredInteger("tls", "TLS") || requiredString("network", "传输协议");
  if (type === "trojan") return requiredString("network", "传输协议");
  if (type === "hysteria") return requiredInteger("version", "协议版本");
  if (["naive", "http"].includes(type)) return requiredInteger("tls", "TLS");
  if (type === "mieru") {
    const transport = requiredString("transport", "传输方式");
    if (transport) return transport;
    if (!["TCP", "UDP"].includes(String(settings.transport))) return fail("传输方式的值不合法", 422, 422);
  }
  if (type === "tuic" && settings.version !== null && settings.version !== undefined && !Number.isInteger(Number(settings.version))) return fail("协议版本必须是整数", 422, 422);
  if (type === "anytls" && settings.tls !== null && settings.tls !== undefined && (typeof settings.tls !== "object" || Array.isArray(settings.tls))) return fail("TLS 格式不正确", 422, 422);
  return null;
}

async function saveServer(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  for (const field of ["type", "name", "host", "port", "server_port", "rate"]) {
    if (isNilLike(input[field])) return fail(`${field} 字段不能为空`, 422, 422);
  }
  if (![input.server_port, input.rate].every(value => Number.isFinite(Number(value)))) return fail("服务端口和倍率必须是数字", 422, 422);
  const validation = validateServerInput(input);
  if (validation) return validation;
  const data = normalizeServerInput(input);
  const columns = await tableColumns(env, "v2_server");
  const allowed = Object.entries(data).filter(([key]) => columns.has(key));
  const ts = now();
  const id = nullableNumber(input.id);
  let saved = false;
  try {
    if (id) {
      const set = allowed.map(([key]) => `${key} = ?`).join(", ");
      if (!set) return fail("保存服务器失败: 没有可保存的字段", 400, 400);
      const result = await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id = ?`).bind(...allowed.map(([, value]) => bindValue(value)), ts, id).run();
      if (!result.success) throw new Error("D1 更新服务器失败");
    } else {
      const cols = [...allowed.map(([key]) => key), "created_at", "updated_at"];
      const result = await env.XBOARD_DB.prepare(`INSERT INTO v2_server(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...allowed.map(([, value]) => bindValue(value)), ts, ts).run();
      if (!result.success) throw new Error("D1 创建服务器失败");
    }
    saved = true;
  } catch (error: any) {
    try {
      const minimal = {
        type: data.type,
        name: data.name,
        group_ids: data.group_ids,
        route_ids: data.route_ids,
        host: data.host,
        port: data.port,
        server_port: data.server_port,
        rate: data.rate,
        tags: data.tags,
        protocol_settings: data.protocol_settings,
        show: data.show,
        enabled: data.enabled,
        sort: data.sort
      };
      const fallbackColumns = await tableColumns(env, "v2_server");
      const fallbackAllowed = Object.entries(minimal).filter(([key]) => fallbackColumns.has(key));
      if (id) {
        const set = fallbackAllowed.map(([key]) => `${key} = ?`).join(", ");
        if (!set) throw new Error("没有兼容字段可保存");
        const result = await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id = ?`).bind(...fallbackAllowed.map(([, value]) => bindValue(value)), ts, id).run();
        if (!result.success) throw new Error("D1 兼容更新服务器失败");
      } else {
        const cols = [...fallbackAllowed.map(([key]) => key), "created_at", "updated_at"];
        const result = await env.XBOARD_DB.prepare(`INSERT INTO v2_server(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...fallbackAllowed.map(([, value]) => bindValue(value)), ts, ts).run();
        if (!result.success) throw new Error("D1 兼容创建服务器失败");
      }
      saved = true;
    } catch (fallbackError: any) {
      console.error("saveServer failed", { error: error?.message, fallback: fallbackError?.message });
      return fail("保存服务器失败，请检查字段后重试", 500, 500);
    }
  }
  if (!saved) return fail("保存服务器失败: D1 写入未完成", 500, 500);
  try {
    await bump(env.XBOARD_KV, "servers_version");
  } catch {
    // The server is already persisted. Cache invalidation must not turn a successful save into an API failure.
  }
  return ok(true);
}

async function updateServer(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const id = nullableNumber(input.id);
  if (!id) return fail("服务器不存在", 400, 400202);
  const data: Record<string, any> = {};
  if ("show" in input) data.show = boolNumber(input.show, 1);
  if ("enabled" in input) data.enabled = boolNumber(input.enabled, 1);
  if ("machine_id" in input) data.machine_id = nullableNumber(input.machine_id);
  if (!Object.keys(data).length) return ok(true);
  const set = Object.keys(data).map(key => `${key} = ?`).join(", ");
  const result = await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id = ?`).bind(...Object.values(data), now(), id).run();
  if (Number((result.meta as any)?.changes || 0) !== 1) return fail("服务器不存在", 400, 400202);
  await bump(env.XBOARD_KV, "servers_version");
  return ok(true);
}

async function sortServers(request: Request, env: Env) {
  const input = await body<any>(request);
  const items = Array.isArray(input) ? input : Array.isArray(input?.data) ? input.data : [];
  for (const item of items) {
    if (item?.id !== undefined && item?.order !== undefined) {
      await env.XBOARD_DB.prepare("UPDATE v2_server SET sort = ?, updated_at = ? WHERE id = ?").bind(Number(item.order), now(), Number(item.id)).run();
    }
  }
  await bump(env.XBOARD_KV, "servers_version");
  return ok(true);
}

async function copyServer(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const id = nullableNumber(input.id);
  if (!id) return fail("服务器不存在", 400, 400202);
  const server = await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!server) return fail("服务器不存在", 400, 400202);
  delete server.id;
  server.code = null;
  server.show = 0;
  server.u = 0;
  server.d = 0;
  server.created_at = now();
  server.updated_at = now();
  const columns = await tableColumns(env, "v2_server");
  const allowed = Object.entries(server).filter(([key]) => columns.has(key));
  await env.XBOARD_DB.prepare(`INSERT INTO v2_server(${allowed.map(([key]) => key).join(",")}) VALUES (${allowed.map(() => "?").join(",")})`).bind(...allowed.map(([, value]) => value)).run();
  await bump(env.XBOARD_KV, "servers_version");
  return ok(true);
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function trafficConvert(value: unknown) {
  const bytes = Number(value || 0);
  if (bytes < 0) return 0;
  const units: [number, string][] = [[1073741824, "GB"], [1048576, "MB"], [1024, "KB"]];
  for (const [size, unit] of units) {
    if (bytes > size) return `${Math.round(bytes / size * 100) / 100} ${unit}`;
  }
  return `${Math.round(bytes * 100) / 100} B`;
}

function csvResponse(filename: string, rows: unknown[][]) {
  const content = `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  return new Response(content, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`
    }
  });
}

async function generateAdminUsers(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const suffix = String(input.email_suffix || "").trim().replace(/^@/, "");
  const prefix = String(input.email_prefix || "").trim();
  const count = Math.min(1000, Math.max(1, Number(input.generate_count || 1)));
  if (!suffix) return fail("邮箱后缀不能为空", 422, 422);
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const requestedPlanId = nullableNumber(input.plan_id);
  const trialPlanId = requestedPlanId ? null : nullableNumber(pickSetting(all, "try_out_plan_id", 0));
  const planId = requestedPlanId || trialPlanId;
  const plan = planId ? await env.XBOARD_DB.prepare("SELECT id, group_id, transfer_enable, speed_limit, device_limit FROM v2_plan WHERE id = ?").bind(planId).first<Record<string, any>>() : null;
  if (requestedPlanId && !plan) return fail("订阅计划不存在", 400, 400202);
  const emails = Array.from({ length: count }, (_, index) => {
    const local = prefix ? (count > 1 ? `${prefix}_${index + 1}` : prefix) : randomString(6).toLowerCase();
    return `${local}@${suffix}`;
  });
  if (new Set(emails).size !== emails.length) return fail("生成的邮箱存在重复", 400, 400201);
  for (let offset = 0; offset < emails.length; offset += 80) {
    const chunk = emails.slice(offset, offset + 80);
    const duplicate = await env.XBOARD_DB.prepare(`SELECT email FROM v2_user WHERE email IN (${chunk.map(() => "?").join(",")}) LIMIT 1`).bind(...chunk).first<{ email: string }>();
    if (duplicate) return fail(`邮箱 ${duplicate.email} 已存在于系统中`, 400, 400201);
  }
  const generated: Record<string, any>[] = [];
  const statements: D1PreparedStatement[] = [];
  const ts = now();
  const expiredAt = nullableNumber(input.expired_at) ?? (trialPlanId && plan ? ts + Number(pickSetting(all, "try_out_hour", 1)) * 3600 : null);
  for (const email of emails) {
    const password = String(input.password || email);
    const userUuid = uuid();
    const userToken = token(16);
    statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_user(email, password, password_algo, password_salt, uuid, token, plan_id, group_id, expired_at, transfer_enable, speed_limit, device_limit, remind_expire, remind_traffic, created_at, updated_at)
      VALUES (?, ?, 'bcrypt', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      email, await hashPassword(password), userUuid, userToken, plan ? planId : null, plan?.group_id ?? null,
      expiredAt, Number(plan?.transfer_enable || 0) * 1073741824, plan?.speed_limit ?? null, plan?.device_limit ?? null,
      boolNumber(pickSetting(all, "default_remind_expire", 1), 1), boolNumber(pickSetting(all, "default_remind_traffic", 1), 1), ts, ts
    ));
    generated.push({
      email, password,
      expired_at: expiredAt ? new Date((expiredAt + EDGE_SHANGHAI_OFFSET) * 1000).toISOString().replace("T", " ").slice(0, 19) : "长期有效",
      uuid: userUuid,
      created_at: new Date((ts + EDGE_SHANGHAI_OFFSET) * 1000).toISOString().replace("T", " ").slice(0, 19),
      subscribe_url: await subscribeUrl(request, env, userToken)
    });
  }
  try {
    const results = await env.XBOARD_DB.batch(statements);
    results.forEach((result, index) => { generated[index].id = Number((result.meta as any)?.last_row_id || 0); });
  } catch {
    return fail("生成失败", 500, 500);
  }
  if (input.download_csv) return csvResponse("users.csv", [["账号", "密码", "过期时间", "UUID", "创建时间", "订阅地址"], ...generated.map(user => [user.email, user.password, user.expired_at, user.uuid, user.created_at, user.subscribe_url])]);
  return json({ code: 0, message: count > 1 ? "批量生成成功" : "生成成功", data: count > 1 ? generated : true });
}

async function dumpAdminUsers(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const ids = parseJsonArray(input.user_ids || input.ids).map(Number).filter(Boolean);
  const scope = String(input.scope || (ids.length ? "selected" : "all"));
  if (scope === "selected" && !ids.length) return fail("user_ids不能为空", 422, 422);
  const filtered = scope === "filtered" ? adminUserQuery(input) : null;
  const where = scope === "selected" ? ` WHERE u.id IN (${ids.map(() => "?").join(",")})` : filtered?.where || "";
  const bindings = scope === "selected" ? ids : filtered?.bindings || [];
  const order = filtered?.order || "u.id ASC";
  const query = `SELECT u.*, p.name AS plan_name FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id LEFT JOIN v2_server_group g ON g.id = u.group_id LEFT JOIN v2_user iu ON iu.id = u.invite_user_id${where} ORDER BY ${order}`;
  const result = await env.XBOARD_DB.prepare(query).bind(...bindings).all<Record<string, any>>();
  const output: unknown[][] = [["邮箱", "余额", "推广佣金", "总流量", "剩余流量", "套餐到期时间", "订阅计划", "订阅地址"]];
  for (const user of result.results || []) output.push([
    user.email, (Number(user.balance || 0) / 100).toFixed(2), (Number(user.commission_balance || 0) / 100).toFixed(2),
    trafficConvert(user.transfer_enable), trafficConvert(Number(user.transfer_enable || 0) - Number(user.u || 0) - Number(user.d || 0)),
    user.expired_at || "长期有效", user.plan_name || "无订阅", await subscribeUrl(request, env, user.token)
  ]);
  return csvResponse(`users_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.csv`, output);
}

async function batchUpdateServers(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const ids = parseJsonArray(input.ids || input.server_ids).map(Number).filter(Boolean).slice(0, 500);
  if (!ids.length) return fail("ids不能为空", 422, 422);
  const source = input.data && typeof input.data === "object" ? input.data : input;
  const allowed = Object.entries(source).filter(([key]) => ["show", "enabled", "machine_id"].includes(key));
  if (!allowed.length) return fail("没有可更新字段", 422, 422);
  const set = allowed.map(([key]) => `${key} = ?`).join(", ");
  await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...allowed.map(([, value]) => bindValue(value)), now(), ...ids).run();
  await bump(env.XBOARD_KV, "servers_version");
  return ok(true);
}

async function audit(env: Env, adminId: number, request: Request, path: string) {
  if (request.method !== "POST") return;
  try {
    const route = path.replace(/^\/api\/v[12]\/[^/]+\//, "").replaceAll("-", "_");
    const segments = route.split("/").filter(Boolean);
    const operation = segments.pop() || "request";
    const action = `${segments.join("_")}.${operation}`;
    const input = await body<Record<string, any>>(request.clone());
    const sensitive = /(^|_)(password|token|secret|key|api_key)$/i;
    const requestData = Object.fromEntries(Object.entries(input).filter(([key]) => !sensitive.test(key)));
    const ts = now();
    await env.XBOARD_DB.prepare("INSERT INTO v2_admin_audit_log(admin_id, action, target, metadata, ip, method, uri, request_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(adminId, action, path, JSON.stringify(requestData), requestIp(request), request.method, new URL(request.url).pathname + new URL(request.url).search, JSON.stringify(requestData), ts, ts).run();
  } catch {
    // Audit logging must never break admin operations.
  }
}

const mailTemplateMeta: Record<string, { label: string; required_vars: string[]; optional_vars: string[] }> = {
  verify: { label: "邮箱验证码", required_vars: ["code"], optional_vars: ["name", "url"] },
  mailLogin: { label: "邮件快捷登录", required_vars: ["link"], optional_vars: ["name", "url"] },
  notify: { label: "站点通知", required_vars: ["content"], optional_vars: ["name", "url"] },
  remindExpire: { label: "服务到期提醒", required_vars: [], optional_vars: ["name", "url"] },
  remindTraffic: { label: "流量使用提醒", required_vars: [], optional_vars: ["name", "url"] }
};

const mailTemplateDefaults: Record<string, { subject: string; content: string }> = {
  verify: { subject: "{{name}} - 邮箱验证码", content: "您的验证码是：{{code}}。返回 {{url}}" },
  mailLogin: { subject: "登录到 {{name}}", content: "请使用以下链接登录：{{link}}\n\n{{url}}" },
  notify: { subject: "{{name}} - 站点通知", content: "{{content}}\n\n{{url}}" },
  remindExpire: { subject: "{{name}} - 服务即将到期", content: "您的服务即将到期，请及时续费。{{url}}" },
  remindTraffic: { subject: "{{name}} - 流量使用提醒", content: "您的流量使用量已接近上限。{{url}}" }
};

function canonicalMailTemplateName(name: string) {
  return name === "remind_expire" ? "remindExpire" : name === "remind_traffic" ? "remindTraffic" : name;
}

function legacyMailTemplateName(name: string) {
  return name === "remindExpire" ? "remind_expire" : name === "remindTraffic" ? "remind_traffic" : name;
}

async function adminMailTemplateList(env: Env) {
  const result = await env.XBOARD_DB.prepare("SELECT name, subject, updated_at FROM v2_mail_templates").all<Record<string, any>>();
  const templates = new Map((result.results || []).map(row => [canonicalMailTemplateName(String(row.name)), row]));
  return Object.entries(mailTemplateMeta).map(([name, meta]) => ({
    name,
    label: meta.label,
    customized: templates.has(name),
    subject: templates.get(name)?.subject || null,
    updated_at: templates.get(name)?.updated_at || null
  }));
}

async function adminMailTemplateGet(env: Env, name: string) {
  name = canonicalMailTemplateName(name);
  const meta = mailTemplateMeta[name];
  if (!meta) return null;
  const row = await env.XBOARD_DB.prepare("SELECT name, subject, content FROM v2_mail_templates WHERE name IN (?, ?) ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END LIMIT 1")
    .bind(name, legacyMailTemplateName(name), name).first<Record<string, any>>();
  return {
    name,
    label: meta.label,
    required_vars: meta.required_vars,
    optional_vars: meta.optional_vars,
    customized: Boolean(row),
    subject: row?.subject || mailTemplateDefaults[name].subject,
    content: row?.content || mailTemplateDefaults[name].content
  };
}

function renderMailText(source: string, vars: Record<string, unknown>) {
  return source.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => String(vars[key] ?? ""));
}

function mailHtml(content: string) {
  if (/<[a-z][\s\S]*>/i.test(content)) return content;
  return `<div style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.6">${content
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}</div>`;
}

async function queueMail(env: Env, payload: { to: string; subject: string; content: string; template_name?: string }) {
  if (!payload.to || !payload.subject) throw new Error("邮件收件人或主题为空");
  const eventId = `mail:${crypto.randomUUID()}`;
  await env.NOTIFICATION_EVENTS.send({
    event_id: eventId,
    type: "mail",
    payload: {
      to: payload.to,
      subject: payload.subject,
      html: mailHtml(payload.content),
      text: payload.content,
      template_name: payload.template_name || "notify"
    }
  });
  return eventId;
}

async function queueTemplateMail(env: Env, name: string, email: string, vars: Record<string, unknown>, subjectOverride?: string) {
  const template = await adminMailTemplateGet(env, name);
  if (!template) throw new Error("模板不存在");
  const eventId = `mail:${crypto.randomUUID()}`;
  await env.NOTIFICATION_EVENTS.send({
    event_id: eventId,
    type: "mail",
    payload: { to: email, subject: subjectOverride || template.subject, template_name: canonicalMailTemplateName(name), vars, content_mode: "text" }
  });
  return eventId;
}

async function queueTelegram(env: Env, text: string, chatId?: string | number) {
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  if (!Number(pickSetting(all, "telegram_bot_enable", 0)) || !String(pickSetting(all, "telegram_bot_token", ""))) return null;
  const eventId = `telegram:${crypto.randomUUID()}`;
  await env.NOTIFICATION_EVENTS.send({ event_id: eventId, type: "telegram", payload: { text, ...(chatId ? { chat_id: chatId } : {}) } });
  return eventId;
}

async function queueTelegramToAdmins(env: Env, text: string) {
  const recipients = await env.XBOARD_DB.prepare(`SELECT telegram_id FROM v2_user
    WHERE telegram_id IS NOT NULL AND (is_admin = 1 OR is_staff = 1)`).all<{ telegram_id: string | number }>();
  await Promise.all((recipients.results || []).map(recipient => queueTelegram(env, text, recipient.telegram_id)));
}

function ticketLocation(request: Request) {
  const location = [request.headers.get("cf-ipcountry"), request.headers.get("cf-region"), request.headers.get("cf-ipcity")].filter(Boolean).join(" / ");
  return location || requestIp(request) || "NULL";
}

async function ticketTelegramText(env: Env, request: Request, user: Record<string, any>, ticketId: number, subject: string, message: string) {
  const plan = user.plan_id ? await env.XBOARD_DB.prepare("SELECT name FROM v2_plan WHERE id = ?").bind(user.plan_id).first<{ name: string }>() : null;
  const total = Number(user.transfer_enable || 0); const upload = Number(user.u || 0); const download = Number(user.d || 0);
  const expires = user.expired_at ? new Date(Number(user.expired_at) * 1000).toISOString().replace("T", " ").slice(0, 19) : "长期有效";
  const lines = [
    `工单提醒 #${ticketId}`,
    "━━━━━━━━━━━━━━━━━━━━",
    `邮箱: ${String(user.email || "")}`,
    `位置: ${ticketLocation(request)}`,
    plan ? `套餐: ${plan.name}` : "套餐: 未订购任何套餐"
  ];
  if (plan) lines.push(
    `流量: ${telegramGb(total - upload - download)}G / ${telegramGb(total)}G (剩余/总计)`,
    `已用: ${telegramGb(upload)}G / ${telegramGb(download)}G (上传/下载)`,
    `到期: ${expires}`
  );
  lines.push(
    `余额: ${(Number(user.balance || 0) / 100).toFixed(2)}元`,
    `佣金: ${(Number(user.commission_balance || 0) / 100).toFixed(2)}元`,
    "━━━━━━━━━━━━━━━━━━━━",
    `主题: ${subject}`,
    `内容: ${message}`
  );
  return lines.join("\n");
}

type EmailProvider = "maileroo" | "brevo";

function normalizeEmailProvider(value: unknown): EmailProvider {
  return String(value || "").toLowerCase() === "brevo" ? "brevo" : "maileroo";
}

async function sendProviderEmail(provider: EmailProvider, apiKey: string, fromAddress: string, fromName: string, recipients: string[], subject: string, html: string, text: string) {
  if (!apiKey) throw new Error(`${provider === "brevo" ? "Brevo" : "Maileroo"} API Key 未配置`);
  if (!fromAddress) throw new Error(`${provider === "brevo" ? "Brevo" : "Maileroo"} 发件人地址未配置`);
  const endpoint = provider === "brevo"
    ? "https://api.brevo.com/v3/smtp/email"
    : "https://smtp.maileroo.com/api/v2/emails";
  const response = await fetch(endpoint, provider === "brevo" ? {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: fromAddress, name: fromName || undefined },
      to: recipients.map(address => ({ email: address })),
      subject,
      htmlContent: html,
      textContent: text
    })
  } : {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      from: { address: fromAddress, display_name: fromName || undefined },
      to: recipients.map(address => ({ address })),
      subject,
      html,
      plain: text
    })
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`${provider === "brevo" ? "Brevo" : "Maileroo"} ${response.status}: ${responseText.slice(0, 500)}`);
  return responseText;
}

async function sendTestMail(env: Env, email: string) {
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const template = await adminMailTemplateGet(env, "notify");
  const provider = normalizeEmailProvider(all.email_driver);
  const apiKey = String(firstNonEmpty(all.email_password));
  const fromAddress = String(firstNonEmpty(all.email_from_address, all.resend_from_address));
  const fromName = String(firstNonEmpty(all.email_username, all.resend_from_name, all.app_name, "XBoard"));
  const subject = "This is xboard test email";
  const vars = { name: pickSetting(all, "app_name", "XBoard"), content: subject, url: pickSetting(all, "app_url", "") };
  const content = renderMailText(template?.content || mailTemplateDefaults.notify.content, vars);
  const config = {
    driver: provider,
    host: provider === "brevo" ? "https://api.brevo.com/v3/smtp/email" : "https://smtp.maileroo.com/api/v2/emails",
    port: 443,
    encryption: "HTTPS",
    from: { address: fromAddress, name: fromName },
    username: fromName
  };
  let error: string | null = null;
  try {
    await sendProviderEmail(provider, apiKey, fromAddress, fromName, [email], subject, mailHtml(content), content);
  } catch (caught: any) {
    error = String(caught?.message || caught);
  }
  const ts = now();
  await env.XBOARD_DB.prepare("INSERT INTO v2_mail_log(email, subject, template_name, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(email, subject, "notify", error, ts, ts).run();
  return { email, subject, template_name: "notify", error, config };
}

async function telegramRequest(botToken: string, method: string, payload: Record<string, unknown> = {}) {
  if (!botToken) throw new Error("Telegram Bot Token 未配置");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const result = await response.json() as Record<string, any>;
  if (!response.ok || !result.ok) throw new Error(String(result.description || `Telegram ${method} failed`));
  return result.result;
}

async function adminAuditLogs(env: Env, request: Request) {
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  const url = new URL(request.url);
  url.searchParams.forEach((value, key) => { if (input[key] === undefined) input[key] = value; });
  const page = Math.max(1, Number(input.current || input.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.page_size || input.per_page || url.searchParams.get("page_size") || 20)));
  const offset = (page - 1) * pageSize;
  const clauses: string[] = []; const binds: unknown[] = [];
  if (input.action) { clauses.push("l.action = ?"); binds.push(String(input.action)); }
  if (nullableNumber(input.admin_id)) { clauses.push("l.admin_id = ?"); binds.push(Number(input.admin_id)); }
  if (String(input.keyword || "").trim()) {
    clauses.push("(l.uri LIKE ? OR l.request_data LIKE ?)");
    const keyword = `%${String(input.keyword).trim()}%`; binds.push(keyword, keyword);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const [result, totalRow] = await Promise.all([
    env.XBOARD_DB.prepare(`SELECT l.*, u.id AS admin_user_id, u.email AS admin_email FROM v2_admin_audit_log l LEFT JOIN v2_user u ON u.id = l.admin_id${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all<Record<string, any>>(),
    env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_admin_audit_log l${where}`).bind(...binds).first<{ count: number }>()
  ]);
  return { data: (result.results || []).map(row => ({ ...row, admin: row.admin_user_id ? { id: Number(row.admin_user_id), email: row.admin_email || "" } : null })), total: Number(totalRow?.count || 0) };
}

function trafficText(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes || 0)); let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${Math.round(value * 100) / 100} ${units[unit]}`;
}

function dateBoundary(value: unknown, end = false) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isFinite(Number(value)) && String(value).trim() !== "") return Number(value);
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const timestamp = Math.floor(Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`) / 1000);
  return timestamp + (end ? 86399 : 0);
}

function trafficResetResource(row: Record<string, any>, request: Request) {
  const language = requestLanguage(request);
  const resetNames = {
    en: { monthly: "Monthly Reset", first_day_month: "First Day of Month Reset", yearly: "Yearly Reset", first_day_year: "First Day of Year Reset", manual: "Manual Reset", purchase: "Purchase Reset Package" },
    zh: { monthly: "按月重置", first_day_month: "每月1号重置", yearly: "按年重置", first_day_year: "每年1月1日重置", manual: "手动重置", purchase: "购买重置包" },
    ru: { monthly: "Ежемесячный сброс", first_day_month: "Сброс в первый день месяца", yearly: "Ежегодный сброс", first_day_year: "Сброс в первый день года", manual: "Ручной сброс", purchase: "Приобретение пакета сброса" }
  }[language] as Record<string, string>;
  const sourceNames = {
    en: { auto: "Auto Trigger", manual: "Manual Trigger", api: "API Call", cron: "Cron Job", user_access: "User Access", order: "Order", gift_card: "Gift Card" },
    zh: { auto: "自动触发", manual: "手动触发", api: "API调用", cron: "定时任务", user_access: "用户访问", order: "订单", gift_card: "礼品卡" },
    ru: { auto: "Автоматический запуск", manual: "Ручной запуск", api: "Вызов API", cron: "Cron-задача", user_access: "Доступ пользователя", order: "Заказ", gift_card: "Подарочная карта" }
  }[language] as Record<string, string>;
  const metadata = parseJsonObject(row.metadata);
  const triggerSource = String(row.trigger_source || metadata.trigger_source || "manual");
  const oldTotal = Number(row.old_total ?? (Number(row.old_u || 0) + Number(row.old_d || 0)));
  const newTotal = Number(row.new_total || 0);
  return {
    ...row,
    old_traffic: { upload: Number(row.old_upload ?? row.old_u ?? 0), download: Number(row.old_download ?? row.old_d ?? 0), total: oldTotal, formatted: trafficText(oldTotal) },
    new_traffic: { upload: Number(row.new_upload || 0), download: Number(row.new_download || 0), total: newTotal, formatted: trafficText(newTotal) },
    trigger_source: triggerSource,
    reset_type_name: resetNames[String(row.reset_type)] || String(row.reset_type || ""),
    trigger_source_name: sourceNames[triggerSource] || triggerSource,
    metadata
  };
}

async function trafficResetLogs(env: Env, request: Request) {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.min(10000, Math.max(1, Number(url.searchParams.get("per_page") || 20)));
  const offset = (page - 1) * pageSize;
  const clauses: string[] = []; const binds: unknown[] = [];
  const userId = nullableNumber(url.searchParams.get("user_id"));
  const email = String(url.searchParams.get("user_email") || "").trim();
  const resetType = String(url.searchParams.get("reset_type") || "").trim();
  const source = String(url.searchParams.get("trigger_source") || "").trim();
  const start = dateBoundary(url.searchParams.get("start_date")); const end = dateBoundary(url.searchParams.get("end_date"), true);
  const validResetTypes = ["monthly", "first_day_month", "yearly", "first_day_year", "manual", "purchase"];
  const validSources = ["auto", "manual", "api", "cron", "user_access", "order", "gift_card"];
  if (url.searchParams.has("user_id") && !userId) return fail("user_id 格式不正确", 422, 422);
  if (resetType && !validResetTypes.includes(resetType)) return fail("reset_type 的值不合法", 422, 422);
  if (source && !validSources.includes(source)) return fail("trigger_source 的值不合法", 422, 422);
  if (url.searchParams.get("start_date") && start === null) return fail("start_date 格式不正确", 422, 422);
  if (url.searchParams.get("end_date") && end === null) return fail("end_date 格式不正确", 422, 422);
  if (start !== null && end !== null && end < start) return fail("end_date 必须晚于或等于 start_date", 422, 422);
  if (userId) { clauses.push("l.user_id = ?"); binds.push(userId); }
  if (email) { clauses.push("u.email LIKE ?"); binds.push(`%${email}%`); }
  if (resetType) { clauses.push("l.reset_type = ?"); binds.push(resetType); }
  if (source) { clauses.push("l.trigger_source = ?"); binds.push(source); }
  if (start !== null) { clauses.push("l.reset_time >= ?"); binds.push(start); }
  if (end !== null) { clauses.push("l.reset_time <= ?"); binds.push(end); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.XBOARD_DB.prepare(`SELECT l.*, u.email AS user_email FROM v2_traffic_reset_logs l LEFT JOIN v2_user u ON u.id = l.user_id${where} ORDER BY l.reset_time DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all<Record<string, any>>();
  const data = (result.results || []).map(row => trafficResetResource(row, request));
  const totalRow = await env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_traffic_reset_logs l LEFT JOIN v2_user u ON u.id = l.user_id${where}`).bind(...binds).first<{ count: number }>();
  const total = Number(totalRow?.count || 0);
  return { data, pagination: { current_page: page, last_page: Math.max(1, Math.ceil(total / pageSize)), per_page: pageSize, total } };
}

async function resetUserTraffic(env: Env, request: Request, adminId: number) {
  const input = await body<Record<string, any>>(request);
  const userId = nullableNumber(input.user_id);
  if (!userId) return fail("user_id 字段是必须的", 422, 422);
  const user = await env.XBOARD_DB.prepare(`SELECT u.id, u.email, u.u, u.d, u.reset_count, u.next_reset_at, u.expired_at, u.banned,
      u.plan_id, p.reset_traffic_method AS plan_reset_traffic_method
    FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id WHERE u.id = ?`).bind(userId).first<Record<string, any>>();
  if (!user) return fail("用户不存在", 404, 404);
  if (Number(user.banned || 0) || user.plan_id === null || user.plan_id === undefined || (user.expired_at !== null && Number(user.expired_at) <= now())) {
    return fail("用户当前不可重置流量", 400, 400);
  }
  const ts = now();
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const method = user.plan_reset_traffic_method === null || user.plan_reset_traffic_method === undefined
    ? Number(pickSetting(all, "reset_traffic_method", 0))
    : Number(user.plan_reset_traffic_method);
  const resetTypes: Record<number, string> = { 0: "first_day_month", 1: "monthly", 3: "first_day_year", 4: "yearly" };
  const resetType = resetTypes[method] || "manual";
  const nextResetAt = edgeNextResetAt(nullableNumber(user.expired_at), method, ts);
  const metadata = JSON.stringify({ reason: input.reason || "", admin_id: adminId, trigger_source: "manual" });
  await env.XBOARD_DB.batch([
    env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_reset_logs(user_id, reset_type, old_u, old_d, old_upload, old_download, old_total,
      new_upload, new_download, new_total, trigger_source, metadata, reset_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'manual', ?, ?, ?)`).bind(
        userId, resetType, Number(user.u || 0), Number(user.d || 0), Number(user.u || 0), Number(user.d || 0),
        Number(user.u || 0) + Number(user.d || 0), metadata, ts, ts),
    env.XBOARD_DB.prepare("UPDATE v2_user SET u = 0, d = 0, reset_count = COALESCE(reset_count, 0) + 1, last_reset_at = ?, next_reset_at = ?, updated_at = ? WHERE id = ?").bind(ts, nextResetAt, ts, userId)
  ]);
  await bump(env.XBOARD_KV, `user_version:${userId}`);
  return json({ message: "重置成功", data: { user_id: userId, email: user.email, reset_time: ts, next_reset_at: nextResetAt } });
}

async function login(request: Request, env: Env, admin = false) {
  const input = await body<any>(request);
  const email = String(input.email || input.username || "").trim().toLowerCase();
  const password = String(input.password || "");
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV); const limitEnabled = !!pickSetting(all, "password_limit_enable", 1);
  const limit = Math.max(1, Number(pickSetting(all, "password_limit_count", 5))); const windowSeconds = Math.max(0, Number(pickSetting(all, "password_limit_expire", 60)) * 60);
  const rateKey = `rate:login:${email}`; const attempts = Number(await optionalKvGet(env, rateKey) || 0);
  if (limitEnabled && windowSeconds > 0 && attempts >= limit) return fail("登录尝试次数过多，请稍后再试", 429, 429);
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE email = ?").bind(email).first<any>();
  if (!user || (admin && Number(user.is_admin) !== 1) || !(await verifyPassword(password, String(user?.password || ""), user?.password_algo, user?.password_salt))) {
    if (user && limitEnabled && windowSeconds > 0) await optionalKvPutTtl(env, rateKey, String(attempts + 1), windowSeconds);
    return fail("账号或密码错误", 401, 401);
  }
  if (Number(user.banned || 0) === 1) return fail("账号已被封禁", 400, 400);
  try { await env.XBOARD_KV.delete(rateKey); } catch {}
  const accessToken = await createSession(env.XBOARD_DB, env.XBOARD_KV, user, admin);
  await env.XBOARD_DB.prepare("UPDATE v2_user SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?").bind(now(), requestIp(request), now(), user.id).run();
  return ok({ token: user.token, is_admin: !!user.is_admin, email: user.email, auth_data: `Bearer ${accessToken}` });
}

function constantTimeEqual(left: unknown, right: unknown) {
  const a = new TextEncoder().encode(String(left ?? ""));
  const b = new TextEncoder().encode(String(right ?? ""));
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) different |= (a[index] || 0) ^ (b[index] || 0);
  return different === 0;
}

function requestIp(request: Request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

async function verifyCaptcha(request: Request, input: Record<string, any>, all: Record<string, any>) {
  if (!Number(pickSetting(all, "captcha_enable", 0))) return true;
  const type = String(pickSetting(all, "captcha_type", "recaptcha"));
  let endpoint = "https://www.google.com/recaptcha/api/siteverify";
  let secret = String(pickSetting(all, type === "recaptcha-v3" ? "recaptcha_v3_secret_key" : "recaptcha_key", ""));
  let response = String(input[type === "recaptcha-v3" ? "recaptcha_v3_token" : "recaptcha_data"] || "");
  if (type === "turnstile") {
    endpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    secret = String(pickSetting(all, "turnstile_secret_key", ""));
    response = String(input.turnstile_token || "");
  }
  if (!secret || !response) return false;
  const payload = new URLSearchParams({ secret, response, remoteip: requestIp(request) });
  try {
    const result = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: payload }).then(item => item.json()) as Record<string, any>;
    if (!result.success) return false;
    return type !== "recaptcha-v3" || Number(result.score || 0) >= Number(pickSetting(all, "recaptcha_v3_score_threshold", 0.5));
  } catch {
    return false;
  }
}

async function registerUser(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const email = String(input.email || "").trim().toLowerCase();
  const passwordText = String(input.password || "");
  if (!email) return fail("Email can not be empty", 422, 422);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Email format is incorrect", 422, 422);
  if (!passwordText) return fail("Password can not be empty", 422, 422);
  if (passwordText.length < 8) return fail("Password must be greater than 8 digits", 422, 422);
  const rateKey = `rate:register:${requestIp(request)}`;
  if (Number(pickSetting(all, "register_limit_by_ip_enable", 0))) {
    const count = Number(await optionalKvGet(env, rateKey) || 0);
    if (count >= Number(pickSetting(all, "register_limit_count", 3))) {
      return fail(`Register frequently, please try again after ${Number(pickSetting(all, "register_limit_expire", 60))} minute`, 429, 429);
    }
  }
  if (!(await verifyCaptcha(request, input, all))) return fail("Invalid code is incorrect", 400, 400);
  if (Number(pickSetting(all, "email_whitelist_enable", 0))) {
    const rawSuffixes = pickSetting(all, "email_whitelist_suffix", []);
    const suffixes = Array.isArray(rawSuffixes) ? rawSuffixes : String(rawSuffixes).split(",").map(value => value.trim());
    if (!suffixes.includes(email.split("@").pop())) return fail("Email suffix is not in the Whitelist", 400, 400);
  }
  if (Number(pickSetting(all, "email_gmail_limit_enable", 0))) {
    const prefix = email.split("@")[0];
    if (prefix.includes(".") || prefix.includes("+")) return fail("Gmail alias is not supported", 400, 400);
  }
  if (Number(pickSetting(all, "stop_register", 0))) return fail("Registration has closed", 400, 400);
  const inviteCode = String(input.invite_code || "").trim();
  if (Number(pickSetting(all, "invite_force", 0)) && !inviteCode) return fail("You must use the invitation code to register", 422, 422);
  if (Number(pickSetting(all, "email_verify", 0))) {
    const code = String(input.email_code || "");
    if (!/^\d{6}$/.test(code)) return fail("Email verification code cannot be empty", 422, 422);
    if (!constantTimeEqual(await optionalKvGet(env, `verify:email:${email}`), code)) return fail("Incorrect email verification code", 400, 400);
  }
  if (await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE email = ?").bind(email).first()) return fail("Email already exists", 400, 400201);
  let inviteUserId: number | null = null;
  if (inviteCode) {
    if (Number(pickSetting(all, "invite_never_expire", 0))) {
      const invite = await env.XBOARD_DB.prepare("SELECT user_id FROM v2_invite_code WHERE code = ? AND status = 0").bind(inviteCode).first<{ user_id: number }>();
      inviteUserId = invite?.user_id ?? null;
    } else {
      const invite = await env.XBOARD_DB.prepare("UPDATE v2_invite_code SET status = 1, updated_at = ? WHERE code = ? AND status = 0 RETURNING user_id").bind(now(), inviteCode).first<{ user_id: number }>();
      inviteUserId = invite?.user_id ?? null;
    }
    if (!inviteUserId && Number(pickSetting(all, "invite_force", 0))) return fail("Invalid invitation code", 400, 400);
  }
  const planId = nullableNumber(pickSetting(all, "try_out_plan_id", null));
  const plan = planId ? await env.XBOARD_DB.prepare("SELECT id,group_id,transfer_enable,speed_limit,device_limit FROM v2_plan WHERE id = ?").bind(planId).first<Record<string, any>>() : null;
  const ts = now();
  const expiredAt = plan ? ts + Math.max(0, Number(pickSetting(all, "try_out_hour", 1))) * 3600 : null;
  await env.XBOARD_DB.prepare("INSERT INTO v2_user(email,password,password_algo,password_salt,uuid,token,invite_user_id,plan_id,group_id,transfer_enable,speed_limit,device_limit,expired_at,remind_expire,remind_traffic,last_login_at,created_at,updated_at) VALUES (?,?,'bcrypt',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(email, await hashPassword(passwordText), uuid(), token(16), inviteUserId, plan?.id ?? null, plan?.group_id ?? null, Number(plan?.transfer_enable || 0) * 1073741824, plan?.speed_limit ?? null, null, expiredAt, boolNumber(pickSetting(all, "default_remind_expire", 1), 1), boolNumber(pickSetting(all, "default_remind_traffic", 1), 1), ts, ts, ts).run();
  if (Number(pickSetting(all, "email_verify", 0))) {
    try { await env.XBOARD_KV.delete(`verify:email:${email}`); } catch {}
  }
  if (Number(pickSetting(all, "register_limit_by_ip_enable", 0))) {
    const count = Number(await optionalKvGet(env, rateKey) || 0);
    await optionalKvPutTtl(env, rateKey, String(count + 1), Math.max(60, Number(pickSetting(all, "register_limit_expire", 60)) * 60));
  }
  const loginHeaders = new Headers({ "content-type": "application/json" });
  for (const name of ["cf-connecting-ip", "x-forwarded-for", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) loginHeaders.set(name, value);
  }
  return login(new Request(request.url, { method: "POST", body: JSON.stringify({ email, password: passwordText }), headers: loginHeaders }), env, false);
}

async function tableColumns(env: Env, table: string) {
  const result = await env.XBOARD_DB.prepare(`PRAGMA table_info(${table.replace(/[^a-zA-Z0-9_]/g, "")})`).all<{ name: string }>();
  return new Set((result.results || []).map(row => row.name));
}

async function createOrUpdate(table: string, request: Request, env: Env, id?: string) {
  const input = await body<Record<string, any>>(request);
  const ts = now();
  if (table === "v2_user" && input.password) input.password = await hashPassword(String(input.password));
  if (!id && table === "v2_user") {
    input.uuid ||= uuid();
    input.token ||= token(16);
    input.transfer_enable ||= 0;
  }
  if (table === "v2_plan" && input.transfer_enable_gb && !input.transfer_enable) {
    input.transfer_enable = Math.round(Number(input.transfer_enable_gb) * 1073741824);
  }
  const columns = await tableColumns(env, table);
  const allowed = Object.entries(input).filter(([k]) => /^[a-zA-Z0-9_]+$/.test(k) && columns.has(k) && !["id", "created_at", "updated_at"].includes(k));
  if (id) {
    const set = allowed.map(([k]) => `${k} = ?`).join(", ");
    if (set) await env.XBOARD_DB.prepare(`UPDATE ${table} SET ${set}, updated_at = ? WHERE id = ?`).bind(...allowed.map(([, v]) => bindValue(v)), ts, id).run();
  } else {
    const cols = [...allowed.map(([k]) => k), "created_at", "updated_at"];
    const marks = cols.map(() => "?").join(", ");
    await env.XBOARD_DB.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${marks})`).bind(...allowed.map(([, v]) => bindValue(v)), ts, ts).run();
  }
  if (table === "v2_settings") {
    invalidateSettingsCache();
    await invalidateServerSettings(env);
    await bump(env.XBOARD_KV, "settings_version");
  }
  if (table === "v2_server" || table === "v2_plan") await bump(env.XBOARD_KV, "servers_version");
  if (table === "v2_user" && id) {
    await bump(env.XBOARD_KV, `user_version:${id}`);
    const user = await env.XBOARD_DB.prepare("SELECT token FROM v2_user WHERE id = ?").bind(id).first<{ token: string }>();
    if (user?.token) await bump(env.XBOARD_KV, `user_version:${user.token}`);
  }
  return ok(true);
}

async function adminTicket(request: Request, env: Env, route: string, adminId: number): Promise<Response | null> {
  if (!route.startsWith("/ticket/")) return null;
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  const url = new URL(request.url);
  const id = nullableNumber(input.id || url.searchParams.get("id"));
  if (route === "/ticket/fetch") {
    if (id) {
      const ticket = await env.XBOARD_DB.prepare("SELECT t.* FROM v2_ticket t WHERE t.id = ?").bind(id).first<Record<string, any>>();
      if (!ticket) return fail("工单不存在", 400, 400202);
      const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(ticket.user_id).first<Record<string, any>>();
      const messages = await env.XBOARD_DB.prepare("SELECT m.*, u.email FROM v2_ticket_message m LEFT JOIN v2_user u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id ASC").bind(id).all();
      const transformedUser = user ? { ...safeUser(user), balance: Number(user.balance || 0) / 100, commission_balance: Number(user.commission_balance || 0) / 100, subscribe_url: await subscribeUrl(request, env, String(user.token || "")) } : null;
      return ok({ ...ticket, user: transformedUser, messages: messages.results || [] });
    }
    const current = Math.max(1, Number(input.current || url.searchParams.get("current") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || url.searchParams.get("pageSize") || 10)));
    const status = input.status ?? url.searchParams.get("status");
    const email = String(input.email ?? url.searchParams.get("email") ?? "").trim();
    const clauses: string[] = []; const binds: any[] = [];
    if (status !== null && status !== undefined && status !== "") { clauses.push("t.status = ?"); binds.push(Number(status)); }
    if (email) { clauses.push("u.email = ?"); binds.push(email); }
    const replyStatuses = parseJsonArray(input.reply_status).map(Number).filter(Number.isFinite);
    if (replyStatuses.length) { clauses.push(`t.reply_status IN (${replyStatuses.map(() => "?").join(",")})`); binds.push(...replyStatuses); }
    const ticketFields: Record<string, string> = { id: "t.id", subject: "t.subject", level: "t.level", status: "t.status", reply_status: "t.reply_status", created_at: "t.created_at", updated_at: "t.updated_at", email: "u.email" };
    for (const filter of parseJsonArray(input.filter)) {
      const field = ticketFields[String(filter?.id || "")]; const value = filter?.value;
      if (!field || value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && value.length) { clauses.push(`${field} IN (${value.map(() => "?").join(",")})`); binds.push(...value); }
      else { clauses.push(`${field} LIKE ?`); binds.push(`%${String(value)}%`); }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sort = parseJsonArray(input.sort).map(item => ({ field: ticketFields[String(item?.id || "")], direction: item?.desc ? "DESC" : "ASC" })).filter(item => item.field);
    const order = [...sort.map(item => `${item.field} ${item.direction}`), "t.updated_at DESC"].join(", ");
    const result = await env.XBOARD_DB.prepare(`SELECT t.* FROM v2_ticket t JOIN v2_user u ON u.id = t.user_id${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, pageSize, (current - 1) * pageSize).all<Record<string, any>>();
    const count = await env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_ticket t JOIN v2_user u ON u.id = t.user_id${where}`).bind(...binds).first<{ count: number }>();
    const tickets = result.results || [];
    const userIds = [...new Set(tickets.map(ticket => Number(ticket.user_id)).filter(Boolean))];
    const users = userIds.length ? await env.XBOARD_DB.prepare(`SELECT * FROM v2_user WHERE id IN (${userIds.map(() => "?").join(",")})`).bind(...userIds).all<Record<string, any>>() : { results: [] as Record<string, any>[] };
    const userEntries = await Promise.all((users.results || []).map(async user => [Number(user.id), { ...safeUser(user), balance: Number(user.balance || 0) / 100, commission_balance: Number(user.commission_balance || 0) / 100, subscribe_url: await subscribeUrl(request, env, String(user.token || "")) }] as const));
    const userMap = new Map(userEntries);
    return json({ data: tickets.map(ticket => ({ ...ticket, user: userMap.get(Number(ticket.user_id)) || null })), total: Number(count?.count || 0) });
  }
  if (!id) return fail("工单ID不能为空", 422, 422);
  const ticket = await env.XBOARD_DB.prepare("SELECT id, user_id, subject, status FROM v2_ticket WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!ticket) return fail("工单不存在", 400, 400202);
  if (route === "/ticket/reply") {
    if (!String(input.message || "").trim()) return fail("消息不能为空", 422, 422);
    const ts = now();
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, is_admin, message, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)").bind(id, adminId, String(input.message), ts, ts),
      env.XBOARD_DB.prepare("UPDATE v2_ticket SET reply_status = 1, last_reply_user_id = ?, updated_at = ? WHERE id = ?").bind(adminId, ts, id)
    ]);
    const notifyKey = `ticket_sendEmailNotify_${ticket.user_id}`;
    if (!await env.XBOARD_KV.get(notifyKey)) {
      const recipient = await env.XBOARD_DB.prepare("SELECT email FROM v2_user WHERE id = ?").bind(ticket.user_id).first<{ email: string }>();
      if (recipient?.email) {
        try {
          const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
          await queueTemplateMail(env, "notify", recipient.email, {
            name: pickSetting(all, "app_name", "XBoard"),
            url: pickSetting(all, "app_url", ""),
            content: `主题：${ticket.subject}\r\n回复内容：${String(input.message)}`
          }, `您在${pickSetting(all, "app_name", "XBoard")}的工单得到了回复`);
          await env.XBOARD_KV.put(notifyKey, "1", { expirationTtl: 1800 });
        } catch {
          // A mail provider or queue outage must not turn a persisted reply into an API failure.
        }
      }
    }
    return ok(true);
  }
  if (route === "/ticket/close") {
    const result = await env.XBOARD_DB.prepare("UPDATE v2_ticket SET status = 1, updated_at = ? WHERE id = ?").bind(now(), id).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok(true) : fail("工单不存在", 400, 400202);
  }
  return null;
}

function couponValue(input: Record<string, any>, key: string) {
  return ["limit_plan_ids", "limit_period"].includes(key) ? JSON.stringify(parseJsonArray(input[key])) : input[key];
}

function canonicalCouponPeriods(value: unknown) {
  return parseJsonArray(value).map(item => {
    const period = String(item || "");
    return orderPeriods[period] || period;
  });
}

function couponResource(row: Record<string, any>) {
  const planIds = parseJsonArray(row.limit_plan_ids).map(String);
  const periods = canonicalCouponPeriods(row.limit_period).map(legacyOrderPeriod);
  return {
    ...row,
    limit_plan_ids: planIds.length ? planIds : null,
    limit_period: periods.length ? periods : null
  };
}

async function adminCoupon(request: Request, env: Env, route: string): Promise<Response | null> {
  if (!route.startsWith("/coupon/")) return null;
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  if (route === "/coupon/fetch") {
    const url = new URL(request.url); const current = Math.max(1, Number(input.current || url.searchParams.get("current") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || url.searchParams.get("pageSize") || 10)));
    const couponFields = new Set(["id", "code", "name", "type", "value", "show", "limit_use", "limit_use_with_user", "started_at", "ended_at", "created_at", "updated_at"]);
    const clauses: string[] = []; const binds: any[] = [];
    for (const filter of parseJsonArray(input.filter)) {
      const field = String(filter?.id || ""); const value = filter?.value;
      if (!couponFields.has(field) || value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && value.length) { clauses.push(`${field} IN (${value.map(() => "?").join(",")})`); binds.push(...value); }
      else { clauses.push(`${field} LIKE ?`); binds.push(`%${String(value)}%`); }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sort = parseJsonArray(input.sort).map(item => ({ field: String(item?.id || ""), direction: item?.desc ? "DESC" : "ASC" })).filter(item => couponFields.has(item.field));
    const order = [...sort.map(item => `${item.field} ${item.direction}`), "created_at DESC"].join(", ");
    const result = await env.XBOARD_DB.prepare(`SELECT * FROM v2_coupon${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, pageSize, (current - 1) * pageSize).all<Record<string, any>>();
    const totalRow = await env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_coupon${where}`).bind(...binds).first<{ count: number }>();
    const total = Number(totalRow?.count || 0);
    return json(paginated((result.results || []).map(row => ({
        ...row,
        type: Math.trunc(Number.parseFloat(String(row.type ?? 0))),
        value: Number(row.value ?? 0),
        show: !!row.show,
        limit_plan_ids: parseJsonArray(row.limit_plan_ids),
        limit_period: canonicalCouponPeriods(row.limit_period)
      })), total, current, pageSize));
  }
  const id = nullableNumber(input.id);
  if (route === "/coupon/generate") {
    const required = ["name", "type", "value", "started_at", "ended_at"];
    if (required.some(key => input[key] === undefined || input[key] === "")) return fail("优惠券参数不完整", 422, 422);
    const couponType = Math.trunc(Number.parseFloat(String(input.type ?? "")));
    if (![1, 2].includes(couponType)) return fail("类型格式有误", 422, 422);
    const existing = id ? await env.XBOARD_DB.prepare("SELECT id, code, show FROM v2_coupon WHERE id = ?").bind(id).first<Record<string, any>>() : null;
    if (id && !existing) return fail("优惠券不存在", 500, 500);
    const count = id ? 1 : Math.min(500, Math.max(1, Number(input.generate_count || 1))); const ts = now();
    const generatedCoupons: Array<Record<string, any>> = [];
    const statements = Array.from({ length: count }, (_, index) => {
      const code = count === 1 && input.code ? String(input.code) : id ? String(existing?.code || "") : randomString(8);
      const values = [code, String(input.name), couponType, Number(input.value), boolNumber(input.show, id ? Number(existing?.show || 0) : 0), nullableNumber(input.limit_use), nullableNumber(input.limit_use_with_user), couponValue(input, "limit_plan_ids"), couponValue(input, "limit_period"), Number(input.started_at), Number(input.ended_at), ts, ts];
      generatedCoupons.push({ ...input, code, type: couponType, created_at: ts });
      if (id && index === 0) return env.XBOARD_DB.prepare("UPDATE v2_coupon SET code=?, name=?, type=?, value=?, show=?, limit_use=?, limit_use_with_user=?, limit_plan_ids=?, limit_period=?, started_at=?, ended_at=?, updated_at=? WHERE id=?").bind(...values.slice(0, 11), ts, id);
      return env.XBOARD_DB.prepare("INSERT INTO v2_coupon(code,name,type,value,show,limit_use,limit_use_with_user,limit_plan_ids,limit_period,started_at,ended_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...values);
    });
    try { await env.XBOARD_DB.batch(statements); } catch { return fail("优惠券代码已存在或参数无效", 400, 400); }
    if (!id && input.generate_count) {
      const dateTime = (value: unknown) => new Date(Number(value || 0) * 1000).toISOString().replace("T", " ").slice(0, 19);
      const csvValue = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const lines = ["名称,类型,金额或比例,开始时间,结束时间,可用次数,可用于订阅,券码,生成时间"];
      for (const coupon of generatedCoupons) {
        lines.push([
          coupon.name,
          coupon.type === 1 ? "金额" : "比例",
          coupon.type === 1 ? Number(coupon.value || 0) / 100 : Number(coupon.value || 0),
          dateTime(coupon.started_at),
          dateTime(coupon.ended_at),
          coupon.limit_use ?? "不限制",
          parseJsonArray(coupon.limit_plan_ids).join("/") || "不限制",
          coupon.code,
          dateTime(coupon.created_at)
        ].map(csvValue).join(","));
      }
      return new Response(`${lines.join("\r\n")}\r\n`, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="coupons-${ts}.csv"`
        }
      });
    }
    return ok(true);
  }
  if (!id) return fail("优惠券ID不能为空", 422, 422);
  const exists = await env.XBOARD_DB.prepare("SELECT id, show FROM v2_coupon WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!exists) return fail("优惠券不存在", 400, 400202);
  if (route === "/coupon/drop") { await env.XBOARD_DB.prepare("DELETE FROM v2_coupon WHERE id = ?").bind(id).run(); return ok(true); }
  if (route === "/coupon/show") { await env.XBOARD_DB.prepare("UPDATE v2_coupon SET show = ?, updated_at = ? WHERE id = ?").bind(Number(exists.show) ? 0 : 1, now(), id).run(); return ok(true); }
  if (route === "/coupon/update") { await env.XBOARD_DB.prepare("UPDATE v2_coupon SET show = ?, updated_at = ? WHERE id = ?").bind(boolNumber(input.show, Number(exists.show)), now(), id).run(); return ok(true); }
  return null;
}

async function themeApi(request: Request, env: Env, route: string): Promise<Response | null> {
  if (!route.startsWith("/theme/")) return null;
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV); const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  if (route === "/theme/getThemes") return ok({ themes: { Xboard: { name: "Xboard", version: "Cloudflare", description: "Cloudflare bundled user theme", configs: [], can_delete: false, is_system: true } }, active: pickSetting(all, "frontend_theme", "Xboard") });
  const name = String(input.name || "");
  if (!name) return fail("主题名称不能为空", 422, 422);
  if (name !== "Xboard") return fail("Cloudflare 构建仅包含内置 Xboard 主题", 400, 400);
  if (route === "/theme/getThemeConfig") return ok(pickSetting(all, `theme_${name}`, {}));
  if (route === "/theme/saveThemeConfig") {
    const ts = now(); const config = input.config && typeof input.config === "object" ? input.config : {};
    await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name,value,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(`theme_${name}`, JSON.stringify(config), ts, ts).run();
    return ok(config);
  }
  if (route === "/theme/delete") return fail("系统主题不能删除", 400, 400);
  if (route === "/theme/upload") return fail("Cloudflare Workers 不支持运行 Laravel Blade 主题包", 400, 400);
  return null;
}

async function pluginApi(request: Request, env: Env, route: string): Promise<Response | null> {
  if (!route.startsWith("/plugin/")) return null;
  if (route === "/plugin/types") return json({ data: [{ value: "feature", label: "功能", description: "提供功能扩展的插件", icon: "" }, { value: "payment", label: "支付方式", description: "提供支付接口的插件", icon: "" }] });
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  const code = String(input.code || new URL(request.url).searchParams.get("code") || "");
  if (route === "/plugin/getPlugins") {
    const type = new URL(request.url).searchParams.get("type"); const result = type ? await env.XBOARD_DB.prepare("SELECT * FROM v2_plugins WHERE type = ? ORDER BY id").bind(type).all<Record<string, any>>() : await env.XBOARD_DB.prepare("SELECT * FROM v2_plugins ORDER BY id").all<Record<string, any>>();
    return json({ data: (result.results || []).map(row => ({ ...row, is_installed: true, is_enabled: !!row.is_enabled, is_protected: false, can_be_deleted: true, config: parseJsonObject(row.config), readme: "", need_upgrade: false })) });
  }
  if (route === "/plugin/upload") return json({ message: "Cloudflare Workers 无法执行任意 Laravel PHP 插件包" }, 400);
  if (!code) return json({ message: "code 字段是必须的" }, 422);
  const plugin = await env.XBOARD_DB.prepare("SELECT * FROM v2_plugins WHERE code = ?").bind(code).first<Record<string, any>>();
  if (route === "/plugin/install") {
    if (!plugin) return json({ message: "插件包不存在，Cloudflare 版本只支持预置的原生插件" }, 400);
    await env.XBOARD_DB.prepare("UPDATE v2_plugins SET installed_at=?,updated_at=? WHERE code=?").bind(now(), now(), code).run(); return json({ message: "插件安装成功" });
  }
  if (!plugin) return json({ message: "插件不存在" }, 400);
  if (route === "/plugin/config" && request.method === "GET") return json({ data: parseJsonObject(plugin.config) });
  if (route === "/plugin/config") { await env.XBOARD_DB.prepare("UPDATE v2_plugins SET config=?,updated_at=? WHERE code=?").bind(JSON.stringify(input.config || {}), now(), code).run(); return json({ message: "配置更新成功" }); }
  if (route === "/plugin/enable" || route === "/plugin/disable") { await env.XBOARD_DB.prepare("UPDATE v2_plugins SET is_enabled=?,updated_at=? WHERE code=?").bind(route.endsWith("enable") ? 1 : 0, now(), code).run(); return json({ message: route.endsWith("enable") ? "插件启用成功" : "插件禁用成功" }); }
  if (route === "/plugin/uninstall") { if (Number(plugin.is_enabled)) return json({ message: "请先禁用插件后再卸载" }, 400); await env.XBOARD_DB.prepare("UPDATE v2_plugins SET installed_at=NULL,updated_at=? WHERE code=?").bind(now(), code).run(); return json({ message: "插件卸载成功" }); }
  if (route === "/plugin/delete") { await env.XBOARD_DB.prepare("DELETE FROM v2_plugins WHERE code=?").bind(code).run(); return json({ message: "插件删除成功" }); }
  if (route === "/plugin/upgrade") return json({ message: "当前已是最新版本" });
  return null;
}

const orderPeriods: Record<string, string> = {
  month_price: "monthly", quarter_price: "quarterly", half_year_price: "half_yearly", year_price: "yearly",
  two_year_price: "two_yearly", three_year_price: "three_yearly", onetime_price: "onetime", reset_price: "reset_traffic"
};
const legacyOrderPeriods = Object.fromEntries(Object.entries(orderPeriods).map(([legacy, current]) => [current, legacy]));
const orderPeriodMonths: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12, two_yearly: 24, three_yearly: 36 };
const canonicalOrderPeriods = new Set([...Object.values(orderPeriods)]);

function normalizeOrderPeriod(period: unknown) {
  const value = String(period || "");
  return orderPeriods[value] || (canonicalOrderPeriods.has(value) ? value : "");
}

function legacyOrderPeriod(period: unknown) {
  const value = String(period || "");
  return legacyOrderPeriods[value] || value;
}

async function orderRows(env: Env, input: Record<string, any>) {
  const page = Math.max(1, Number(input.current || input.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || input.page_size || 10)));
  const clauses: string[] = [];
  const binds: any[] = [];
  if (input.is_commission === true || input.is_commission === "true" || Number(input.is_commission) === 1) {
    clauses.push("o.invite_user_id IS NOT NULL", "CAST(o.status AS INTEGER) NOT IN (0, 2)", "COALESCE(o.commission_balance, 0) > 0");
  }
  const allowed: Record<string, string> = {
    id: "o.id", email: "u.email", user_id: "o.user_id", plan_id: "o.plan_id", trade_no: "o.trade_no", type: "o.type",
    period: "o.period", status: "o.status", commission_status: "o.commission_status", invite_user_id: "o.invite_user_id",
    callback_no: "o.callback_no", commission_balance: "o.commission_balance", total_amount: "o.total_amount", created_at: "o.created_at"
  };
  for (const filter of parseJsonArray(input.filter)) {
    const key = String(filter?.id || filter?.key || "");
    const field = allowed[key];
    if (!field) continue;
    const raw = filter?.value;
    if (Array.isArray(raw)) {
      const values = raw.filter(value => value !== "" && value !== null && value !== undefined);
      if (values.length) { clauses.push(`${field} IN (${values.map(() => "?").join(",")})`); binds.push(...values); }
      continue;
    }
    const text = String(raw ?? "");
    const nullOperator = text.toLowerCase();
    if (nullOperator === "null" || nullOperator === "notnull") {
      clauses.push(`${field} IS ${nullOperator === "notnull" ? "NOT " : ""}NULL`);
      continue;
    }
    const match = text.match(/^(eq|neq|gt|gte|lt|lte|like|notlike):(.*)$/i);
    const operator = match?.[1]?.toLowerCase(); const value = match ? match[2] : text;
    const condition = String(filter?.condition || "");
    const conditionOperator: Record<string, string> = { "=": "=", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=", "模糊": "LIKE" };
    const sqlOperator = conditionOperator[condition] || ({ eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", notlike: "NOT LIKE" }[operator || ""] || "LIKE");
    clauses.push(`${field} ${sqlOperator} ?`);
    binds.push(["LIKE", "NOT LIKE"].includes(sqlOperator) ? `%${value}%` : value);
  }
  const sorts = parseJsonArray(input.sort);
  const sort = sorts.find(item => allowed[String(item?.id || "")]);
  const orderBy = sort ? `${allowed[String(sort.id)]} ${sort.desc ? "DESC" : "ASC"}` : "o.created_at DESC";
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.XBOARD_DB.prepare(`SELECT o.*, p.name AS plan_name FROM v2_order o LEFT JOIN v2_plan p ON p.id = o.plan_id LEFT JOIN v2_user u ON u.id = o.user_id${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, (page - 1) * pageSize).all<Record<string, any>>();
  const total = await env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_order o LEFT JOIN v2_user u ON u.id = o.user_id${where}`).bind(...binds).first<{ count: number }>();
  const data = (result.results || []).map(row => ({
    ...row,
    status: Number(row.status), type: Number(row.type || 1), commission_status: Number(row.commission_status || 0),
    total_amount: Number(row.total_amount || 0), period: legacyOrderPeriod(row.period),
    plan: row.plan_id ? { id: Number(row.plan_id), name: row.plan_name || "" } : null
  }));
  return paginated(data, Number(total?.count || 0), page, pageSize);
}

async function orderDetail(env: Env, id: number) {
  const row = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!row) return null;
  const surplusOrderIds = parseJsonArray(row.surplus_order_ids).map(Number).filter(Boolean);
  const [surplusResult, commissionResult, user, plan, inviteUser] = await Promise.all([
    surplusOrderIds.length
      ? env.XBOARD_DB.prepare(`SELECT * FROM v2_order WHERE id IN (${surplusOrderIds.map(() => "?").join(",")}) ORDER BY id ASC`).bind(...surplusOrderIds).all<Record<string, any>>()
      : Promise.resolve({ results: [] } as { results: Record<string, any>[] }),
    env.XBOARD_DB.prepare("SELECT * FROM v2_commission_log WHERE trade_no = ? ORDER BY id ASC").bind(String(row.trade_no || "")).all<Record<string, any>>(),
    row.user_id ? env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(row.user_id).first<Record<string, any>>() : Promise.resolve(null),
    row.plan_id ? env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(row.plan_id).first<Record<string, any>>() : Promise.resolve(null),
    row.invite_user_id ? env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(row.invite_user_id).first<Record<string, any>>() : Promise.resolve(null)
  ]);
  return {
    ...row, status: Number(row.status), type: Number(row.type || 1), commission_status: Number(row.commission_status || 0),
    total_amount: Number(row.total_amount || 0), period: legacyOrderPeriod(row.period),
    user: user ? safeUser(user) : null,
    plan: plan ? { ...plan, prices: parseJsonObject(plan.prices), tags: parseJsonArray(plan.tags) } : null,
    invite_user: inviteUser ? safeUser(inviteUser) : null,
    commission_log: commissionResult.results || [], surplus_orders: surplusResult.results || []
  };
}

const EDGE_SHANGHAI_OFFSET = 8 * 3600;

function addOrderMonths(timestamp: number, months: number) {
  const date = new Date((timestamp + EDGE_SHANGHAI_OFFSET) * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000) - EDGE_SHANGHAI_OFFSET;
}

async function orderSurplus(env: Env, user: Record<string, any>, settingsValues: Record<string, any>) {
  if (user.expired_at === null || user.expired_at === undefined) {
    const lastOrder = await env.XBOARD_DB.prepare("SELECT id, total_amount, balance_amount FROM v2_order WHERE user_id = ? AND period = 'onetime' AND status = 3 ORDER BY id DESC LIMIT 1").bind(user.id).first<Record<string, any>>();
    const trafficGb = Number(user.transfer_enable || 0) / 1073741824;
    const paidAmount = Number(lastOrder?.total_amount || 0) + Number(lastOrder?.balance_amount || 0);
    if (!lastOrder || trafficGb <= 0 || paidAmount <= 0) return { amount: 0, orderIds: [] as number[] };
    const unusedGb = trafficGb - (Number(user.u || 0) + Number(user.d || 0)) / 1073741824;
    const rows = await env.XBOARD_DB.prepare("SELECT id FROM v2_order WHERE user_id = ? AND period != 'reset_traffic' AND status = 3 ORDER BY id ASC").bind(user.id).all<{ id: number }>();
    return { amount: Math.trunc(Math.max(0, paidAmount / trafficGb * unusedGb)), orderIds: (rows.results || []).map(row => Number(row.id)) };
  }

  const orders = await env.XBOARD_DB.prepare("SELECT id, period, total_amount, balance_amount, surplus_amount, surplus_credit, created_at FROM v2_order WHERE user_id = ? AND period NOT IN ('reset_traffic', 'onetime') AND status = 3 ORDER BY id ASC").bind(user.id).all<Record<string, any>>();
  const rows = orders.results || [];
  if (!rows.length) return { amount: 0, orderIds: [] as number[] };
  const monthSum = rows.reduce((sum, row) => sum + Number(orderPeriodMonths[String(row.period)] || 0), 0);
  const firstOrderAt = Math.min(...rows.map(row => Number(row.created_at || 0)).filter(Boolean));
  if (!firstOrderAt || monthSum <= 0) return { amount: 0, orderIds: rows.map(row => Number(row.id)) };
  const calculatedExpiry = addOrderMonths(firstOrderAt, monthSum);
  const totalSeconds = calculatedExpiry - firstOrderAt;
  const cycleRatio = totalSeconds > 0 ? Math.max(0, calculatedExpiry - now()) / totalSeconds : 0;
  const currentPlan = user.plan_id ? await env.XBOARD_DB.prepare("SELECT transfer_enable FROM v2_plan WHERE id = ?").bind(user.plan_id).first<{ transfer_enable: number }>() : null;
  const totalTrafficGb = Number(currentPlan?.transfer_enable || 0) * monthSum;
  const remainTrafficGb = Math.max(0, totalTrafficGb - (Number(user.u || 0) + Number(user.d || 0)) / 1073741824);
  const trafficRatio = totalTrafficGb > 0 ? remainTrafficGb / totalTrafficGb : 0;
  const ratio = Number(pickSetting(settingsValues, "change_order_event_id", 0)) === 1 ? Math.min(cycleRatio, trafficRatio) : cycleRatio;
  const amountSum = rows.reduce((sum, row) => sum + Number(row.total_amount || 0) + Number(row.balance_amount || 0) + Number(row.surplus_amount || 0) - Number(row.surplus_credit || 0), 0);
  return { amount: Math.trunc(Math.max(0, amountSum * ratio)), orderIds: rows.map(row => Number(row.id)) };
}

function edgeShanghaiParts(ts: number) {
  const date = new Date((ts + EDGE_SHANGHAI_OFFSET) * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}
function edgeShanghaiTimestamp(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000) - EDGE_SHANGHAI_OFFSET;
}
function edgeDaysInMonth(year: number, month: number) { return new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); }
function edgeNextResetAt(expiredAt: number | null, method: number, from: number) {
  if (expiredAt == null || method === 2) return null;
  const current = edgeShanghaiParts(from); const expiry = edgeShanghaiParts(expiredAt);
  if (method === 0) return edgeShanghaiTimestamp(current.year + (current.month === 11 ? 1 : 0), current.month === 11 ? 0 : current.month + 1, 1);
  if (method === 1) {
    let candidate = edgeShanghaiTimestamp(current.year, current.month, expiry.day, expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    const month = current.month === 11 ? 0 : current.month + 1; const year = current.year + (current.month === 11 ? 1 : 0);
    return edgeShanghaiTimestamp(year, month, Math.min(expiry.day, edgeDaysInMonth(year, month)), expiry.hour, expiry.minute, expiry.second);
  }
  if (method === 3) return edgeShanghaiTimestamp(current.year + 1, 0, 1);
  if (method === 4) {
    const candidate = edgeShanghaiTimestamp(current.year, expiry.month, expiry.day, expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    const year = current.year + 1;
    return edgeShanghaiTimestamp(year, expiry.month, Math.min(expiry.day, edgeDaysInMonth(year, expiry.month)), expiry.hour, expiry.minute, expiry.second);
  }
  return null;
}

async function orderCommission(env: Env, user: Record<string, any>, totalAmount: number) {
  const inviteUserId = nullableNumber(user.invite_user_id);
  if (!inviteUserId || totalAmount <= 0) return { inviteUserId: null, commissionBalance: 0 };
  const inviter = await env.XBOARD_DB.prepare("SELECT id, commission_type, commission_rate FROM v2_user WHERE id = ?").bind(inviteUserId).first<Record<string, any>>();
  if (!inviter) return { inviteUserId, commissionBalance: 0 };
  let commissionType = Number(inviter.commission_type || 0);
  if (commissionType === 0) commissionType = Number(pickSetting(await settings(env.XBOARD_DB, env.XBOARD_KV), "commission_first_time_enable", 1)) ? 2 : 1;
  if (commissionType === 2) {
    const valid = await env.XBOARD_DB.prepare("SELECT id FROM v2_order WHERE user_id = ? AND status NOT IN (0, 2) LIMIT 1").bind(user.id).first();
    if (valid) return { inviteUserId, commissionBalance: 0 };
  }
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const rate = Number(inviter.commission_rate || pickSetting(all, "invite_commission", 10));
  return { inviteUserId, commissionBalance: Math.trunc(totalAmount * rate / 100) };
}

async function cancelOrder(env: Env, order: Record<string, any>, ts: number) {
  const refund = Math.max(0, Number(order.balance_amount || 0));
  const statements = [];
  if (refund) statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET balance = COALESCE(balance, 0) + COALESCE((SELECT balance_amount FROM v2_order WHERE id = ? AND status = 0), 0), updated_at = ? WHERE id = ?").bind(order.id, ts, order.user_id));
  statements.push(env.XBOARD_DB.prepare("UPDATE v2_order SET status = 2, updated_at = ? WHERE id = ? AND status = 0").bind(ts, order.id));
  const results = await env.XBOARD_DB.batch(statements);
  return Number((results.at(-1)?.meta as any)?.changes || 0) === 1;
}

async function adminOrder(request: Request, env: Env, route: string): Promise<Response | null> {
  if (!route.startsWith("/order/")) return null;
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {} as Record<string, any>;
  if (request.method !== "POST") new URL(request.url).searchParams.forEach((value, key) => { input[key] = value; });
  if (route === "/order/fetch") return json(await orderRows(env, input));
  if (route === "/order/assign") {
    const email = String(input.email || "").trim().toLowerCase(); const planId = nullableNumber(input.plan_id);
    const legacyPeriod = String(input.period || ""); const period = normalizeOrderPeriod(legacyPeriod); const totalAmount = Number(input.total_amount);
    if (!email) return fail("邮箱不能为空", 422, 422);
    if (!planId) return fail("订阅不能为空", 422, 422);
    if (!period) return fail("订阅周期格式有误", 422, 422);
    if (!Number.isFinite(totalAmount) || totalAmount < 0) return fail("支付金额格式有误", 422, 422);
    const user = await env.XBOARD_DB.prepare("SELECT id, plan_id, expired_at, invite_user_id FROM v2_user WHERE email=?").bind(email).first<Record<string, any>>();
    if (!user) return fail("该用户不存在", 400, 400202);
    const plan = await env.XBOARD_DB.prepare("SELECT id FROM v2_plan WHERE id=?").bind(planId).first();
    if (!plan) return fail("该订阅不存在", 400, 400202);
    const pending = await env.XBOARD_DB.prepare("SELECT id FROM v2_order WHERE user_id=? AND CAST(status AS INTEGER) IN (0,1) LIMIT 1").bind(user.id).first();
    if (pending) return fail("该用户还有待支付的订单，无法分配", 400, 400);
    const orderType = period === "reset_traffic" ? 4 : user.plan_id && Number(user.plan_id) !== planId ? 3 : (Number(user.plan_id) === planId && Number(user.expired_at || 0) > now()) ? 2 : 1;
    const commission = await orderCommission(env, user, Math.trunc(totalAmount));
    const tradeNo = token(16); const ts = now();
    await env.XBOARD_DB.prepare("INSERT INTO v2_order(user_id,plan_id,period,trade_no,status,total_amount,type,commission_status,invite_user_id,commission_balance,created_at,updated_at) VALUES (?,?,?,?,0,?,?,0,?,?,?,?)")
      .bind(user.id, planId, period, tradeNo, Math.trunc(totalAmount), orderType, commission.inviteUserId, commission.commissionBalance, ts, ts).run();
    return ok(tradeNo);
  }
  if (route === "/order/detail") {
    const detail = await orderDetail(env, Number(input.id || 0));
    return detail ? ok(detail) : fail("订单不存在", 400, 400202);
  }
  const tradeNo = String(input.trade_no || "");
  const order = tradeNo ? await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE trade_no=?").bind(tradeNo).first<Record<string, any>>() : null;
  if (!order) return fail("订单不存在", 400, 400202);
  if (route === "/order/update") {
    await env.XBOARD_DB.prepare("UPDATE v2_order SET commission_status=?,updated_at=? WHERE trade_no=?").bind(Number(input.commission_status || 0), now(), tradeNo).run();
    return ok(true);
  }
  if (Number(order.status) !== 0) return fail("只能对待支付的订单进行操作", 400, 400);
  if (route === "/order/cancel") {
    return await cancelOrder(env, order, now()) ? ok(true) : fail("只能对待支付的订单进行操作", 400, 400);
  }
  if (route === "/order/paid") {
    const plan = await env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id=?").bind(order.plan_id).first<Record<string, any>>();
    const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id=?").bind(order.user_id).first<Record<string, any>>();
    if (!plan || !user) return fail("订单关联的用户或订阅不存在", 400, 400202);
    const period = String(order.period || ""); const ts = now();
    const callbackNo = String(input.callback_no || "manual_operation");
    const claimed = await env.XBOARD_DB.prepare("UPDATE v2_order SET status=1,paid_at=?,callback_no=?,updated_at=? WHERE id=? AND status=0 RETURNING id")
      .bind(ts, callbackNo, ts, order.id).first<{ id: number }>();
    if (!claimed) return fail("只能对待支付的订单进行操作", 400, 400);
    const statements: D1PreparedStatement[] = [];
    const orderGuard = "EXISTS (SELECT 1 FROM v2_order WHERE id = ? AND status = 1)";
    const surplusOrderIds = parseJsonArray(order.surplus_order_ids).map(Number).filter(Boolean);
    if (surplusOrderIds.length) {
      statements.push(env.XBOARD_DB.prepare(`UPDATE v2_order SET status=4,updated_at=? WHERE id IN (${surplusOrderIds.map(() => "?").join(",")}) AND ${orderGuard}`)
        .bind(ts, ...surplusOrderIds, order.id));
    }
    const allSettings = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const eventSetting = Number(order.type) === 1 ? "new_order_event_id" : Number(order.type) === 2 ? "renew_order_event_id" : Number(order.type) === 3 ? "change_order_event_id" : "";
    const orderEventId = eventSetting ? Number(pickSetting(allSettings, eventSetting, 0)) : 0;
    let resetTraffic = orderEventId === 1;
    let expiredAt: number | null = user.expired_at == null ? null : Number(user.expired_at);
    if (period === "reset_traffic") {
      resetTraffic = true;
    } else {
      const months: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12, two_yearly: 24, three_yearly: 36 };
      const expiryBase = Number(order.type) === 3 ? ts : Math.max(ts, Number(user.expired_at || 0));
      expiredAt = period === "onetime" ? null : addOrderMonths(expiryBase, months[period] || 0);
      if (period !== "onetime" && !months[period]) return fail("无效的套餐周期", 400, 400);
      resetTraffic = resetTraffic || period === "onetime" || user.expired_at == null || Number(order.type) === 1;
    }
    const method = plan.reset_traffic_method === null || plan.reset_traffic_method === undefined ? Number(pickSetting(allSettings, "reset_traffic_method", 0)) : Number(plan.reset_traffic_method);
    const nextReset = resetTraffic ? edgeNextResetAt(expiredAt, method, ts) : user.next_reset_at ?? null;
    if (period === "reset_traffic") {
      statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET u=0,d=0,balance=COALESCE(balance,0)+?,last_reset_at=?,next_reset_at=?,reset_count=COALESCE(reset_count,0)+1,updated_at=? WHERE id=? AND ${orderGuard}`)
        .bind(Number(order.surplus_credit || 0), ts, nextReset, ts, user.id, order.id));
    } else {
      statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET plan_id=?,group_id=?,transfer_enable=?,speed_limit=?,device_limit=?,expired_at=?,u=?,d=?,balance=COALESCE(balance,0)+?,last_reset_at=?,next_reset_at=?,reset_count=COALESCE(reset_count,0)+?,updated_at=? WHERE id=? AND ${orderGuard}`)
        .bind(plan.id, plan.group_id, Number(plan.transfer_enable || 0) * 1073741824, plan.speed_limit ?? null, plan.device_limit ?? null, expiredAt, resetTraffic ? 0 : Number(user.u || 0), resetTraffic ? 0 : Number(user.d || 0), Number(order.surplus_credit || 0), resetTraffic ? ts : user.last_reset_at ?? null, nextReset, resetTraffic ? 1 : 0, ts, user.id, order.id));
    }
    if (resetTraffic) {
      const resetTypes: Record<number, string> = { 0: "first_day_month", 1: "monthly", 3: "first_day_year", 4: "yearly" };
      statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_reset_logs(user_id,reset_type,old_u,old_d,old_upload,old_download,old_total,new_upload,new_download,new_total,trigger_source,metadata,reset_time,created_at)
        SELECT ?,?,?,?,?,?,?,0,0,0,'order',?,?,? WHERE ${orderGuard}`)
        .bind(user.id, resetTypes[method] || "manual", Number(user.u || 0), Number(user.d || 0), Number(user.u || 0), Number(user.d || 0), Number(user.u || 0) + Number(user.d || 0), JSON.stringify({ order_id: order.id, trade_no: tradeNo, event_id: orderEventId || null }), ts, ts, order.id));
    }
    statements.push(env.XBOARD_DB.prepare("UPDATE v2_order SET status=3,updated_at=? WHERE id=? AND status=1").bind(ts, order.id));
    const results = await env.XBOARD_DB.batch(statements);
    if (Number((results.at(-1)?.meta as any)?.changes || 0) !== 1) return fail("订单开通失败，请稍后重试", 500, 500);
    await bump(env.XBOARD_KV, `user_version:${order.user_id}`);
    return ok(true);
  }
  return null;
}

async function sortAdminRows(env: Env, table: string, input: Record<string, any>) {
  const ids = parseJsonArray(input.ids).map(Number).filter(Boolean);
  if (!ids.length) return fail("参数有误", 422, 422);
  await env.XBOARD_DB.batch(ids.map((id, index) => env.XBOARD_DB.prepare(`UPDATE ${table} SET sort = ?, updated_at = ? WHERE id = ?`).bind(index + 1, now(), id)));
  return ok(true);
}

async function adminCoreResource(request: Request, env: Env, route: string): Promise<Response | null> {
  if (!/^\/(plan|notice|knowledge|server\/group|server\/route|server\/machine)\//.test(route)) return null;
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  const id = nullableNumber(input.id || new URL(request.url).searchParams.get("id"));
  if (route === "/plan/save") {
    const name = String(input.name || "").trim();
    const transferEnable = Number(input.transfer_enable);
    if (!name) return fail("套餐名称不能为空", 422, 422);
    if (!Number.isInteger(transferEnable) || transferEnable < 1) return fail("流量配额必须是大于0的整数", 422, 422);
    const allowedPeriods = new Set(["monthly", "quarterly", "half_yearly", "yearly", "two_yearly", "three_yearly", "onetime", "reset_traffic"]);
    const prices: Record<string, number> = {};
    const rawPrices = input.prices && typeof input.prices === "object" ? input.prices : {};
    for (const [period, rawPrice] of Object.entries(rawPrices)) {
      if (!allowedPeriods.has(period)) return fail(`不支持的订阅周期: ${period}`, 422, 422);
      if (rawPrice !== null && rawPrice !== "" && (!Number.isFinite(Number(rawPrice)) || Number(rawPrice) < 0)) return fail("价格必须大于等于0", 422, 422);
      if (rawPrice !== null && rawPrice !== undefined && rawPrice !== "" && Number.isFinite(Number(rawPrice)) && Number(rawPrice) >= 0) {
        prices[period] = Math.round(Number(rawPrice) * 100) / 100;
      }
    }
    const values: Record<string, any> = {
      name,
      transfer_enable: transferEnable,
      group_id: nullableNumber(input.group_id),
      speed_limit: nullableNumber(input.speed_limit),
      device_limit: nullableNumber(input.device_limit),
      capacity_limit: nullableNumber(input.capacity_limit),
      reset_traffic_method: input.reset_traffic_method === null || input.reset_traffic_method === "" ? null : Number(input.reset_traffic_method),
      prices: JSON.stringify(prices),
      content: input.content === null ? null : String(input.content || ""),
      tags: JSON.stringify(parseJsonArray(input.tags))
    };
    const ts = now();
    if (id) {
      if (!(await env.XBOARD_DB.prepare("SELECT id FROM v2_plan WHERE id = ?").bind(id).first())) return fail("该订阅不存在", 400, 400202);
      const statements = [env.XBOARD_DB.prepare(`UPDATE v2_plan SET ${Object.keys(values).map(key => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...Object.values(values), ts, id)];
      if (boolNumber(input.force_update)) {
        statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET group_id = ?, transfer_enable = ?, speed_limit = ?, device_limit = ?, updated_at = ? WHERE plan_id = ?")
          .bind(values.group_id, transferEnable * 1073741824, values.speed_limit, values.device_limit, ts, id));
      }
      await env.XBOARD_DB.batch(statements);
    } else {
      await env.XBOARD_DB.prepare(`INSERT INTO v2_plan(${Object.keys(values).join(",")},show,sell,renew,sort,created_at,updated_at) VALUES (${Object.keys(values).map(() => "?").join(",")},1,1,1,0,?,?)`).bind(...Object.values(values), ts, ts).run();
    }
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  if (route === "/plan/update") {
    if (!id) return fail("该订阅不存在", 400, 400202);
    const fields = Object.entries(input).filter(([key]) => ["show", "renew", "sell"].includes(key));
    if (fields.length) await env.XBOARD_DB.prepare(`UPDATE v2_plan SET ${fields.map(([key]) => `${key} = ?`).join(",")}, updated_at = ? WHERE id = ?`).bind(...fields.map(([, value]) => boolNumber(value)), now(), id).run();
    return ok(true);
  }
  if (route === "/plan/drop") {
    if (!id) return fail("该订阅不存在", 400, 400202);
    if (await env.XBOARD_DB.prepare("SELECT id FROM v2_order WHERE plan_id = ? LIMIT 1").bind(id).first()) return fail("该订阅下存在订单无法删除", 400, 400201);
    if (await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE plan_id = ? LIMIT 1").bind(id).first()) return fail("该订阅下存在用户无法删除", 400, 400201);
    await env.XBOARD_DB.prepare("DELETE FROM v2_plan WHERE id = ?").bind(id).run();
    return ok(true);
  }
  if (route === "/plan/sort") return sortAdminRows(env, "v2_plan", input);
  if (route === "/notice/save") {
    if (!String(input.title || "").trim()) return fail("公告标题不能为空", 422, 422);
    const values = { title: String(input.title), content: String(input.content || ""), img_url: input.img_url || null, tags: JSON.stringify(parseJsonArray(input.tags)), show: boolNumber(input.show, 1), popup: boolNumber(input.popup, 0) };
    const ts = now();
    if (id) await env.XBOARD_DB.prepare("UPDATE v2_notice SET title=?,content=?,img_url=?,tags=?,show=?,popup=?,updated_at=? WHERE id=?").bind(...Object.values(values), ts, id).run();
    else await env.XBOARD_DB.prepare("INSERT INTO v2_notice(title,content,img_url,tags,show,popup,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)").bind(...Object.values(values), ts, ts).run();
    return ok(true);
  }
  if (route === "/notice/update") {
    if (!id) return fail("公告不存在", 400, 400202);
    const fields = Object.entries(input).filter(([key]) => ["show", "popup"].includes(key));
    if (fields.length) await env.XBOARD_DB.prepare(`UPDATE v2_notice SET ${fields.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=?`).bind(...fields.map(([, value]) => boolNumber(value)), now(), id).run();
    return ok(true);
  }
  if (route === "/notice/show" || route === "/knowledge/show") {
    const table = route.startsWith("/notice/") ? "v2_notice" : "v2_knowledge";
    if (!id) return fail(route.startsWith("/notice/") ? "公告ID不能为空" : "知识库ID不能为空", 422, 422);
    const result = await env.XBOARD_DB.prepare(`UPDATE ${table} SET show = CASE WHEN show = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?`).bind(now(), id).run();
    return Number((result.meta as any)?.changes || 0) ? ok(true) : fail(route.startsWith("/notice/") ? "公告不存在" : "知识不存在", 400, 400202);
  }
  if (route === "/notice/drop" || route === "/knowledge/drop") {
    const table = route.startsWith("/notice/") ? "v2_notice" : "v2_knowledge";
    if (!id) return fail("ID不能为空", 422, 422);
    const result = await env.XBOARD_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    return Number((result.meta as any)?.changes || 0) ? ok(true) : fail("数据不存在", 400, 400202);
  }
  if (route === "/notice/sort") return sortAdminRows(env, "v2_notice", input);
  if (route === "/knowledge/save") {
    const title = String(input.title || "").trim();
    const category = String(input.category || "").trim();
    if (!title || !category) return fail("标题和分类不能为空", 422, 422);
    const bodyValue = String(input.body ?? input.content ?? "");
    const ts = now();
    const language = String(input.language || "zh-CN");
    if (id) await env.XBOARD_DB.prepare("UPDATE v2_knowledge SET title=?,category=?,body=?,language=?,show=?,updated_at=? WHERE id=?").bind(title, category, bodyValue, language, boolNumber(input.show, 1), ts, id).run();
    else await env.XBOARD_DB.prepare("INSERT INTO v2_knowledge(title,category,body,language,show,sort,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)").bind(title, category, bodyValue, language, boolNumber(input.show, 1), ts, ts).run();
    return ok(true);
  }
  if (route === "/knowledge/sort") return sortAdminRows(env, "v2_knowledge", input);
  if (route === "/server/group/save") {
    const name = String(input.name || "").trim();
    if (!name) return fail("组名不能为空", 422, 422);
    const ts = now();
    if (id) {
      const result = await env.XBOARD_DB.prepare("UPDATE v2_server_group SET name = ?, updated_at = ? WHERE id = ?").bind(name, ts, id).run();
      if (!Number((result.meta as any)?.changes || 0)) return fail("组不存在", 400, 400202);
    } else {
      await env.XBOARD_DB.prepare("INSERT INTO v2_server_group(name, created_at, updated_at) VALUES (?, ?, ?)").bind(name, ts, ts).run();
    }
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  if (route === "/server/group/drop") {
    if (!id) return fail("权限组不存在", 400, 400202);
    if (await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE group_id = ? LIMIT 1").bind(id).first()) return fail("该权限组下存在用户无法删除", 400, 400201);
    if (await env.XBOARD_DB.prepare("SELECT id FROM v2_plan WHERE group_id = ? LIMIT 1").bind(id).first()) return fail("该权限组下存在订阅无法删除", 400, 400201);
    const servers = await env.XBOARD_DB.prepare("SELECT id,group_ids FROM v2_server").all<Record<string, any>>();
    if ((servers.results || []).some(server => parseJsonArray(server.group_ids).map(Number).includes(id))) return fail("该权限组下存在节点无法删除", 400, 400201);
    await env.XBOARD_DB.prepare("DELETE FROM v2_server_group WHERE id = ?").bind(id).run();
    return ok(true);
  }
  if (route === "/server/route/save") {
    const remarks = String(input.remarks || "").trim();
    const matches = parseJsonArray(input.match).map(value => String(value).trim()).filter(Boolean);
    const action = String(input.action || "");
    if (!remarks) return fail("备注不能为空", 422, 422);
    if (!matches.length) return fail("匹配值不能为空", 422, 422);
    if (!["block", "direct", "dns", "proxy"].includes(action)) return fail("动作类型参数有误", 422, 422);
    const ts = now();
    if (id) await env.XBOARD_DB.prepare("UPDATE v2_server_route SET remarks=?,match=?,action=?,action_value=?,updated_at=? WHERE id=?").bind(remarks, JSON.stringify(matches), action, input.action_value || null, ts, id).run();
    else await env.XBOARD_DB.prepare("INSERT INTO v2_server_route(remarks,match,action,action_value,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(remarks, JSON.stringify(matches), action, input.action_value || null, ts, ts).run();
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  if (route === "/server/route/drop") {
    if (!id) return fail("路由规则不存在", 400, 400202);
    const result = await env.XBOARD_DB.prepare("DELETE FROM v2_server_route WHERE id = ?").bind(id).run();
    if (Number((result.meta as any)?.changes || 0) !== 1) return fail("路由规则不存在", 400, 400202);
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  if (route === "/server/machine/drop") {
    if (!id) return fail("服务器不存在", 400, 400202);
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("UPDATE v2_server SET machine_id = NULL, updated_at = ? WHERE machine_id = ?").bind(now(), id),
      env.XBOARD_DB.prepare("DELETE FROM v2_server_machine WHERE id = ?").bind(id)
    ]);
    await clearStatus(env, "machine", id);
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  return null;
}

async function adminApi(request: Request, env: Env, path: string) {
  const route = path.replace(/^\/api\/v2\/admin/, "");
  if (request.method === "POST" && route === "/passport/auth/login") return login(request, env, true);
  if (!adminRouteAllowed(route, request.method)) return json({ message: "Not Found" }, 404);
  let admin = await currentUser(request, env.XBOARD_DB, env.XBOARD_KV, true);
  if (!admin && route.startsWith("/migration/")) {
    const migrationAdminId = await authorizeMigration(request.clone(), env, route);
    if (migrationAdminId !== null) admin = { id: migrationAdminId, email: "migration-session", is_admin: 1 };
  }
  if (!admin) return fail("未授权", 401, 401);
  const auditRequest = request.method === "POST" ? request.clone() : request;
  const response = await (async () => {
  if (request.method === "POST" && route === "/system/backfillAnalytics") {
    const callJobs = async (dataset: "user" | "server") => {
      const response = await env.XBOARD_JOBS.fetch(`https://xboard-jobs.internal/internal/analytics/backfill?dataset=${dataset}&limit=20`, { method: "POST" });
      if (!response.ok) throw new Error(`Traffic analytics backfill failed (${response.status})`);
      const payload = await response.json() as { data?: Record<string, unknown> };
      return payload.data || {};
    };
    const user = await callJobs("user");
    const server = await callJobs("server");
    const runtimeResponse = await statusHubRequest(env, "history/backfill", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 })
    });
    if (!runtimeResponse.ok) throw new Error(`Runtime analytics backfill failed (${runtimeResponse.status})`);
    const runtimePayload = await runtimeResponse.json() as { data?: Record<string, unknown> };
    analyticsCutoverCache = null;
    return ok({ user, server, runtime: runtimePayload.data || {} });
  }
  const migrationResponse = await handleAdminMigration(request.clone(), env, route, Number((admin as any).id || 0));
  if (migrationResponse) return migrationResponse;
  const giftCardResponse = await handleAdminGiftCard(request.clone(), env.XBOARD_DB, route, Number((admin as any).id || 0));
  if (giftCardResponse) return giftCardResponse;
  const ticketResponse = await adminTicket(request.clone(), env, route, Number((admin as any).id || 0));
  if (ticketResponse) return ticketResponse;
  const couponResponse = await adminCoupon(request.clone(), env, route);
  if (couponResponse) return couponResponse;
  const themeResponse = await themeApi(request.clone(), env, route);
  if (themeResponse) return themeResponse;
  const pluginResponse = await pluginApi(request.clone(), env, route);
  if (pluginResponse) return pluginResponse;
  const orderResponse = await adminOrder(request.clone(), env, route);
  if (orderResponse) return orderResponse;
  const coreResourceResponse = await adminCoreResource(request.clone(), env, route);
  if (coreResourceResponse) return coreResourceResponse;
  if (path.includes("/config/fetch")) return ok(await adminConfig(env, request));
  if (path.includes("/config/save")) {
    const input = await body<Record<string, any>>(request);
    if (Object.prototype.hasOwnProperty.call(input, "secure_path")) {
      const securePath = normalizeSecurePath(input.secure_path);
      if (securePath !== "admin" && securePath.length < 8) return fail("后台路径长度最小为8位", 422, 422);
      if (!/^[A-Za-z0-9_-]+$/.test(securePath)) return fail("后台路径只能为字母、数字、下划线或短横线", 422, 422);
      input.secure_path = securePath;
    }
    if (Object.prototype.hasOwnProperty.call(input, "email_driver")) {
      input.email_driver = String(input.email_driver || "").toLowerCase();
      if (!["maileroo", "brevo"].includes(input.email_driver)) return fail("邮件服务商只能是 Maileroo 或 Brevo", 422, 422);
    }
    const ts = now();
    for (const [name, value] of Object.entries(input)) {
      if (await saveSubscribeTemplate(env, name, value)) continue;
      if (!allowedConfigSettings.has(name)) return fail(`不支持的设置项: ${name}`, 422, 422);
      let storedValue = value;
      if (integerConfigSettings.has(name) && value !== null && value !== "") {
        const numeric = typeof value === "boolean" ? Number(value) : Number(value);
        if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return fail(`${name} 必须是整数`, 422, 422);
        storedValue = numeric;
      }
      if (numericConfigSettings.has(name) && value !== null && value !== "") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fail(`${name} 必须是数字`, 422, 422);
        if (name === "recaptcha_v3_score_threshold" && (numeric < 0 || numeric > 1)) return fail("reCAPTCHA v3 分数阈值必须在 0 到 1 之间", 422, 422);
        storedValue = numeric;
      }
      if (urlConfigSettings.has(name) && value !== null && value !== "") {
        try {
          const parsed = new URL(String(value));
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("protocol");
        } catch { return fail(`${name} 必须是有效的 HTTP(S) URL`, 422, 422); }
      }
      if (name === "server_token" && value !== null && value !== "" && String(value).length < 16) return fail("通讯密钥长度必须大于16位", 422, 422);
      if (name === "reset_traffic_method" && ![0, 1, 2, 3, 4].includes(Number(storedValue))) return fail("月流量重置方式无效", 422, 422);
      if (name === "captcha_type" && !["recaptcha", "turnstile", "recaptcha-v3"].includes(String(value))) return fail("人机验证类型无效", 422, 422);
      const emailAliases: Record<string, string> = {
        email_username: "resend_from_name", resend_from_name: "email_username",
        email_from_address: "resend_from_address", resend_from_address: "email_from_address"
      };
      await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(name, typeof storedValue === "object" ? JSON.stringify(storedValue) : String(storedValue), ts, ts).run();
      if (emailAliases[name]) {
        await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
          .bind(emailAliases[name], typeof storedValue === "object" ? JSON.stringify(storedValue) : String(storedValue), ts, ts).run();
      }
    }
    invalidateSettingsCache();
    await invalidateServerSettings(env);
    await bump(env.XBOARD_KV, "settings_version");
    return ok(true);
  }
  if (request.method === "GET" && route === "/config/getEmailTemplate") return ok(Object.keys(mailTemplateMeta));
  if (request.method === "GET" && route === "/config/getThemeTemplate") return ok(["Xboard"]);
  if (request.method === "POST" && route === "/config/testSendMail") {
    return ok(await sendTestMail(env, String((admin as any).email)));
  }
  if (request.method === "POST" && route === "/config/setTelegramWebhook") {
    const input = await body<Record<string, any>>(request); const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const botToken = String(input.telegram_bot_token || pickSetting(all, "telegram_bot_token", ""));
    const custom = String(pickSetting(all, "telegram_webhook_url", "")).trim();
    const base = (custom || String(pickSetting(all, "app_url", "")) || new URL(request.url).origin).replace(/\/$/, "");
    const webhookBase = base.includes("/api/v1/guest/telegram/webhook") ? base : `${base}/api/v1/guest/telegram/webhook`;
    const webhookUrl = `${webhookBase}?access_token=${md5(botToken)}`;
    try {
      await telegramRequest(botToken, "getMe");
      await telegramRequest(botToken, "setWebhook", { url: webhookUrl });
      await telegramRequest(botToken, "setMyCommands", { commands: [{ command: "start", description: "开始使用" }, { command: "bind", description: "绑定账号" }, { command: "traffic", description: "查看流量" }, { command: "getlatesturl", description: "获取订阅链接" }, { command: "unbind", description: "解绑账号" }] });
      return ok({ success: true, webhook_url: webhookUrl, webhook_base_url: webhookBase });
    } catch (error: any) { return fail(error?.message || "Telegram Webhook 设置失败", 400, 400); }
  }
  if (request.method === "GET" && route === "/stat/getOverride") {
    const nodes = await adminServerRows(env);
    const today = dayStart();
    const month = monthStart();
    const lastMonth = monthStart(month - 1);
    const current = now();
    const todayU = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${today} AND record_at < ${current}`);
    const todayD = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${today} AND record_at < ${current}`);
    const monthU = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${month} AND record_at < ${current}`);
    const monthD = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${month} AND record_at < ${current}`);
    const totalU = await firstNumber(env, "SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server");
    const totalD = await firstNumber(env, "SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server");
    return ok({
      month_income: await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${month} AND created_at < ${now()} AND status NOT IN (0,2)`),
      month_register_total: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${month} AND created_at < ${current}`),
      ticket_pending_total: await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_ticket WHERE status = 0"),
      commission_pending_total: await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_order WHERE commission_status = 0 AND invite_user_id IS NOT NULL AND status NOT IN (0,2) AND commission_balance > 0"),
      day_income: await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${today} AND created_at < ${now()} AND status NOT IN (0,2)`),
      last_month_income: await firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${lastMonth} AND created_at < ${month} AND status NOT IN (0,2)`),
      commission_month_payout: await firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${month} AND created_at < ${now()}`),
      commission_last_month_payout: await firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${lastMonth} AND created_at < ${month}`),
      online_nodes: nodes.filter(node => Number((node as any).available_status) > 0).length,
      online_devices: await firstNumber(env, `SELECT COALESCE(SUM(online_count), 0) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >= ${now() - 600}`),
      online_users: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >= ${now() - 600}`),
      today_traffic: { upload: todayU, download: todayD, total: todayU + todayD },
      month_traffic: { upload: monthU, download: monthD, total: monthU + monthD },
      total_traffic: { upload: totalU, download: totalD, total: totalU + totalD }
    });
  }
  if (path.includes("/stat/getStats")) return ok(await adminStats(env));
  if (path.includes("/stat/getOrder")) return ok(await orderStats(env, new URL(request.url)));
  if (path.includes("/stat/getTrafficRank")) return json({ timestamp: new Date().toISOString(), data: await trafficRank(env, new URL(request.url)) });
  if (request.method === "GET" && (route === "/stat/getServerLastRank" || route === "/stat/getServerYesterdayRank")) {
    const start = route.endsWith("YesterdayRank") ? dayStart() - 86400 : 0;
    const end = route.endsWith("YesterdayRank") ? dayStart() : dayStart() + 172800;
    if (await analyticsRangeAvailable(env, start, end)) {
      const aeRows = await analyticsData<Record<string, any>[]>(env, "/internal/traffic/server-rank", { start, end, limit: 100 });
      if (aeRows?.length) {
        const ids = [...new Set(aeRows.map(row => Number(row.server_id)).filter(Boolean))];
        const names = ids.length ? await env.XBOARD_DB.prepare(`SELECT s.id, COALESCE(parent.name, s.name) AS name
          FROM v2_server s LEFT JOIN v2_server parent ON parent.id = s.parent_id
          WHERE s.id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; name: string }>() : { results: [] as { id: number; name: string }[] };
        const byId = new Map((names.results || []).map(row => [Number(row.id), row.name]));
        return ok(aeRows.map(row => ({ server_name: byId.get(Number(row.server_id)) || `Node ${row.server_id}`, server_id: Number(row.server_id), server_type: row.server_type, u: Number(row.u || 0), d: Number(row.d || 0), total: Number(row.total || 0) })));
      }
    }
    const result = await env.XBOARD_DB.prepare(`SELECT s.id AS server_id, COALESCE(parent.name, s.name) AS server_name,
      s.type AS server_type, COALESCE(SUM(stat.u), 0) AS u, COALESCE(SUM(stat.d), 0) AS d
      FROM v2_server s JOIN v2_stat_server stat ON stat.server_id = s.id
      LEFT JOIN v2_server parent ON parent.id = s.parent_id
      WHERE stat.record_at >= ? AND stat.record_at < ? AND stat.record_type = 'd'
      GROUP BY s.id, COALESCE(parent.name, s.name), s.type ORDER BY (COALESCE(SUM(stat.u), 0) + COALESCE(SUM(stat.d), 0)) DESC`)
      .bind(start, end).all<Record<string, any>>();
    return ok((result.results || []).map(row => ({
      server_name: row.server_name, server_id: Number(row.server_id), server_type: row.server_type,
      u: Number(row.u || 0), d: Number(row.d || 0), total: Number(row.u || 0) + Number(row.d || 0)
    })));
  }
  if ((request.method === "GET" || request.method === "POST") && route === "/stat/getStatUser") {
    await materializeCurrentTraffic(env);
    const input: Record<string, any> = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
    if (request.method === "GET") new URL(request.url).searchParams.forEach((value, key) => { input[key] = value; });
    const userId = nullableNumber(input.user_id);
    if (!userId) return fail("user_id 字段是必须的", 422, 422);
    const page = Math.max(1, Number(input.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || input.page_size || 10)));
    const result = await env.XBOARD_DB.prepare(`SELECT user_id, server_rate, record_type, record_at, SUM(u) AS u, SUM(d) AS d, MIN(created_at) AS created_at, MAX(updated_at) AS updated_at
      FROM v2_stat_user WHERE user_id = ? GROUP BY user_id, server_rate, record_type, record_at
      ORDER BY record_at DESC LIMIT ? OFFSET ?`)
      .bind(userId, pageSize, (page - 1) * pageSize).all<Record<string, any>>();
    const totalRow = await env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM v2_stat_user WHERE user_id = ? GROUP BY user_id, server_rate, record_type, record_at
    )`).bind(userId).first<{ count: number }>();
    const data = (result.results || []).map(row => ({ ...row, u: Number(row.u || 0), d: Number(row.d || 0), server_rate: Number(row.server_rate ?? 1) || 1 }));
    return json(paginated(data, Number(totalRow?.count || 0), page, pageSize));
  }
  if (request.method === "GET" && route === "/stat/getRanking") {
    const url = new URL(request.url);
    const type = String(url.searchParams.get("type") || "user_consumption_rank");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const start = Number(url.searchParams.get("start_time") || 0);
    const end = Number(url.searchParams.get("end_time") || now());
    if (type === "server_traffic_rank") {
      if (await analyticsRangeAvailable(env, start, end)) {
        const aeRows = await analyticsData<Record<string, any>[]>(env, "/internal/traffic/server-rank", { start, end, limit });
        if (aeRows?.length) return ok(aeRows);
      }
      const result = await env.XBOARD_DB.prepare(`SELECT server_id, server_type, COALESCE(SUM(u),0) AS u, COALESCE(SUM(d),0) AS d, COALESCE(SUM(u+d),0) AS total FROM v2_stat_server WHERE record_at >= ? AND record_at < ? AND COALESCE(record_type,'d') = 'd' GROUP BY server_id, server_type ORDER BY total DESC LIMIT ?`)
        .bind(start, end, limit).all();
      return ok(result.results || []);
    }
    if (type === "invite_rank") {
      const result = await env.XBOARD_DB.prepare(`SELECT invited.invite_user_id, COUNT(*) AS count, inviter.email FROM v2_user invited LEFT JOIN v2_user inviter ON inviter.id = invited.invite_user_id WHERE invited.created_at >= ? AND invited.created_at < ? AND invited.invite_user_id IS NOT NULL GROUP BY invited.invite_user_id, inviter.email ORDER BY count DESC LIMIT ?`)
        .bind(start, end, limit).all();
      return ok(result.results || []);
    }
    if (type !== "user_consumption_rank") return fail("统计类型无效", 422, 422);
    if (await analyticsRangeAvailable(env, start, end)) {
      const aeRows = await analyticsData<Record<string, any>[]>(env, "/internal/traffic/rank", { start, end, limit });
      if (aeRows?.length) {
        const ids = aeRows.map(row => Number(row.user_id)).filter(Boolean);
        const users = ids.length ? await env.XBOARD_DB.prepare(`SELECT id, email FROM v2_user WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; email: string }>() : { results: [] as { id: number; email: string }[] };
        const emails = new Map((users.results || []).map(row => [Number(row.id), row.email]));
        return ok(aeRows.map(row => ({ ...row, email: emails.get(Number(row.user_id)) || null })));
      }
    }
    const result = await env.XBOARD_DB.prepare(`SELECT su.user_id, u.email, COALESCE(SUM(su.u),0) AS u, COALESCE(SUM(su.d),0) AS d, COALESCE(SUM(su.u+su.d),0) AS total FROM v2_stat_user su LEFT JOIN v2_user u ON u.id = su.user_id WHERE su.record_at >= ? AND su.record_at < ? AND COALESCE(su.record_type,'d') = 'd' GROUP BY su.user_id, u.email ORDER BY total DESC LIMIT ?`)
      .bind(start, end, limit).all();
    return ok(result.results || []);
  }
  if (request.method === "GET" && route === "/knowledge/getCategory") {
    const result = await env.XBOARD_DB.prepare("SELECT DISTINCT category FROM v2_knowledge WHERE category IS NOT NULL AND category != '' ORDER BY category").all<{ category: string }>();
    return ok((result.results || []).map(row => row.category));
  }
  if (request.method === "GET" && route === "/stat/getStatRecord") {
    const url = new URL(request.url);
    const type = String(url.searchParams.get("type") || "register_count");
    if (!["paid_total", "commission_total", "register_count"].includes(type)) return fail("统计类型无效", 422, 422);
    const start = Number(url.searchParams.get("start_time") || 0);
    const end = Number(url.searchParams.get("end_time") || now());
    if (end >= dayStart()) await materializeCurrentTraffic(env);
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_stat WHERE record_at >= ? AND record_at < ? ORDER BY record_at ASC LIMIT 1000").bind(start, end).all<Record<string, any>>();
    return ok((result.results || []).map(row => ({ ...row, ...(type === "paid_total" ? { paid_total: Number(row.paid_total || 0) / 100 } : {}), ...(type === "commission_total" ? { commission_total: Number(row.commission_total || 0) / 100 } : {}) })));
  }
  if (path.includes("/payment/getPaymentMethods")) return ok([]);
  if (path.includes("/payment/getPaymentForm")) return ok({ enabled: false, message: "Payment features are disabled in this build." });
  if (path.match(/\/payment\/(save|drop|show|sort)/)) return ok(true);
  if (request.method === "GET" && route === "/mail/template/list") return ok(await adminMailTemplateList(env));
  if (request.method === "GET" && route === "/mail/template/get") {
    const template = await adminMailTemplateGet(env, new URL(request.url).searchParams.get("name") || "");
    return template ? ok(template) : fail("模板不存在", 404, 404);
  }
  if (request.method === "POST" && route === "/mail/template/save") {
    const input = await body<Record<string, any>>(request);
    const name = canonicalMailTemplateName(String(input.name || ""));
    if (!mailTemplateMeta[name] || !input.subject || !input.content) return fail("模板参数不正确", 422, 422);
    const missing = mailTemplateMeta[name].required_vars.filter(variable => !String(input.content).includes(`{{${variable}}}`));
    if (missing.length) return fail(missing.map(variable => `缺少必要占位符: {{${variable}}}`).join("; "), 422, 422);
    const ts = now();
    await env.XBOARD_DB.prepare("INSERT INTO v2_mail_templates(name, subject, content, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, content = excluded.content, enabled = 1, updated_at = excluded.updated_at")
      .bind(name, String(input.subject), String(input.content), ts, ts).run();
    return ok(true);
  }
  if (request.method === "POST" && route === "/mail/template/reset") {
    const input = await body<Record<string, any>>(request);
    const name = canonicalMailTemplateName(String(input.name || ""));
    if (!mailTemplateMeta[name]) return fail("模板不存在", 404, 404);
    await env.XBOARD_DB.prepare("DELETE FROM v2_mail_templates WHERE name IN (?, ?)").bind(name, legacyMailTemplateName(name)).run();
    return ok(true);
  }
  if (request.method === "POST" && route === "/mail/template/test") {
    const input = await body<Record<string, any>>(request);
    const name = canonicalMailTemplateName(String(input.name || ""));
    if (!mailTemplateMeta[name]) return fail("模板不存在", 404, 404);
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const appUrl = String(pickSetting(all, "app_url", "https://example.com"));
    const vars = { name: pickSetting(all, "app_name", "XBoard"), code: "123456", content: "This is xboard test email", link: `${appUrl.replace(/\/$/, "")}/login?token=test-token`, url: appUrl };
    await queueTemplateMail(env, name, String(input.email || (admin as any).email), vars, `XBoard ${mailTemplateMeta[name].label}测试`);
    return ok(true);
  }
  if (path.includes("/system/getSystemStatus")) {
    const lastRun = await optionalKvGet(env, "schedule:last_check_at");
    return ok({ schedule: !!lastRun && now() - Number(lastRun) < 600, horizon: true, schedule_last_runtime: lastRun ? Number(lastRun) : null });
  }
  if (path.includes("/system/getQueueStats")) {
    const stats = await cachedData("queue-stats", 60, async () => {
      const current = now();
      const cutoff = current - 10080 * 60;
      const [workerFailed, legacyFailed, recent] = await Promise.all([
        env.XBOARD_DB.prepare("SELECT COUNT(*) AS count FROM v2_job_logs WHERE status = 'failed' AND COALESCE(updated_at, created_at) >= ?")
          .bind(cutoff).first<{ count: number }>(),
        env.XBOARD_DB.prepare("SELECT COUNT(*) AS count FROM failed_jobs WHERE failed_at >= ?")
          .bind(cutoff).first<{ count: number }>(),
        env.XBOARD_DB.prepare(`SELECT COALESCE(SUM(count), 0) AS count FROM (
          SELECT COUNT(*) AS count FROM v2_job_logs WHERE status = 'done' AND updated_at >= ?
          UNION ALL
          SELECT COUNT(*) AS count FROM v2_job_logs WHERE status = 'failed' AND updated_at >= ?
        )`).bind(current - 60 * 60, current - 60 * 60).first<{ count: number }>()
      ]);
      const failedJobs = Number(workerFailed?.count || 0) + Number(legacyFailed?.count || 0);
      const recentJobs = Number(recent?.count || 0);
      return { failedJobs, jobsPerMinute: 0, pausedMasters: 0, periods: { failedJobs: 10080, recentJobs: 60 }, processes: 1, queueWithMaxRuntime: null, queueWithMaxThroughput: null, recentJobs, status: true, wait: { "cloudflare-queues:default": 0 } };
    });
    return ok(stats);
  }
  if (path.includes("/system/getQueueWorkload")) {
    const result = await env.XBOARD_DB.prepare("SELECT type AS name, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS length FROM v2_job_logs GROUP BY type ORDER BY type").all<Record<string, any>>();
    return ok((result.results || []).map(row => ({ name: row.name, length: Number(row.length || 0), wait: 0, processes: 1, split_queues: [String(row.name)] })));
  }
  if (path.includes("/system/getQueueMasters")) return ok([{ name: "xboard-jobs", status: "running", environment: "cloudflare-queues" }]);
  if (request.method === "GET" && route === "/system/getHorizonFailedJobs") {
    const url = new URL(request.url);
    const current = Math.max(1, Math.trunc(Number(url.searchParams.get("current") || 1)) || 1);
    const pageSize = Math.min(100, Math.max(10, Math.trunc(Number(url.searchParams.get("page_size") || 20)) || 20));
    const cutoff = now() - 10080 * 60;
    const offset = (current - 1) * pageSize;
    const [result, total] = await Promise.all([
      env.XBOARD_DB.prepare(`SELECT id, connection, queue, payload, exception, failed_at FROM (
        SELECT 'legacy:' || id AS id, connection, queue, payload, exception, failed_at FROM failed_jobs WHERE failed_at >= ?
        UNION ALL
        SELECT event_id AS id, 'cloudflare' AS connection, type AS queue, COALESCE(payload, '') AS payload,
          COALESCE(error, '') AS exception, COALESCE(updated_at, created_at) AS failed_at
        FROM v2_job_logs WHERE status = 'failed' AND COALESCE(updated_at, created_at) >= ?
      ) ORDER BY failed_at DESC LIMIT ? OFFSET ?`).bind(cutoff, cutoff, pageSize, offset).all(),
      env.XBOARD_DB.prepare(`SELECT
        (SELECT COUNT(*) FROM failed_jobs WHERE failed_at >= ?) +
        (SELECT COUNT(*) FROM v2_job_logs WHERE status = 'failed' AND COALESCE(updated_at, created_at) >= ?) AS count`)
        .bind(cutoff, cutoff).first<{ count: number }>()
    ]);
    return json({ data: result.results || [], total: Number(total?.count || 0), current, page_size: pageSize });
  }
  if ((request.method === "GET" || request.method === "POST") && route === "/system/getAuditLog") return json(await adminAuditLogs(env, request));
  if (path.includes("/server/manage/save")) return saveServer(request, env);
  if (path.includes("/server/manage/update")) return updateServer(request, env);
  if (path.includes("/server/manage/sort")) return sortServers(request, env);
  if (path.includes("/server/manage/drop")) {
    const input = await body<Record<string, any>>(request.clone());
    const id = nullableNumber(input.id);
    if (!id) return fail("服务器不存在", 400, 400202);
    const result = await env.XBOARD_DB.prepare("DELETE FROM v2_server WHERE id = ?").bind(id).run();
    if (Number((result.meta as any)?.changes || 0) !== 1) return fail("服务器不存在", 400, 400202);
    await clearStatus(env, "node", id);
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  if (path.includes("/server/manage/batchDelete")) {
    const input = await body<Record<string, any>>(request.clone());
    const ids = parseJsonArray(input.ids);
    for (const id of ids) {
      await env.XBOARD_DB.prepare("DELETE FROM v2_server WHERE id = ?").bind(Number(id)).run();
      await clearStatus(env, "node", Number(id));
    }
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  if (path.includes("/server/manage/batchUpdate")) return batchUpdateServers(request, env);
  if (path.includes("/server/manage/resetTraffic")) {
    const input = await body<Record<string, any>>(request.clone());
    if (input.id) await env.XBOARD_DB.prepare("UPDATE v2_server SET u = 0, d = 0, updated_at = ? WHERE id = ?").bind(now(), input.id).run();
    return ok(true);
  }
  if (path.includes("/server/manage/batchResetTraffic")) {
    const input = await body<Record<string, any>>(request.clone());
    for (const id of parseJsonArray(input.ids)) await env.XBOARD_DB.prepare("UPDATE v2_server SET u = 0, d = 0, updated_at = ? WHERE id = ?").bind(now(), Number(id)).run();
    return ok(true);
  }
  if (path.includes("/server/manage/copy")) return copyServer(request, env);
  if (path.includes("/server/machine/save")) return saveMachine(request, env);
  if (path.includes("/server/machine/nodes")) {
    const machineUrl = new URL(request.url);
    const machineId = Number(machineUrl.searchParams.get("machine_id") || machineUrl.searchParams.get("id") || 0);
    const result = machineId
      ? await env.XBOARD_DB.prepare("SELECT id, name, type, host, port, show, enabled, sort FROM v2_server WHERE machine_id = ? ORDER BY sort ASC, id ASC").bind(machineId).all<Record<string, any>>()
      : { results: [] as Record<string, any>[] };
    const data = result.results || [];
    return ok(data);
  }
  if (path.includes("/server/machine/history")) return adminMachineHistory(env, new URL(request.url));
  if (path.includes("/server/machine/getToken")) {
    const id = nullableNumber(new URL(request.url).searchParams.get("id"));
    if (!id) return fail("id 字段是必须的", 422, 422);
    const machine = await env.XBOARD_DB.prepare("SELECT token FROM v2_server_machine WHERE id = ?").bind(id).first<{ token: string }>();
    return machine ? ok({ token: machine.token }) : fail("服务器不存在", 404, 400202);
  }
  if (path.includes("/server/machine/installCommand")) {
    const id = nullableNumber(new URL(request.url).searchParams.get("id"));
    if (!id) return fail("id 字段是必须的", 422, 422);
    const machine = await env.XBOARD_DB.prepare("SELECT token FROM v2_server_machine WHERE id = ?").bind(id).first<{ token: string }>();
    return machine ? ok({ command: await machineInstallCommand(request, env, machine.token, id) }) : fail("服务器不存在", 404, 400202);
  }
  if (path.includes("/server/machine/resetToken")) {
    const input = await body<Record<string, any>>(request.clone());
    const machineToken = randomString(32);
    const result = await env.XBOARD_DB.prepare("UPDATE v2_server_machine SET token = ?, updated_at = ? WHERE id = ?").bind(machineToken, now(), input.id).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok({ token: machineToken }) : fail("服务器不存在", 422, 422);
  }
  if (path.includes("/server/manage/generateEchKey")) {
    const publicName = new URL(request.url).searchParams.get("public_name") || "ech.example.com";
    const generated = await generateEch(publicName);
    return generated ? ok(generated) : fail("public_name must be a valid domain (1-253 bytes)", 422, 422);
  }
  if (path.includes("/user/getSubscribe")) {
    const id = nullableNumber(new URL(request.url).searchParams.get("id"));
    if (!id) return fail("id 字段是必须的", 422, 422);
    const target = await env.XBOARD_DB.prepare("SELECT token FROM v2_user WHERE id = ?").bind(id).first<{ token: string }>();
    return target ? ok({ subscribe_url: await subscribeUrl(request, env, target.token), token: target.token }) : fail("用户不存在", 404, 400202);
  }
  if (request.method === "GET" && route === "/user/getUserInfoById") {
    const id = nullableNumber(new URL(request.url).searchParams.get("id"));
    if (!id) return fail("用户ID不能为空", 422, 422);
    const target = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(id).first<Record<string, any>>();
    if (!target) return fail("用户不存在", 404, 400202);
    const inviteUser = target.invite_user_id ? await env.XBOARD_DB.prepare("SELECT id, email FROM v2_user WHERE id = ?").bind(target.invite_user_id).first() : null;
    return ok({ ...safeUser(target), balance: Number(target.balance || 0) / 100, commission_balance: Number(target.commission_balance || 0) / 100, invite_user: inviteUser });
  }
  if (path.includes("/user/resetSecret")) {
    const input = await body<Record<string, any>>(request.clone());
    const newToken = token(16);
    const newUuid = uuid();
    await env.XBOARD_DB.prepare("UPDATE v2_user SET token = ?, uuid = ?, updated_at = ? WHERE id = ?").bind(newToken, newUuid, now(), input.id).run();
    await bump(env.XBOARD_KV, `user_version:${input.id}`);
    await bump(env.XBOARD_KV, `user_version:${newToken}`);
    return ok(true);
  }
  if (path.includes("/user/ban")) {
    const input = await body<Record<string, any>>(request.clone());
    const ids = parseJsonArray(input.user_ids || input.ids || input.id);
    const scope = String(input.scope || (ids.length ? "selected" : parseJsonArray(input.filter).length ? "filtered" : "all"));
    if (scope === "selected" && ids.length) {
      for (const id of ids) {
        await env.XBOARD_DB.prepare("UPDATE v2_user SET banned = 1, updated_at = ? WHERE id = ?").bind(now(), Number(id)).run();
        await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ?").bind(Number(id)).run();
      }
    } else if (scope === "filtered") {
      const query = adminUserQuery(input);
      if (!query.where) return fail("筛选条件不能为空", 422, 422);
      const matched = await env.XBOARD_DB.prepare(`SELECT u.id FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id LEFT JOIN v2_server_group g ON g.id = u.group_id LEFT JOIN v2_user iu ON iu.id = u.invite_user_id${query.where}`).bind(...query.bindings).all<{ id: number }>();
      const matchedIds = (matched.results || []).map(row => Number(row.id)).filter(Boolean);
      for (let offset = 0; offset < matchedIds.length; offset += 80) {
        const chunk = matchedIds.slice(offset, offset + 80);
        await env.XBOARD_DB.batch([
          env.XBOARD_DB.prepare(`UPDATE v2_user SET banned = 1, updated_at = ? WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(now(), ...chunk),
          env.XBOARD_DB.prepare(`DELETE FROM personal_access_tokens WHERE tokenable_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk)
        ]);
      }
    } else if (scope === "all") {
      await env.XBOARD_DB.prepare("UPDATE v2_user SET banned = 1, updated_at = ?").bind(now()).run();
      await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id IN (SELECT id FROM v2_user WHERE banned = 1)").run();
    } else {
      return fail("user_ids不能为空", 422, 422);
    }
    return ok(true);
  }
  if (path.includes("/user/destroy")) {
    const input = await body<Record<string, any>>(request.clone());
    const id = nullableNumber(input.id);
    if (!id) return fail("用户ID不能为空", 422, 422);
    const target = await env.XBOARD_DB.prepare("SELECT is_admin FROM v2_user WHERE id = ?").bind(id).first<{ is_admin: number }>();
    if (!target) return fail("用户不存在", 400, 400202);
    if (Number(target.is_admin)) return fail("不能删除管理员账号", 400, 400);
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("DELETE FROM v2_ticket_message WHERE ticket_id IN (SELECT id FROM v2_ticket WHERE user_id = ?)").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_ticket WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_stat_user WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_order WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_invite_code WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ?").bind(id),
      env.XBOARD_DB.prepare("UPDATE v2_user SET invite_user_id = NULL WHERE invite_user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_user WHERE id = ?").bind(id)
    ]);
    return ok(true);
  }
  if (request.method === "POST" && route === "/user/update") {
    const input = await body<Record<string, any>>(request); const id = nullableNumber(input.id);
    if (!id) return fail("用户ID不能为空", 422, 422);
    const existing = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(id).first<Record<string, any>>();
    if (!existing) return fail("用户不存在", 400, 400202);
    const allowedKeys = ["email", "password", "transfer_enable", "expired_at", "banned", "plan_id", "commission_rate", "discount", "is_admin", "is_staff", "u", "d", "balance", "commission_type", "commission_balance", "remarks", "speed_limit", "device_limit"];
    const values: Record<string, any> = {};
    for (const key of allowedKeys) if (input[key] !== undefined) values[key] = input[key];
    const numericKeys = ["transfer_enable", "u", "d", "balance", "commission_balance", "commission_rate", "discount", "speed_limit", "device_limit", "plan_id", "expired_at"];
    for (const key of numericKeys) {
      const value = values[key];
      if (value !== undefined && value !== null && value !== "" && !Number.isFinite(Number(value))) return fail(`${key} 必须是数字`, 422, 422);
    }
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email))) return fail("邮箱格式不正确", 422, 422);
    if (values.email) {
      const duplicate = await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE email = ? AND id != ?").bind(String(values.email).trim().toLowerCase(), id).first();
      if (duplicate) return fail("邮箱已被使用", 400, 400201);
      values.email = String(values.email).trim().toLowerCase();
    }
    if (values.password) {
      if (String(values.password).length < 8) return fail("密码长度最小8位", 422, 422);
      values.password = await hashPassword(String(values.password));
      values.password_algo = "bcrypt";
      values.password_salt = null;
    }
    if (values.balance !== undefined) values.balance = Math.round(Number(values.balance) * 100);
    if (values.commission_balance !== undefined) values.commission_balance = Math.round(Number(values.commission_balance) * 100);
    for (const key of ["banned", "is_admin", "is_staff"]) if (values[key] !== undefined) values[key] = boolNumber(values[key]);
    for (const key of ["commission_rate", "discount"]) if (values[key] !== undefined && values[key] !== null && (Number(values[key]) < 0 || Number(values[key]) > 100)) return fail(`${key} 必须在0到100之间`, 422, 422);
    if (values.plan_id) {
      const plan = await env.XBOARD_DB.prepare("SELECT group_id FROM v2_plan WHERE id = ?").bind(Number(values.plan_id)).first<{ group_id: number }>();
      if (!plan) return fail("订阅计划不存在", 400, 400202);
      values.group_id = plan.group_id;
    } else if (values.plan_id === null || values.plan_id === "") { values.plan_id = null; }
    if (Object.prototype.hasOwnProperty.call(input, "invite_user_email")) {
      const inviteEmail = String(input.invite_user_email || "").trim().toLowerCase();
      const invite = inviteEmail ? await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE email = ?").bind(inviteEmail).first<{ id: number }>() : null;
      if (inviteEmail && !invite) return fail("邀请用户不存在", 400, 400202);
      values.invite_user_id = invite?.id ?? null;
    }
    const entries = Object.entries(values);
    if (entries.length) await env.XBOARD_DB.prepare(`UPDATE v2_user SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...entries.map(([, value]) => bindValue(value)), now(), id).run();
    if (Number(values.banned)) await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ?").bind(id).run();
    await bump(env.XBOARD_KV, `user_version:${id}`);
    return ok(true);
  }
  if (request.method === "POST" && route === "/user/setInviteUser") {
    const input = await body<Record<string, any>>(request);
    const id = nullableNumber(input.id || input.user_id);
    if (!id) return fail("用户不存在", 422, 400202);
    const invite = input.invite_user_email
      ? await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE email = ?").bind(String(input.invite_user_email)).first<{ id: number }>()
      : input.invite_user_id ? { id: Number(input.invite_user_id) } : null;
    if ((input.invite_user_email || input.invite_user_id) && !invite) return fail("邀请用户不存在", 400, 400202);
    if (invite && Number(invite.id) === id) return fail("不能将自己设为邀请人", 422, 422);
    await env.XBOARD_DB.prepare("UPDATE v2_user SET invite_user_id = ?, updated_at = ? WHERE id = ?").bind(invite?.id || null, now(), id).run();
    return ok(true);
  }
  if (path.includes("/user/generate")) return generateAdminUsers(request, env);
  if (path.includes("/user/sendMail")) {
    const input = await body<Record<string, any>>(request);
    const subject = String(input.subject || "");
    const content = String(input.content || "");
    if (!subject || !content) return fail("邮件主题和内容不能为空", 422, 422);
    const scope = String(input.scope || (input.user_ids || input.ids ? "selected" : "all"));
    const ids = parseJsonArray(input.user_ids || input.ids).map(Number).filter(Boolean);
    if (scope === "selected" && !ids.length) return fail("user_ids不能为空", 422, 422);
    const filtered = scope === "filtered" ? adminUserQuery(input) : null;
    const users = scope === "selected"
      ? await env.XBOARD_DB.prepare(`SELECT u.*, p.name AS plan_name FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id WHERE u.id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Record<string, any>>()
      : filtered
        ? await env.XBOARD_DB.prepare(`SELECT u.*, p.name AS plan_name FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id LEFT JOIN v2_server_group g ON g.id = u.group_id LEFT JOIN v2_user iu ON iu.id = u.invite_user_id${filtered.where} ORDER BY ${filtered.order}`).bind(...filtered.bindings).all<Record<string, any>>()
        : await env.XBOARD_DB.prepare("SELECT u.*, p.name AS plan_name FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id ORDER BY u.id DESC").all<Record<string, any>>();
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    for (const recipient of users.results || []) {
      const vars = {
        "app.name": pickSetting(all, "app_name", "XBoard"), "app.url": pickSetting(all, "app_url", ""),
        name: pickSetting(all, "app_name", "XBoard"), url: pickSetting(all, "app_url", ""), content,
        "user.id": recipient.id, "user.email": recipient.email, "user.uuid": recipient.uuid,
        "user.plan_name": recipient.plan_name || "", "user.expired_at": recipient.expired_at || "",
        "user.transfer_enable": Number(recipient.transfer_enable || 0), "user.transfer_used": Number(recipient.u || 0) + Number(recipient.d || 0),
        "user.transfer_left": Number(recipient.transfer_enable || 0) - Number(recipient.u || 0) - Number(recipient.d || 0)
      };
      await queueTemplateMail(env, "notify", String(recipient.email), vars, renderMailText(subject, vars));
    }
    return ok(true);
  }
  if (path.includes("/user/dumpCSV")) return dumpAdminUsers(request, env);
  if (request.method === "GET" && route === "/traffic-reset/logs") {
    const result = await trafficResetLogs(env, request);
    return result instanceof Response ? result : json(result);
  }
  if (request.method === "GET" && route === "/traffic-reset/stats") {
    const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get("days") || 30)));
    const since = now() - days * 86400;
    const total = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_traffic_reset_logs WHERE reset_time >= ${since}`);
    const manual = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_traffic_reset_logs WHERE reset_time >= ${since} AND trigger_source = 'manual'`);
    const cron = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_traffic_reset_logs WHERE reset_time >= ${since} AND trigger_source = 'cron'`);
    const auto = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_traffic_reset_logs WHERE reset_time >= ${since} AND trigger_source = 'auto'`);
    return json({ data: { total_resets: total, auto_resets: auto, manual_resets: manual, cron_resets: cron } });
  }
  if (request.method === "POST" && route === "/traffic-reset/reset-user") return resetUserTraffic(env, request, Number((admin as any).id));
  const historyMatch = route.match(/^\/traffic-reset\/user\/(\d+)\/history$/);
  if (request.method === "GET" && historyMatch) {
    const userId = Number(historyMatch[1]);
    const user = await env.XBOARD_DB.prepare("SELECT id, email, reset_count, last_reset_at, next_reset_at FROM v2_user WHERE id = ?").bind(userId).first();
    if (!user) return fail("用户不存在", 404, 404);
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_traffic_reset_logs WHERE user_id = ? ORDER BY reset_time DESC LIMIT ?").bind(userId, Math.min(50, Number(new URL(request.url).searchParams.get("limit") || 10))).all<Record<string, any>>();
    return json({ data: { user, history: (result.results || []).map(row => trafficResetResource(row, request)) } });
  }
  for (const [suffix, table] of Object.entries(directFetchTables)) {
    if (path.includes(suffix)) {
      if (suffix === "/server/group/fetch") return ok(await adminServerGroupRows(env));
      if (suffix === "/server/manage/getNodes") return ok(await adminServerRows(env));
      if (suffix === "/server/machine/fetch") return ok(await adminMachineRows(env));
      if (suffix === "/server/route/fetch") return ok(await adminRouteRows(env));
      if (suffix === "/plan/fetch") return ok(await adminPlanRows(env));
      if (suffix === "/notice/fetch") {
        const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_notice ORDER BY sort ASC, id DESC").all<Record<string, any>>();
        return ok((result.results || []).map(row => ({ ...row, tags: parseJsonArray(row.tags), show: Boolean(Number(row.show)), popup: Boolean(Number(row.popup)) })));
      }
      if (suffix === "/knowledge/fetch") {
        const requestedId = nullableNumber(new URL(request.url).searchParams.get("id"));
        if (requestedId) {
          const value = await env.XBOARD_DB.prepare("SELECT * FROM v2_knowledge WHERE id = ?").bind(requestedId).first<Record<string, any>>();
          return value ? ok(value) : fail("知识不存在", 400, 400202);
        }
        const result = await env.XBOARD_DB.prepare("SELECT title,id,updated_at,category,show FROM v2_knowledge ORDER BY sort ASC").all<Record<string, any>>();
        return ok((result.results || []).map(row => ({ ...row, show: Boolean(Number(row.show)) })));
      }
      return ok(await rows(env.XBOARD_DB, table, 1000));
    }
  }
  for (const [suffix, table] of Object.entries(pagedFetchTables)) {
    if (path.includes(suffix)) {
      if (suffix === "/user/fetch") return json(await adminUserList(env, request));
      const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
      const url = new URL(request.url);
      const page = Number(input.page || input.current || url.searchParams.get("page") || 1);
      const pageSize = Number(input.page_size || input.pageSize || input.limit || url.searchParams.get("page_size") || 20);
      return json(await list(env.XBOARD_DB, table, page, pageSize));
    }
  }
  if (path.match(/coupon|commission|gift-card/)) return json({ data: [], total: 0, current_page: 1, per_page: 20 });
  const table = adminTableForPath(path);
  if (table) {
    const url = new URL(request.url);
    if (path.endsWith("/fetch") || path.endsWith("/list") || (request.method === "GET" && !path.match(/\/\d+$/))) return ok(await rows(env.XBOARD_DB, table, 1000));
    const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
    const id = path.match(/\/(\d+)(?:\/|$)/)?.[1] || url.searchParams.get("id") || String(input.id || "") || undefined;
    if ((request.method === "DELETE" || path.endsWith("/drop")) && id) {
      await env.XBOARD_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
      return ok(true);
    }
    if (path.endsWith("/show") && id) return ok(await env.XBOARD_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first());
    return createOrUpdate(table, request, env, id);
  }
  return json({ message: "Not Found" }, 404);
  })();
  if (!route.startsWith("/migration/")) await audit(env, Number((admin as any).id || 0), auditRequest, path);
  return response;
}

async function userApi(request: Request, env: Env, path: string) {
  if (request.method === "GET" && path.includes("/passport/auth/token2Login")) {
    const url = new URL(request.url); const directToken = url.searchParams.get("token"); const verify = url.searchParams.get("verify");
    if (directToken) {
      const all = await settings(env.XBOARD_DB, env.XBOARD_KV); const base = String(pickSetting(all, "app_url", "") || url.origin).replace(/\/$/, "");
      return Response.redirect(`${base}/#/login?verify=${encodeURIComponent(directToken)}&redirect=${encodeURIComponent(url.searchParams.get("redirect") || "dashboard")}`, 302);
    }
    if (verify) {
      const userId = Number(await optionalKvGet(env, `quick_login:${verify}`) || 0);
      if (!userId) return json({ message: "Token error" }, 400);
      const target = await env.XBOARD_DB.prepare("SELECT id,email,is_admin,banned FROM v2_user WHERE id=?").bind(userId).first<Record<string, any>>();
      if (!target || Number(target.banned)) return json({ message: "User not found" }, 400);
      try { await env.XBOARD_KV.delete(`quick_login:${verify}`); } catch {}
      const accessToken = await createSession(env.XBOARD_DB, env.XBOARD_KV, target as any, false);
      const fullUser = await env.XBOARD_DB.prepare("SELECT token FROM v2_user WHERE id = ?").bind(userId).first<{ token: string }>();
      return ok({ token: fullUser?.token || "", is_admin: !!target.is_admin, email: target.email, auth_data: `Bearer ${accessToken}` });
    }
    return json({ message: "Invalid request" }, 400);
  }
  if (request.method === "POST" && path.includes("/passport/auth/getQuickLoginUrl")) {
    const input = await body<Record<string, any>>(request.clone());
    const authData = String(input.auth_data || request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const authRequest = new Request(request.url, { headers: { authorization: `Bearer ${authData}` } });
    const target = await currentUser(authRequest, env.XBOARD_DB, env.XBOARD_KV, false);
    if (!target) return json({ message: "Unauthorized or expired" }, 401);
    const verify = randomString(32); await optionalKvPutTtl(env, `quick_login:${verify}`, String((target as any).id), 60);
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV); const base = String(pickSetting(all, "app_url", "") || new URL(request.url).origin).replace(/\/$/, "");
    return ok(`${base}/#/login?verify=${verify}&redirect=${encodeURIComponent(String(input.redirect || "dashboard"))}`);
  }
  if (request.method === "POST" && path.includes("/passport/auth/loginWithMailLink")) {
    const input = await body<Record<string, any>>(request);
    const email = String(input.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Email format is incorrect", 422, 422);
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    if (!Number(pickSetting(all, "login_with_mail_link_enable", 0))) return fail("Not Found", 404, 404);
    if (await optionalKvGet(env, `mail_login:last:${email}`)) return fail("Sending frequently, please try again later", 429, 429);
    const target = await env.XBOARD_DB.prepare("SELECT id,email FROM v2_user WHERE email = ?").bind(email).first<Record<string, any>>();
    if (!target) return ok(true);
    const verify = randomString(32);
    await optionalKvPutTtl(env, `quick_login:${verify}`, String(target.id), 300);
    await optionalKvPutTtl(env, `mail_login:last:${email}`, String(now()), 60);
    const base = String(pickSetting(all, "app_url", "") || new URL(request.url).origin).replace(/\/$/, "");
    const link = `${base}/#/login?verify=${verify}&redirect=${encodeURIComponent(String(input.redirect || "dashboard"))}`;
    await queueTemplateMail(env, "mailLogin", email, { name: pickSetting(all, "app_name", "XBoard"), link, url: pickSetting(all, "app_url", "") });
    return ok(true);
  }
  if (request.method === "POST" && path.includes("/passport/comm/pv")) {
    const input = await body<Record<string, any>>(request);
    const inviteCode = String(input.invite_code || "");
    if (inviteCode) await env.XBOARD_DB.prepare("UPDATE v2_invite_code SET pv = pv + 1, updated_at = ? WHERE code = ?").bind(now(), inviteCode).run();
    return ok(true);
  }
  if (request.method === "POST" && path.includes("/passport/comm/sendEmailVerify")) {
    const input = await body<Record<string, any>>(request);
    const email = String(input.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Email format is incorrect", 422, 422);
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    if (!(await verifyCaptcha(request, input, all))) return fail("Invalid code is incorrect", 400, 400);
    if (pickSetting(all, "email_whitelist_enable", 0)) {
      const registered = await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE email = ?").bind(email).first();
      const suffixes = pickSetting(all, "email_whitelist_suffix", []);
      if (!registered && Array.isArray(suffixes) && !suffixes.includes(email.split("@").pop())) return fail("Email suffix is not in whitelist", 400, 400);
    }
    if (await optionalKvGet(env, `verify:last:${email}`)) return fail("Email verification code has been sent, please request again later", 400, 400);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
    const vars = { name: pickSetting(all, "app_name", "XBoard"), code, url: pickSetting(all, "app_url", "") };
    await queueTemplateMail(env, "verify", email, vars, `${vars.name} Email verification code`);
    await optionalKvPutTtl(env, `verify:email:${email}`, code, 300);
    await optionalKvPutTtl(env, `verify:last:${email}`, String(now()), 60);
    return ok(true);
  }
  if (request.method === "POST" && path.includes("/passport/auth/forget")) {
    const input = await body<Record<string, any>>(request);
    const email = String(input.email || "").trim().toLowerCase();
    const limitKey = `forget_limit:${email}`;
    const attempts = Number(await optionalKvGet(env, limitKey) || 0);
    if (attempts >= 3) return fail("Sending frequently, please try again later", 429, 429);
    const expected = await optionalKvGet(env, `verify:email:${email}`);
    if (!expected || !constantTimeEqual(expected, input.email_code)) {
      await optionalKvPutTtl(env, limitKey, String(attempts + 1), 300);
      return fail("Email verification code is incorrect", 400, 400);
    }
    if (!String(input.password || "")) return fail("Password can not be empty", 422, 422);
    if (String(input.password).length < 8) return fail("Password must be greater than 8 digits", 422, 422);
    const password = await hashPassword(String(input.password));
    const result = await env.XBOARD_DB.prepare("UPDATE v2_user SET password = ?, password_algo = 'bcrypt', password_salt = NULL, updated_at = ? WHERE email = ?").bind(password, now(), email).run();
    if (!Number((result.meta as any)?.changes || 0)) return fail("User does not exist", 400, 400);
    try { await env.XBOARD_KV.delete(`verify:email:${email}`); } catch {}
    try { await env.XBOARD_KV.delete(limitKey); } catch {}
    return ok(true);
  }
  if (path.includes("/passport/auth/login")) return login(request, env, false);
  if (request.method === "POST" && path.includes("/passport/auth/register")) return registerUser(request, env);
  const user = await currentUser(request, env.XBOARD_DB, env.XBOARD_KV, false);
  if (!user) return fail("未授权", 401, 401);
  const route = path.replace(/^\/api\/v[12]\/user/, "");
  const giftCardResponse = await handleUserGiftCard(request.clone(), env.XBOARD_DB, route, user as Record<string, any>);
  if (giftCardResponse) return giftCardResponse;
  if (request.method === "GET" && route === "/getActiveSession") {
    const result = await env.XBOARD_DB.prepare("SELECT id, name, abilities, last_used_at, expires_at, created_at, updated_at FROM personal_access_tokens WHERE tokenable_id = ? ORDER BY id DESC").bind((user as any).id).all();
    return ok(result.results || []);
  }
  if (request.method === "POST" && route === "/removeActiveSession") {
    const input = await body<Record<string, any>>(request);
    await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE id = ? AND tokenable_id = ?").bind(input.session_id, (user as any).id).run();
    return ok(true);
  }
  if (request.method === "GET" && route === "/invite/save") {
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const limit = Number(pickSetting(all, "invite_gen_limit", 5));
    const count = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_invite_code WHERE user_id = ${Number((user as any).id)} AND status = 0`);
    if (count >= limit) return fail("已达到最大创建数量", 400, 400);
    const ts = now();
    await env.XBOARD_DB.prepare("INSERT INTO v2_invite_code(user_id, code, status, pv, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)").bind((user as any).id, randomString(8), ts, ts).run();
    return ok(true);
  }
  if (request.method === "GET" && route === "/invite/fetch") {
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const codes = await env.XBOARD_DB.prepare("SELECT id, code, status, pv, created_at, updated_at FROM v2_invite_code WHERE user_id = ? AND status = 0 ORDER BY id DESC").bind((user as any).id).all();
    const invited = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE invite_user_id = ${Number((user as any).id)}`);
    const commission = await firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE invite_user_id = ${Number((user as any).id)}`);
    let pendingCommission = await firstNumber(env, `SELECT COALESCE(SUM(commission_balance), 0) AS c FROM v2_order WHERE status = 3 AND commission_status = 0 AND invite_user_id = ${Number((user as any).id)}`);
    if (Number(pickSetting(all, "commission_distribution_enable", 0))) {
      pendingCommission = Math.trunc(pendingCommission * Number(pickSetting(all, "commission_distribution_l1", 0)) / 100);
    }
    const rate = Number((user as any).commission_rate || pickSetting(all, "invite_commission", 10));
    return ok({ codes: codes.results || [], stat: [invited, commission, pendingCommission, rate, Number((user as any).commission_balance || 0)] });
  }
  if (request.method === "GET" && route === "/invite/details") {
    const url = new URL(request.url);
    const current = Math.max(1, Number(url.searchParams.get("current") || 1));
    const pageSize = Math.max(10, Math.min(100, Number(url.searchParams.get("page_size") || 10)));
    const result = await env.XBOARD_DB.prepare("SELECT id, order_amount, trade_no, get_amount, created_at FROM v2_commission_log WHERE invite_user_id = ? AND get_amount > 0 ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .bind((user as any).id, pageSize, (current - 1) * pageSize).all();
    const total = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_commission_log WHERE invite_user_id = ${Number((user as any).id)} AND get_amount > 0`);
    return json({ data: result.results || [], total });
  }
  if (request.method === "GET" && route === "/comm/config") {
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    return ok({
      is_telegram: Number(Boolean(pickSetting(all, "telegram_bot_enable", 0))),
      telegram_discuss_link: pickSetting(all, "telegram_discuss_link", ""),
      stripe_pk: "",
      withdraw_methods: pickSetting(all, "commission_withdraw_method", ["USDT", "支付宝"]),
      withdraw_close: Number(Boolean(pickSetting(all, "withdraw_close_enable", 0))),
      currency: pickSetting(all, "currency", "CNY"),
      currency_symbol: pickSetting(all, "currency_symbol", "¥"),
      commission_distribution_enable: Number(Boolean(pickSetting(all, "commission_distribution_enable", 0))),
      commission_distribution_l1: pickSetting(all, "commission_distribution_l1", ""),
      commission_distribution_l2: pickSetting(all, "commission_distribution_l2", ""),
      commission_distribution_l3: pickSetting(all, "commission_distribution_l3", "")
    });
  }
  if (request.method === "GET" && route === "/telegram/getBotInfo") {
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const botToken = String(pickSetting(all, "telegram_bot_token", ""));
    let username = "";
    if (botToken) {
      try {
        const info = await cachedData(`telegram-bot-info:${md5(botToken)}`, 300, () => telegramRequest(botToken, "getMe"));
        username = String((info as any)?.username || "");
      } catch {}
    }
    return ok({ enabled: Boolean(pickSetting(all, "telegram_bot_enable", 0)), username, discuss_link: pickSetting(all, "telegram_discuss_link", "") });
  }
  if (request.method === "GET" && route === "/knowledge/getCategory") {
    const result = await env.XBOARD_DB.prepare("SELECT DISTINCT category FROM v2_knowledge WHERE show = 1 AND category IS NOT NULL AND category != '' ORDER BY category").all<{ category: string }>();
    return ok((result.results || []).map(row => row.category));
  }
  if (request.method === "GET" && route === "/stat/getTrafficLog") {
    const result = await env.XBOARD_DB.prepare(`SELECT user_id, server_rate, SUM(u) AS u, SUM(d) AS d, record_at
      FROM v2_stat_user WHERE user_id = ? AND record_at >= ?
      GROUP BY user_id, server_rate, record_at ORDER BY record_at DESC`).bind((user as any).id, monthStart()).all<Record<string, any>>();
    return ok((result.results || []).map(row => ({
      d: Number(row.d || 0), u: Number(row.u || 0), record_at: Number(row.record_at),
      server_rate: Number(row.server_rate ?? 1) || 1, user_id: Number(row.user_id)
    })));
  }
  if (request.method === "GET" && route === "/info") {
    const value = safeUser(user as Record<string, any>) as Record<string, any>;
    return ok({
      email: value.email, transfer_enable: value.transfer_enable, last_login_at: value.last_login_at, created_at: value.created_at,
      banned: value.banned, remind_expire: value.remind_expire, remind_traffic: value.remind_traffic, expired_at: value.expired_at,
      balance: value.balance, commission_balance: value.commission_balance, plan_id: value.plan_id, discount: value.discount,
      commission_rate: value.commission_rate, telegram_id: value.telegram_id, uuid: value.uuid,
      avatar_url: `https://cdn.v2ex.com/gravatar/${md5(String(value.email || ""))}?s=64&d=identicon`
    });
  }
  if (request.method === "GET" && route === "/checkLogin") return ok({ is_login: true, ...((user as any).is_admin ? { is_admin: true } : {}) });
  if (request.method === "GET" && route === "/getSubscribe") {
    const plan = (user as any).plan_id ? await env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id = ?").bind((user as any).plan_id).first<Record<string, any>>() : null;
    if ((user as any).plan_id && !plan) return fail("订阅计划不存在", 400, 400);
    const current = now();
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const method = plan
      ? (plan.reset_traffic_method === null || plan.reset_traffic_method === undefined
        ? Number(pickSetting(all, "reset_traffic_method", 0))
        : Number(plan.reset_traffic_method))
      : 2;
    const nextResetAt = plan ? edgeNextResetAt(nullableNumber((user as any).expired_at), method, current) : null;
    return ok({
      plan_id: (user as any).plan_id, token: (user as any).token, expired_at: (user as any).expired_at, u: Number((user as any).u || 0), d: Number((user as any).d || 0),
      transfer_enable: Number((user as any).transfer_enable || 0), email: (user as any).email, uuid: (user as any).uuid,
      device_limit: (user as any).device_limit, speed_limit: (user as any).speed_limit, next_reset_at: nextResetAt,
      plan: plan ? { ...plan, prices: parseJsonObject(plan.prices), tags: parseJsonArray(plan.tags) } : null,
      subscribe_url: await subscribeUrl(request, env, (user as any).token),
      reset_day: Number(nextResetAt || 0) > current ? Math.ceil((Number(nextResetAt) - current) / 86400) : null
    });
  }
  if (request.method === "GET" && route === "/getStat") {
    const pendingOrders = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_order WHERE status = 0 AND user_id = ${Number((user as any).id)}`);
    const pendingTickets = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_ticket WHERE status = 0 AND user_id = ${Number((user as any).id)}`);
    const invitedUsers = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE invite_user_id = ${Number((user as any).id)}`);
    return ok([pendingOrders, pendingTickets, invitedUsers]);
  }
  if (path.includes("/user/resetSecurity")) {
    const newToken = token(16);
    const newUuid = uuid();
    await env.XBOARD_DB.prepare("UPDATE v2_user SET token = ?, uuid = ?, updated_at = ? WHERE id = ?").bind(newToken, newUuid, now(), (user as any).id).run();
    await bump(env.XBOARD_KV, `user_version:${(user as any).id}`);
    return ok(await subscribeUrl(request, env, newToken));
  }
  if (request.method === "POST" && route === "/changePassword") {
    const input = await body<Record<string, any>>(request);
    const oldPassword = String(input.old_password || input.oldPassword || "");
    const newPassword = String(input.new_password || input.password || "");
    if (!oldPassword || !newPassword) return fail("密码字段不能为空", 422, 422);
    if (newPassword.length < 8) return fail("密码长度最小8位", 422, 422);
    if (!(await verifyPassword(oldPassword, String((user as any).password || ""), (user as any).password_algo, (user as any).password_salt))) return fail("旧密码错误", 400, 400);
    const password = await hashPassword(newPassword);
    await env.XBOARD_DB.prepare("UPDATE v2_user SET password = ?, password_algo = 'bcrypt', password_salt = NULL, updated_at = ? WHERE id = ?").bind(password, now(), (user as any).id).run();
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || request.headers.get("x-token") || request.headers.get("token") || "";
    if (bearer) await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ? AND token NOT IN (?, ?)").bind((user as any).id, bearer, await sessionTokenDigest(bearer)).run();
    else await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ?").bind((user as any).id).run();
    return ok(true);
  }
  if (path.includes("/user/update")) {
    const input = await body<Record<string, any>>(request);
    const remindExpire = "remind_expire" in input ? boolNumber(input.remind_expire, 1) : undefined;
    const remindTraffic = "remind_traffic" in input ? boolNumber(input.remind_traffic, 1) : undefined;
    const updates: Record<string, unknown> = {};
    if (remindExpire !== undefined) updates.remind_expire = remindExpire;
    if (remindTraffic !== undefined) updates.remind_traffic = remindTraffic;
    const entries = Object.entries(updates);
    if (entries.length) {
      await env.XBOARD_DB.prepare(`UPDATE v2_user SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...entries.map(([, value]) => value), now(), (user as any).id).run();
      await bump(env.XBOARD_KV, `user_version:${(user as any).id}`);
    }
    return ok(true);
  }
  if (request.method === "POST" && route === "/transfer") {
    const input = await body<Record<string, any>>(request);
    const amount = Math.trunc(Number(input.transfer_amount || 0));
    if (amount <= 0) return fail("转入金额必须大于0", 422, 422);
    if (amount > Number((user as any).commission_balance || 0)) return fail("推广佣金不足", 400, 400);
    const result = await env.XBOARD_DB.prepare("UPDATE v2_user SET commission_balance = commission_balance - ?, balance = balance + ?, updated_at = ? WHERE id = ? AND commission_balance >= ?")
      .bind(amount, amount, now(), (user as any).id, amount).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok(true) : fail("推广佣金不足", 400, 400);
  }
  if (request.method === "POST" && route === "/getQuickLoginUrl") {
    const input = await body<Record<string, any>>(request); const verify = randomString(32);
    await optionalKvPutTtl(env, `quick_login:${verify}`, String((user as any).id), 60);
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV); const base = String(pickSetting(all, "app_url", "") || new URL(request.url).origin).replace(/\/$/, "");
    return ok(`${base}/#/login?verify=${verify}&redirect=${encodeURIComponent(String(input.redirect || "dashboard"))}`);
  }
  if (request.method === "POST" && route === "/coupon/check") {
    const input = await body<Record<string, any>>(request);
    const code = String(input.code || "").trim();
    if (!code) return fail("优惠券不能为空", 422, 422);
    const coupon = await env.XBOARD_DB.prepare("SELECT * FROM v2_coupon WHERE code = ? AND show = 1").bind(code).first<Record<string, any>>();
    if (!coupon) return fail("优惠券无效", 400, 400);
    const ts = now();
    if (Number(coupon.started_at || 0) > ts || Number(coupon.ended_at || 0) < ts) return fail("优惠券无效", 400, 400);
    const planId = nullableNumber(input.plan_id); const period = normalizeOrderPeriod(input.period);
    const limitedPlans = parseJsonArray(coupon.limit_plan_ids).map(Number);
    if (limitedPlans.length && (!planId || !limitedPlans.includes(planId))) return fail("优惠券不适用于该套餐", 400, 400);
    const limitedPeriods = canonicalCouponPeriods(coupon.limit_period);
    if (limitedPeriods.length && (!period || !limitedPeriods.includes(period))) return fail("优惠券不适用于该周期", 400, 400);
    if (coupon.limit_use !== null && coupon.limit_use !== undefined && Number(coupon.limit_use) <= 0) return fail("优惠券已用完", 400, 400);
    if (Number(coupon.limit_use_with_user || 0) > 0) {
      const used = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_order WHERE coupon_id = ${Number(coupon.id)} AND user_id = ${Number((user as any).id)} AND status NOT IN (0,2)`);
      if (used >= Number(coupon.limit_use_with_user)) return fail("优惠券已达到个人使用次数限制", 400, 400);
    }
    return ok(couponResource(coupon));
  }
  if (route.startsWith("/order/")) {
    const url = new URL(request.url); const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
    url.searchParams.forEach((value, key) => { input[key] = value; });
    const userId = Number((user as any).id);
    const orderResource = async (row: Record<string, any>) => {
      const plan = row.plan_id ? await env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(row.plan_id).first<Record<string, any>>() : null;
      return { ...row, status: Number(row.status), total_amount: Number(row.total_amount || 0), period: legacyOrderPeriod(row.period), plan: plan ? { ...plan, prices: parseJsonObject(plan.prices), tags: parseJsonArray(plan.tags) } : null, payment: null };
    };
    if (request.method === "GET" && route === "/order/fetch") {
      const status = input.status === undefined ? null : nullableNumber(input.status);
      if (input.status !== undefined && (status === null || ![0,1,2,3].includes(status))) return fail("状态参数有误", 422, 422);
      const result = status === null
        ? await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<Record<string, any>>()
        : await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND status = ? ORDER BY created_at DESC").bind(userId, status).all<Record<string, any>>();
      return ok(await Promise.all((result.results || []).map(orderResource)));
    }
    if (request.method === "GET" && route === "/order/detail") {
      const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND trade_no = ?").bind(userId, String(input.trade_no || "")).first<Record<string, any>>();
      if (!order) return fail("订单不存在或已支付", 400, 400);
      const value = await orderResource(order);
      if (!value.plan) return fail("订阅计划不存在", 400, 400);
      const surplusOrderIds = parseJsonArray(order.surplus_order_ids).map(Number).filter(Boolean);
      const surplusResult = surplusOrderIds.length
        ? await env.XBOARD_DB.prepare(`SELECT * FROM v2_order WHERE user_id = ? AND id IN (${surplusOrderIds.map(() => "?").join(",")}) ORDER BY id ASC`).bind(userId, ...surplusOrderIds).all<Record<string, any>>()
        : { results: [] as Record<string, any>[] };
      return ok({ ...value, try_out_plan_id: Number(pickSetting(await settings(env.XBOARD_DB, env.XBOARD_KV), "try_out_plan_id", 0)), surplus_orders: surplusResult.results || [] });
    }
    if (request.method === "GET" && route === "/order/check") {
      const order = await env.XBOARD_DB.prepare("SELECT status FROM v2_order WHERE user_id = ? AND trade_no = ?").bind(userId, String(input.trade_no || "")).first<{ status: number }>();
      return order ? ok(Number(order.status)) : fail("订单不存在", 400, 400);
    }
    if (request.method === "GET" && route === "/order/getPaymentMethod") return ok([]);
    if (request.method === "POST" && route === "/order/cancel") {
      const tradeNo = String(input.trade_no || "");
      if (!tradeNo) return fail("参数无效", 422, 422);
      const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND trade_no = ?").bind(userId, tradeNo).first<Record<string, any>>();
      if (!order) return fail("订单不存在", 400, 400);
      if (Number(order.status) !== 0) return fail("只能取消待支付订单", 400, 400);
      return await cancelOrder(env, order, now()) ? ok(true) : fail("取消失败", 400, 400);
    }
    if (request.method === "POST" && route === "/order/save") {
      const planId = nullableNumber(input.plan_id); const legacyPeriod = String(input.period || ""); const period = normalizeOrderPeriod(legacyPeriod);
      if (!planId) return fail("套餐ID不能为空", 422, 422);
      if (!period) return fail("套餐周期错误", 422, 422);
      const pending = await env.XBOARD_DB.prepare("SELECT id FROM v2_order WHERE user_id = ? AND status IN (0,1) LIMIT 1").bind(userId).first();
      if (pending) return fail("您有未支付或待处理订单，请先取消", 400, 400);
      const plan = await env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(planId).first<Record<string, any>>();
      if (!plan) return fail("订阅计划不存在", 400, 400);
      const prices = parseJsonObject(plan.prices); const price = Number(prices[period] ?? prices[legacyPeriod]);
      if (!Number.isFinite(price) || price < 0) return fail("该付款周期未启用", 400, 400);
      const samePlan = Number((user as any).plan_id) === planId;
      const activeUser = userIsAvailable(user as Record<string, any>);
      if (period === "reset_traffic") {
        if (!samePlan || !activeUser) return fail("订阅已过期或无有效订阅，无法购买流量重置包", 400, 400);
      } else {
        if ((!Number(plan.show) && !Number(plan.renew)) || (!Number(plan.show) && !samePlan)) return fail("该订阅已售罄，请选择其他订阅", 400, 400);
        if (!Number(plan.renew) && samePlan) return fail("该订阅无法续费，请更换其他订阅", 400, 400);
        if (!Number(plan.show) && Number(plan.renew) && !activeUser) return fail("该订阅已过期，请更换其他订阅", 400, 400);
      }
      if (plan.capacity_limit !== null && plan.capacity_limit !== undefined) {
        const count = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE plan_id = ${planId} AND (expired_at IS NULL OR expired_at >= ${now()})`);
        if (count >= Number(plan.capacity_limit) && Number((user as any).plan_id) !== planId) return fail("该订阅已售罄", 400, 400);
      }
      let totalAmount = Math.trunc(price * 100);
      let discountAmount = 0;
      let couponId: number | null = null;
      let couponHasGlobalLimit = false;
      const couponCode = String(input.coupon_code || "").trim();
      if (couponCode) {
        const coupon = await env.XBOARD_DB.prepare("SELECT * FROM v2_coupon WHERE code = ?").bind(couponCode).first<Record<string, any>>();
        const ts = now();
        if (!coupon || !Number(coupon.show)) return fail("优惠券无效", 400, 400);
        if (coupon.limit_use !== null && Number(coupon.limit_use) <= 0) return fail("优惠券已用完", 400, 400);
        if (Number(coupon.started_at || 0) > ts || Number(coupon.ended_at || 0) < ts) return fail("优惠券不在有效期内", 400, 400);
        const limitedPlans = parseJsonArray(coupon.limit_plan_ids).map(Number);
        if (limitedPlans.length && !limitedPlans.includes(planId)) return fail("优惠券不适用于该套餐", 400, 400);
        const limitedPeriods = canonicalCouponPeriods(coupon.limit_period);
        if (limitedPeriods.length && !limitedPeriods.includes(period)) return fail("优惠券不适用于该周期", 400, 400);
        if (coupon.limit_use_with_user !== null) {
          const used = await env.XBOARD_DB.prepare("SELECT COUNT(*) AS count FROM v2_order WHERE coupon_id = ? AND user_id = ? AND status NOT IN (0,2)").bind(coupon.id, userId).first<{ count: number }>();
          if (Number(used?.count || 0) >= Number(coupon.limit_use_with_user)) return fail("优惠券已达到个人使用次数限制", 400, 400);
        }
        const couponType = Math.trunc(Number.parseFloat(String(coupon.type || 0)));
        discountAmount = couponType === 1 ? Number(coupon.value || 0) : couponType === 2 ? totalAmount * Number(coupon.value || 0) / 100 : 0;
        discountAmount = Math.min(totalAmount, Math.trunc(discountAmount));
        couponId = Number(coupon.id);
        couponHasGlobalLimit = coupon.limit_use !== null;
      }
      if (Number((user as any).discount || 0) > 0) discountAmount += Math.trunc(totalAmount * Number((user as any).discount) / 100);
      discountAmount = Math.min(totalAmount, discountAmount);
      totalAmount -= discountAmount;
      const tradeNo = token(16); const ts = now();
      const hasPlan = (user as any).plan_id !== null && (user as any).plan_id !== undefined;
      const type = period === "reset_traffic" ? 4
        : hasPlan && Number((user as any).plan_id) !== planId && ((user as any).expired_at === null || Number((user as any).expired_at) > ts) ? 3
        : Number((user as any).plan_id) === planId && ((user as any).expired_at === null || Number((user as any).expired_at) > ts) ? 2 : 1;
      const allSettings = await settings(env.XBOARD_DB, env.XBOARD_KV);
      if (type === 3 && !Number(pickSetting(allSettings, "plan_change_enable", 1))) return fail("目前不允许更改订阅，请联系客服或提交工单操作", 400, 400);
      const currentUser = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(userId).first<Record<string, any>>() || user as Record<string, any>;
      let surplusAmount = 0;
      let surplusCredit = 0;
      let surplusOrderIds: number[] = [];
      if (type === 3 && Number(pickSetting(allSettings, "surplus_enable", 1))) {
        const surplus = await orderSurplus(env, currentUser, allSettings);
        surplusAmount = surplus.amount;
        surplusOrderIds = surplus.orderIds;
        if (surplusAmount >= totalAmount) {
          surplusCredit = surplusAmount - totalAmount;
          totalAmount = 0;
        } else {
          totalAmount -= surplusAmount;
        }
      }
      const commission = await orderCommission(env, currentUser, totalAmount);
      const payableAmount = totalAmount;
      const couponAvailability = couponHasGlobalLimit ? " AND EXISTS (SELECT 1 FROM v2_coupon WHERE id=? AND limit_use>0)" : "";
      const statements = [env.XBOARD_DB.prepare(`INSERT INTO v2_order(user_id, plan_id, period, trade_no, status, total_amount, balance_amount, discount_amount, coupon_id, type, surplus_amount, surplus_credit, surplus_order_ids, invite_user_id, commission_balance, created_at, updated_at)
        SELECT ?,?,?,?,0,MAX(0,?-MIN(MAX(COALESCE(u.balance,0),0),?)),MIN(MAX(COALESCE(u.balance,0),0),?),?,?,?,?,?,?,?,?,?,?
        FROM v2_user u WHERE u.id=? AND NOT EXISTS (SELECT 1 FROM v2_order WHERE user_id=u.id AND status IN (0,1))${couponAvailability}`)
        .bind(userId, planId, period, tradeNo, payableAmount, payableAmount, payableAmount, discountAmount, couponId, type, surplusAmount, surplusCredit, JSON.stringify(surplusOrderIds), commission.inviteUserId, commission.commissionBalance, ts, ts, userId, ...(couponHasGlobalLimit ? [couponId] : []))];
      statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET balance=balance-(SELECT balance_amount FROM v2_order WHERE trade_no=?),updated_at=?
        WHERE id=? AND EXISTS (SELECT 1 FROM v2_order WHERE trade_no=? AND user_id=? AND status=0) AND (SELECT balance_amount FROM v2_order WHERE trade_no=?)>0`)
        .bind(tradeNo, ts, userId, tradeNo, userId, tradeNo));
      if (couponHasGlobalLimit) statements.push(env.XBOARD_DB.prepare("UPDATE v2_coupon SET limit_use=limit_use-1,updated_at=? WHERE id=? AND limit_use>0 AND EXISTS (SELECT 1 FROM v2_order WHERE trade_no=?)").bind(ts, couponId, tradeNo));
      const results = await env.XBOARD_DB.batch(statements);
      if (Number((results[0]?.meta as any)?.changes || 0) !== 1) return couponHasGlobalLimit
        ? fail("优惠券已用完", 400, 400)
        : fail("您有未支付或开通中的订单，请稍后再试或取消它", 400, 400);
      return ok(tradeNo);
    }
    if (request.method === "POST" && route === "/order/checkout") {
      const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND trade_no = ? AND status = 0").bind(userId, String(input.trade_no || "")).first<Record<string, any>>();
      if (!order) return fail("订单不存在或已支付", 400, 400);
      if (Number(order.total_amount || 0) > 0) return fail("真实支付功能暂未启用", 400, 400);
      const paidRequest = new Request(request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trade_no: order.trade_no, callback_no: order.trade_no }) });
      const paid = await adminOrder(paidRequest, env, "/order/paid");
      if (!paid?.ok) return paid || fail("支付失败", 400, 400);
      return json({ type: -1, data: true });
    }
  }
  if (path.includes("/plan/fetch")) {
    const plans = await publicPlanRows(request, env);
    const counts = await env.XBOARD_DB.prepare("SELECT plan_id, COUNT(*) AS count FROM v2_user WHERE plan_id IS NOT NULL AND (expired_at IS NULL OR expired_at >= ?) GROUP BY plan_id").bind(now()).all<any>();
    const countMap = new Map((counts.results || []).map(row => [Number(row.plan_id), Number(row.count)]));
    const id = nullableNumber(new URL(request.url).searchParams.get("id"));
    const hasCapacity = (row: Record<string, any>) => row.capacity_limit === null || row.capacity_limit === undefined || (countMap.get(Number(row.id)) || 0) < Number(row.capacity_limit);
    if (id) {
      const plan = plans.find(row => Number((row as any).id) === id) as Record<string, any> | undefined;
      const ownPlan = Number((user as any).plan_id) === id;
      const available = !!plan && (ownPlan ? Number(plan.renew) === 1 : Number(plan.show) === 1 && Number(plan.sell) === 1 && hasCapacity(plan));
      return available ? ok(plan) : fail("Subscription plan does not exist", 400, 400);
    }
    return ok(plans.filter(row => Number((row as any).show) === 1 && Number((row as any).sell) === 1 && hasCapacity(row as Record<string, any>)));
  }
  if (path.includes("/server/fetch")) {
    const available = userIsAvailable(user as Record<string, any>);
    if (!available) return ok([]);
    const servers = (await adminServerRows(env))
      .filter(row => Number((row as any).show ?? 1) === 1 && parseJsonArray((row as any).group_ids).map(Number).includes(Number((user as any).group_id || 0)))
      .map(row => ({
        id: row.id, type: row.type, version: row.version ?? null, name: row.name, rate: Number(row.rate ?? 1),
        tags: row.tags, is_online: Number(row.is_online || 0), cache_key: row.cache_key, last_check_at: row.last_check_at
      }));
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(JSON.stringify(servers.map(row => row.cache_key))));
    const etag = `"${Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("")}"`;
    if ((request.headers.get("if-none-match") || "").split(",").map(value => value.trim()).includes(etag)) return new Response(null, { status: 304, headers: { etag } });
    const response = ok(servers);
    response.headers.set("etag", etag);
    return response;
  }
  if (path.includes("/notice/fetch")) {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("current") || 1));
    const pageSize = 5;
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_notice WHERE show = 1 ORDER BY sort ASC, id DESC LIMIT ? OFFSET ?").bind(pageSize, (page - 1) * pageSize).all();
    const total = await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_notice WHERE show = 1");
    return json({ data: result.results || [], total });
  }
  if (path.includes("/knowledge/fetch")) {
    const url = new URL(request.url);
    const id = nullableNumber(url.searchParams.get("id"));
    const language = url.searchParams.get("language");
    const keyword = String(url.searchParams.get("keyword") || "").trim();
    if (url.searchParams.has("id") && !id) return fail("id 字段格式有误", 422, 422);
    if (language !== null && language.length > 10) return fail("language 字段长度不能超过10", 422, 422);
    if (keyword.length > 255) return fail("keyword 字段长度不能超过255", 422, 422);
    const clauses = ["show = 1"];
    const bindings: unknown[] = [];
    if (id) { clauses.push("id = ?"); bindings.push(id); }
    else {
      clauses.push(language === null ? "language IS NULL" : "language = ?");
      if (language !== null) bindings.push(language);
      if (keyword) { clauses.push("(title LIKE ? OR body LIKE ?)"); bindings.push(`%${keyword}%`, `%${keyword}%`); }
    }
    const selected = id ? "*" : "id, category, title, updated_at, body";
    const result = await env.XBOARD_DB.prepare(`SELECT ${selected} FROM v2_knowledge WHERE ${clauses.join(" AND ")} ORDER BY sort ASC, id ASC`).bind(...bindings).all<Record<string, any>>();
    const allSettings = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const subscription = await subscribeUrl(request, env, String((user as any).token || ""));
    const available = userIsAvailable(user as Record<string, any>);
    const safeBase64 = btoa(subscription).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const processRow = (row: Record<string, any>): Record<string, any> => {
      let content = String(row.body || "");
      if (!available) content = content.replace(/<!--access start-->(.*?)<!--access end-->/gs, '<div class="v2board-no-access">You must have a valid subscription to view content in this area</div>');
      content = content
        .replaceAll("{{siteName}}", String(pickSetting(allSettings, "app_name", "XBoard")))
        .replaceAll("{{subscribeUrl}}", subscription)
        .replaceAll("{{urlEncodeSubscribeUrl}}", phpUrlEncode(subscription))
        .replaceAll("{{safeBase64SubscribeUrl}}", safeBase64);
      return { id: row.id, category: row.category, title: row.title, ...(row.body !== undefined ? { body: content } : {}), updated_at: row.updated_at };
    };
    const knowledge = (result.results || []).map(processRow);
    if (id) return knowledge[0] ? ok(knowledge[0]) : fail("Article does not exist", 500, 500);
    const grouped: Record<string, Record<string, any>[]> = {};
    for (const row of knowledge) (grouped[String(row.category || "") ] ||= []).push(row);
    return ok(grouped);
  }
  if (request.method === "GET" && route === "/ticket/fetch") {
    const id = nullableNumber(new URL(request.url).searchParams.get("id"));
    if (id) {
      const ticket = await env.XBOARD_DB.prepare("SELECT * FROM v2_ticket WHERE id = ? AND user_id = ?").bind(id, (user as any).id).first<Record<string, any>>();
      if (!ticket) return fail("工单不存在", 400, 400);
      const messages = await env.XBOARD_DB.prepare("SELECT *, CASE WHEN user_id = ? THEN 1 ELSE 0 END AS is_me FROM v2_ticket_message WHERE ticket_id = ? ORDER BY id ASC").bind((user as any).id, id).all();
      return ok({ ...ticket, message: messages.results || [] });
    }
    const data = await env.XBOARD_DB.prepare("SELECT * FROM v2_ticket WHERE user_id = ? ORDER BY created_at DESC").bind((user as any).id).all();
    return ok(data.results || []);
  }
  if (request.method === "POST" && route === "/ticket/save") {
    const input = await body<Record<string, any>>(request);
    if (!String(input.subject || "").trim() || !String(input.message || "").trim()) return fail("工单主题和内容不能为空", 422, 422);
    if (![0, 1, 2].includes(Number(input.level))) return fail("工单等级格式不正确", 422, 422);
    const ts = now();
    const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_ticket WHERE user_id = ? AND status = 0 LIMIT 1").bind((user as any).id).first();
    if (existing) return fail("存在未关闭的工单", 400, 400);
    const result = await env.XBOARD_DB.prepare("INSERT INTO v2_ticket(user_id, subject, level, status, reply_status, last_reply_user_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)")
      .bind((user as any).id, String(input.subject), Number(input.level || 0), (user as any).id, ts, ts).run();
    await env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(Number((result.meta as any)?.last_row_id || 0), (user as any).id, String(input.message), ts, ts).run();
    const ticketId = Number((result.meta as any)?.last_row_id || 0);
    try { await queueTelegramToAdmins(env, await ticketTelegramText(env, request, user as Record<string, any>, ticketId, String(input.subject), String(input.message))); } catch {}
    return ok(true);
  }
  if (path.includes("/ticket/close")) {
    const input = await body<Record<string, any>>(request);
    const result = await env.XBOARD_DB.prepare("UPDATE v2_ticket SET status = 1, updated_at = ? WHERE id = ? AND user_id = ?").bind(now(), input.id, (user as any).id).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok(true) : fail("工单不存在", 400, 400);
  }
  if (request.method === "POST" && route === "/ticket/reply") {
    const input = await body<Record<string, any>>(request);
    if (!input.id || !input.message) return fail("参数不正确", 400, 400);
    const ticket = await env.XBOARD_DB.prepare("SELECT id, subject, status, reply_status, last_reply_user_id FROM v2_ticket WHERE id = ? AND user_id = ?").bind(input.id, (user as any).id).first<Record<string, any>>();
    if (!ticket) return fail("工单不存在", 400, 400);
    if (Number(ticket.status)) return fail("工单已关闭，无法回复", 400, 400);
    const config = await settings(env.XBOARD_DB, env.XBOARD_KV);
    if (Number(pickSetting(config, "ticket_must_wait_reply", 0)) && Number(ticket.last_reply_user_id) === Number((user as any).id)) return fail("请等待客服回复后再发送消息", 400, 400);
    const ts = now();
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(ticket.id, (user as any).id, String(input.message), ts, ts),
      env.XBOARD_DB.prepare("UPDATE v2_ticket SET reply_status = 0, last_reply_user_id = ?, updated_at = ? WHERE id = ?").bind((user as any).id, ts, ticket.id)
    ]);
    try { await queueTelegramToAdmins(env, await ticketTelegramText(env, request, user as Record<string, any>, Number(ticket.id), String(ticket.subject || ""), String(input.message))); } catch {}
    return ok(true);
  }
  if (request.method === "POST" && route === "/ticket/withdraw") {
    const input = await body<Record<string, any>>(request); const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    if (Number(pickSetting(all, "withdraw_close_enable", 0))) return fail("Unsupported withdraw", 400, 400);
    const methods = pickSetting(all, "commission_withdraw_method", ["USDT", "支付宝"]);
    if (!Array.isArray(methods) || !methods.includes(input.withdraw_method)) return fail("Unsupported withdrawal method", 422, 422);
    const limit = Number(pickSetting(all, "commission_withdraw_limit", 100));
    if (Number((user as any).commission_balance || 0) / 100 < limit) return fail(`The current required minimum withdrawal commission is ${limit}`, 422, 422);
    if (!String(input.withdraw_account || "").trim()) return fail("Withdrawal account is required", 422, 422);
    const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_ticket WHERE user_id = ? AND status = 0 LIMIT 1").bind((user as any).id).first();
    if (existing) return fail("存在未关闭的工单", 400, 400);
    const ts = now(); const result = await env.XBOARD_DB.prepare("INSERT INTO v2_ticket(user_id,subject,level,status,reply_status,last_reply_user_id,created_at,updated_at) VALUES (?, ?, 2, 0, 0, ?, ?, ?)")
      .bind((user as any).id, "[Commission Withdrawal Request] This ticket is opened by the system", (user as any).id, ts, ts).run();
    await env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id,user_id,message,created_at,updated_at) VALUES (?,?,?,?,?)")
      .bind(Number((result.meta as any)?.last_row_id || 0), (user as any).id, `Withdrawal method：${input.withdraw_method}\r\nWithdrawal account：${input.withdraw_account}`, ts, ts).run();
    return ok(true);
  }
  return json({ message: "Not Found" }, 404);
}

function assetRequest(request: Request, pathname: string) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url.toString(), request);
}

function normalizeSecurePath(value: unknown) {
  const path = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  return path || "admin";
}

async function currentSecurePath(env: Env) {
  const values = await settings(env.XBOARD_DB, env.XBOARD_KV);
  return normalizeSecurePath(values.secure_path || "admin");
}

async function currentSubscribePath(env: Env) {
  const values = await settings(env.XBOARD_DB, env.XBOARD_KV);
  return String(values.subscribe_path || "s").trim().replace(/^\/+|\/+$/g, "") || "s";
}

function isSubscriptionPath(pathname: string, subscribePath: string) {
  const prefix = `/${subscribePath}/`;
  if (!pathname.startsWith(prefix)) return false;
  const token = pathname.slice(prefix.length);
  return token.length > 0 && !token.includes("/");
}

async function adminUi(request: Request, env: Env, securePath: string) {
  const settingsJson = JSON.stringify({ base_url: "/", secure_path: `/${securePath}` }).replace(/</g, "\\u003c");
  const migrationHref = JSON.stringify(`/${securePath}/migration`).replace(/</g, "\\u003c");
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admin</title>
    <meta name="description" content="Admin Dashboard UI built with Shadcn and Vite." />
    <script>window.settings = ${settingsJson};</script>
    <script src="/settings.local.js"></script>
    <script src="/locales/en-US.js"></script>
    <script src="/locales/zh-CN.js"></script>
    <script src="/locales/ru-RU.js"></script>
    <script type="module" crossorigin src="/assets/index-CF20260713.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-DiYa-_z_.css">
    <link rel="stylesheet" href="/assets/mobile-node-dialog-fix.css">
    <script defer src="/assets/mobile-node-dialog-fix.js"></script>
    <style>
      aside nav li:has(> a[href$="#/config/plugin"]),
      aside nav li:has(> a[href$="#/config/payment"]),
      aside nav li:has(> a[href$="#/config/theme"]),
      aside nav a[href$="#/config/plugin"],
      aside nav a[href$="#/config/payment"],
      aside nav a[href$="#/config/theme"] { display: none !important; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      (() => {
        const href = ${migrationHref};
        const browserDate = () => {
          const parts = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" })
            .formatToParts(new Date());
          const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
          return values.year + "-" + values.month + "-" + values.day;
        };
        const updateFooterDate = () => {
          const version = document.querySelector("aside div.border-t span.whitespace-nowrap");
          if (!version) return;
          const date = browserDate();
          if (version.textContent !== date) version.textContent = date;
          if (version.title !== "浏览器本地日期") version.title = "浏览器本地日期";
        };
        const install = () => {
          const nav = document.querySelector("aside nav");
          // Reserved for future native plugin, payment, and theme implementations. Keep routes and code, hide only their menus.
          nav?.querySelectorAll('a[href]').forEach(menu => {
            const target = new URL(menu.href, location.href);
            const route = target.hash.replace(/^#/, "") || target.pathname;
            if (route === "/config/plugin" || route === "/config/payment" || route === "/config/theme") {
              const item = menu.closest("li") || menu;
              item.dataset.xboardReservedMenu = "true";
              item.style.display = "none";
            }
          });
          const migrationLabels = {
            "zh-CN": { text: "数据迁移", title: "从原版 SQLite 导入数据或导出原版兼容数据库" },
            "en-US": { text: "Data Migration", title: "Import an original XBoard SQLite database or export an original-compatible database" },
            "ru-RU": { text: "Миграция данных", title: "Импорт базы SQLite из оригинального XBoard или экспорт совместимой базы" }
          };
          const language = localStorage.getItem("i18nextLng") || "zh-CN";
          const label = migrationLabels[language] || migrationLabels["en-US"];
          let link = nav?.querySelector("#xboard-migration-menu");
          if (nav && !link) {
            const knowledgeLink = Array.from(nav.querySelectorAll("a[href]")).find(menu => {
              const target = new URL(menu.href, location.href);
              return (target.hash.replace(/^#/, "") || target.pathname) === "/config/knowledge";
            });
            const sourceItem = knowledgeLink?.closest("li") || knowledgeLink;
            if (sourceItem) {
              const item = sourceItem.cloneNode(true);
              link = item.matches("a") ? item : item.querySelector("a");
              if (link) {
                link.id = "xboard-migration-menu";
                link.href = href;
                link.innerHTML = '<div class="mr-2"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tabler-icon tabler-icon-database-import"><path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"></path><path d="M4 6v12"></path><path d="M20 6v8"></path><path d="M4 12a8 3 0 0 0 16 0"></path><path d="M4 18c0 1.657 3.582 3 8 3c1.05 0 2.052-.076 2.25-.214"></path><path d="M20 17v6"></path><path d="M17 20l3 3l3 -3"></path></svg></div><span></span>';
                sourceItem.insertAdjacentElement("afterend", item);
              }
            }
          }
          link = nav?.querySelector("#xboard-migration-menu");
          const text = link?.querySelector("span");
          if (link && link.title !== label.title) link.title = label.title;
          if (text && text.textContent !== label.text) text.textContent = label.text;
          updateFooterDate();
        };
        new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
        window.setInterval(updateFooterDate, 60000);
        install();
      })();
    </script>
  </body>
</html>`, { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "pragma": "no-cache",
    "expires": "0"
  } });
}

function isAdminDistAlias(pathname: string) {
  if (!pathname.startsWith("/api/v2/")) return false;
  const adminPrefixes = [
    "/api/v2/stat/",
    "/api/v2/config/",
    "/api/v2/theme/",
    "/api/v2/plugin/",
    "/api/v2/payment/",
    "/api/v2/mail/",
    "/api/v2/system/",
    "/api/v2/server/",
    "/api/v2/plan/",
    "/api/v2/order/",
    "/api/v2/coupon/",
    "/api/v2/commission/",
    "/api/v2/gift-card/",
    "/api/v2/traffic-reset/",
    "/api/v2/notice/",
    "/api/v2/knowledge/",
    "/api/v2/ticket/"
  ];
  if (adminPrefixes.some(prefix => pathname.startsWith(prefix))) return true;
  const adminUserPaths = [
    "/api/v2/user/fetch",
    "/api/v2/user/update",
    "/api/v2/user/getUserInfoById",
    "/api/v2/user/getSubscribe",
    "/api/v2/user/setInviteUser",
    "/api/v2/user/resetSecret",
    "/api/v2/user/generate",
    "/api/v2/user/destroy",
    "/api/v2/user/sendMail",
    "/api/v2/user/dumpCSV",
    "/api/v2/user/ban"
  ];
  return adminUserPaths.some(path => pathname === path || pathname.startsWith(`${path}/`));
}

async function edgeFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isNodeProtocolPath(url.pathname, request.method)) return env.XBOARD_SERVER.fetch(request);
    if (url.pathname === "/api/v1/client/subscribe") return handleSubscriptionRequest(request, env);
    const staticAsset = url.pathname === "/settings.local.js" || url.pathname === "/manifest.json" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/locales/") || url.pathname.startsWith("/images/");
    if (!staticAsset) {
      await ensureBootstrap(env);
    }
    if (!staticAsset && isSubscriptionPath(url.pathname, await currentSubscribePath(env))) return handleSubscriptionRequest(request, env);
    if (url.pathname === "/health") return ok({ service: "xboard-edge", time: now() });
    const securePath = staticAsset ? "admin" : await currentSecurePath(env);
    const adminUiPath = `/${securePath}`;
    if (url.pathname === adminUiPath || url.pathname === `${adminUiPath}/`) return adminUi(request, env, securePath);
    if (url.pathname === `${adminUiPath}/migration` || url.pathname === `${adminUiPath}/migration/`) {
      const assetUrl = new URL("/migration/panel.html", request.url);
      let response = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        response = await env.ASSETS.fetch(new Request(new URL(location, request.url).toString(), request));
      }
      return new Response(response.body, { status: response.status, headers: response.headers });
    }
    if (url.pathname.startsWith(`${adminUiPath}/migration/`)) {
      const relative = url.pathname.slice(`${adminUiPath}/migration/`.length);
      const assetUrl = new URL(`/migration/${relative}`, request.url);
      return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    }
    if (url.pathname.startsWith(`${adminUiPath}/api/`)) {
      url.pathname = url.pathname.slice(adminUiPath.length);
      request = new Request(url.toString(), request);
    }
    if (staticAsset) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname.startsWith("/api/v1/passport") || url.pathname.startsWith("/api/v2/passport")) {
      return userApi(request, env, url.pathname);
    }
    if (url.pathname.startsWith("/api/v1/guest")) return guestApi(request, env, url.pathname);
    if (url.pathname.startsWith("/api/v1/client") || url.pathname.startsWith("/api/v2/client")) {
      return clientApi(request, env, url.pathname);
    }
    const dynamicAdminPrefix = `/api/v2/${securePath}`;
    if (url.pathname === dynamicAdminPrefix || url.pathname.startsWith(`${dynamicAdminPrefix}/`)) {
      const canonicalPath = `/api/v2/admin${url.pathname.slice(dynamicAdminPrefix.length)}`;
      const canonicalUrl = new URL(request.url);
      canonicalUrl.pathname = canonicalPath;
      const canonicalRequest = new Request(canonicalUrl.toString(), request);
      const syncIntent = await nodeSyncIntent(canonicalRequest.clone(), canonicalPath, env);
      const response = await adminApi(canonicalRequest, env, canonicalPath);
      if (syncIntent && response.ok) ctx.waitUntil(notifyNodeSync(env, syncIntent));
      return response;
    }
    if (url.pathname === "/api/v2/admin/migration" || url.pathname.startsWith("/api/v2/admin/migration/")) {
      return adminApi(request, env, url.pathname);
    }
    if (securePath !== "admin" && url.pathname.startsWith("/api/v2/admin")) return json({ message: "Not Found" }, 404);
    if (url.pathname.startsWith("/api/v2/admin")) {
      const syncIntent = await nodeSyncIntent(request.clone(), url.pathname, env);
      const response = await adminApi(request, env, url.pathname);
      if (syncIntent && response.ok) ctx.waitUntil(notifyNodeSync(env, syncIntent));
      return response;
    }
    if (isAdminDistAlias(url.pathname)) {
      const syncIntent = await nodeSyncIntent(request.clone(), url.pathname, env);
      const response = await adminApi(request, env, url.pathname.replace("/api/v2", "/api/v2/admin"));
      if (syncIntent && response.ok) ctx.waitUntil(notifyNodeSync(env, syncIntent));
      return response;
    }
    if (url.pathname.startsWith("/api/v1/user") || url.pathname.startsWith("/api/v2/user")) return userApi(request, env, url.pathname);
    if (url.pathname === "/") return new Response("200", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ message: "Not Found" }, 404);
}

function corsResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "*");
  headers.set("access-control-allow-headers", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const apiRequest = new URL(request.url).pathname.startsWith("/api/");
    if (apiRequest && request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
    const sessionEnv = {
      ...env,
      XBOARD_DB: primaryDatabase(env.XBOARD_DB),
      PUBLIC_READ_DB: unconstrainedDatabase(env.XBOARD_DB),
      SUBSCRIPTION_DB: env.XBOARD_DB
    };
    const response = await edgeFetch(request, sessionEnv, ctx);
    return apiRequest ? corsResponse(response) : response;
  }
};
