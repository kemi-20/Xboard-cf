import type { D1Database, ExecutionContext, Fetcher, KVNamespace, Queue } from "./types";
import { body, fail, json, now, ok, randomString, token, uuid } from "./compat";
import { createSession, currentUser, hashPassword, verifyPassword } from "./auth";
import { list, rows, settings } from "./db";
import { bump } from "./kv";
import { handleAdminGiftCard, handleUserGiftCard } from "./gift-card";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; ASSETS: Fetcher; XBOARD_SERVER: Fetcher; XBOARD_SUBSCRIPTION: Fetcher; MAIL_EVENTS: Queue; }

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
  "/theme/getThemes": ["GET"], "/theme/upload": ["POST"], "/theme/delete": ["POST"], "/theme/saveThemeConfig": ["POST"], "/theme/getThemeConfig": ["POST"],
  "/plugin/types": ["GET"], "/plugin/getPlugins": ["GET"], "/plugin/upload": ["POST"], "/plugin/delete": ["POST"], "/plugin/install": ["POST"],
  "/plugin/uninstall": ["POST"], "/plugin/enable": ["POST"], "/plugin/disable": ["POST"], "/plugin/config": ["GET", "POST"], "/plugin/upgrade": ["POST"],
  "/traffic-reset/logs": ["GET"], "/traffic-reset/stats": ["GET"], "/traffic-reset/reset-user": ["POST"]
};

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
  const explicit = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'internal_sync_token'").first<{ value: string }>();
  if (explicit?.value) return explicit.value;
  const serverToken = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'server_token'").first<{ value: string }>();
  return serverToken?.value || "";
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
  return ["/server/", "/user/", "/plan/", "/route/", "/group/"].some(part => pathname.includes(part));
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
  const marker = await optionalKvGet(env, "bootstrap:edge:v10");
  if (marker) return;
  try {
    const persisted = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'system_bootstrap_edge_version'").first<{ value: string }>();
    if (persisted?.value === "v10") {
      await optionalKvPut(env, "bootstrap:edge:v10", String(now()));
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
    "ALTER TABLE v2_gift_card_usage ADD COLUMN template_id INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN invite_user_id INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN user_level_at_use INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN plan_id_at_use INTEGER",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN ip_address TEXT",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN user_agent TEXT",
    "ALTER TABLE v2_gift_card_usage ADD COLUMN notes TEXT"
  ];
  for (const sql of alters) await runSqlIgnore(env, sql);
  await runSqlIgnore(env, "UPDATE v2_stat_user SET server_rate = COALESCE(rate, 1)");
  await runSqlIgnore(env, "CREATE INDEX IF NOT EXISTS idx_machine_load_recorded ON v2_server_machine_load_history(machine_id, recorded_at)");
  for (const sql of [
    "CREATE INDEX IF NOT EXISTS idx_gift_template_type_status ON v2_gift_card_template(type, status)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_template_id ON v2_gift_card_code(template_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_status ON v2_gift_card_code(status)",
    "CREATE INDEX IF NOT EXISTS idx_gift_code_batch_id ON v2_gift_card_code(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_user_usage ON v2_gift_card_usage(user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_gift_usage_template_stats ON v2_gift_card_usage(template_id, created_at)"
  ]) await runSqlIgnore(env, sql);
  await runSqlIgnore(env, "UPDATE v2_gift_card_code SET status = 3 WHERE status = 'disabled'");
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS v2_invite_code (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE, status INTEGER NOT NULL DEFAULT 0, pv INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS v2_mail_log (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, subject TEXT NOT NULL, template_name TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS v2_plugins (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, version TEXT NOT NULL, type TEXT, is_enabled INTEGER NOT NULL DEFAULT 0, config TEXT, installed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS failed_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, connection TEXT NOT NULL, queue TEXT NOT NULL, payload TEXT NOT NULL, exception TEXT NOT NULL, failed_at INTEGER NOT NULL)"
  ]) await runSqlIgnore(env, sql);
  const ts = now();
  const settingsDefaults: Record<string, any> = {
    app_name: "XBoard CF", app_description: "XBoard Cloudflare-native panel", app_url: "", logo: "", subscribe_url: "",
    subscribe_path: "s", frontend_admin_path: "admin", secure_path: "admin", frontend_theme: "Xboard",
    frontend_theme_sidebar: "light", frontend_theme_header: "dark", frontend_theme_color: "default",
    currency: "CNY", currency_symbol: "¥", try_out_plan_id: 1, try_out_hour: 24,
    plan_change_enable: 1, reset_traffic_method: 0, surplus_enable: 1, default_remind_expire: 1, default_remind_traffic: 1,
    server_token: "xboard-cf-server-token-change-me", server_pull_interval: 60, server_push_interval: 60, server_ws_enable: 1,
    server_ws_url: "", device_limit_mode: 0, payment_enabled: 0, invite_force: 0, invite_commission: 10,
    invite_gen_limit: 5, invite_never_expire: 0, commission_first_time_enable: 1, commission_auto_check_enable: 1,
    commission_withdraw_limit: 100, commission_withdraw_method: ["USDT", "支付宝"], email_verify: 0, safe_mode_enable: 0,
    email_whitelist_enable: 0, email_whitelist_suffix: ["gmail.com", "qq.com", "163.com"], email_gmail_limit_enable: 0,
    captcha_enable: 0, captcha_type: "recaptcha", recaptcha_key: "", recaptcha_site_key: "", recaptcha_v3_secret_key: "",
    recaptcha_v3_site_key: "", recaptcha_v3_score_threshold: 0.5, turnstile_secret_key: "", turnstile_site_key: "",
    register_limit_by_ip_enable: 0, register_limit_count: 3, register_limit_expire: 60, password_limit_enable: 1,
    password_limit_count: 5, password_limit_expire: 60, resend_api_url: "https://api.resend.com", resend_api_key: "",
    resend_from_address: "", resend_from_name: "XBoard", email_host: "https://api.resend.com", email_port: "443", email_username: "XBoard",
    email_password: "", email_from_address: "", remind_mail_enable: 0,
    telegram_bot_enable: 0, telegram_bot_token: "", telegram_webhook_url: "", telegram_discuss_link: "",
    windows_version: "", windows_download_url: "", macos_version: "", macos_download_url: "", android_version: "", android_download_url: ""
  };
  for (const [name, value] of Object.entries(settingsDefaults)) {
    await runSqlIgnore(env, "INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = CASE WHEN v2_settings.value IS NULL OR v2_settings.value = '' THEN excluded.value ELSE v2_settings.value END, updated_at = excluded.updated_at",
      [name, typeof value === "object" ? JSON.stringify(value) : String(value), ts, ts]);
  }
  await runSqlIgnore(env, "INSERT INTO v2_server_group(id, name, created_at, updated_at) VALUES (1, 'Default', ?, ?) ON CONFLICT(id) DO NOTHING", [ts, ts]);
  await runSqlIgnore(env, "INSERT INTO v2_plan(id, group_id, transfer_enable, name, speed_limit, device_limit, capacity_limit, reset_traffic_method, prices, content, tags, show, sell, renew, sort, created_at, updated_at) VALUES (1, 1, 1024, 'Default Trial', NULL, NULL, NULL, 0, '{}', 'Default seeded plan for first-run compatibility.', '[]', 1, 1, 1, 1, ?, ?) ON CONFLICT(id) DO NOTHING", [ts, ts]);
  await runSqlIgnore(env, "INSERT INTO v2_user(email, password, password_algo, password_salt, uuid, token, transfer_enable, u, d, banned, is_admin, is_staff, plan_id, group_id, remind_expire, remind_traffic, created_at, updated_at) VALUES ('admin@admin.com', ?, 'pbkdf2', 'xboard-cloudflare-admin', '00000000-0000-4000-8000-000000000001', 'admin-default-token-change-me', 1099511627776, 0, 0, 0, 1, 1, 1, 1, 1, 1, ?, ?) ON CONFLICT(email) DO UPDATE SET password = excluded.password, password_algo = excluded.password_algo, password_salt = excluded.password_salt, banned = 0, is_admin = 1, is_staff = 1, plan_id = COALESCE(v2_user.plan_id, excluded.plan_id), group_id = COALESCE(v2_user.group_id, excluded.group_id), transfer_enable = CASE WHEN v2_user.transfer_enable = 0 THEN excluded.transfer_enable ELSE v2_user.transfer_enable END, remind_expire = 1, remind_traffic = 1, updated_at = excluded.updated_at", [DEFAULT_ADMIN_PASSWORD_HASH, ts, ts]);
  await runSqlIgnore(env, "INSERT INTO v2_notice(id, title, content, show, sort, created_at, updated_at) VALUES (1, 'Welcome to XBoard CF', 'The Cloudflare-native XBoard panel is ready.', 1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, show = excluded.show, updated_at = excluded.updated_at", [ts, ts]);
  await runSqlIgnore(env, "INSERT INTO v2_knowledge(id, category, title, body, show, sort, created_at, updated_at) VALUES (1, 'Getting Started', 'First-run checklist', 'Update the default administrator password, configure app_url, and add real nodes before production use.', 1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title, body = excluded.body, show = excluded.show, updated_at = excluded.updated_at", [ts, ts]);
  for (const [name, subject, content] of [
    ["notify", "Notification from {{app.name}}", "{{content}}"],
    ["verify", "Email verification code", "Your verification code is {{code}}."],
    ["remind_expire", "Service expiry reminder", "Your service is about to expire."],
    ["remind_traffic", "Traffic usage reminder", "Your traffic usage is high."]
  ]) {
    await runSqlIgnore(env, "INSERT INTO v2_mail_templates(name, subject, content, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, content = excluded.content, enabled = excluded.enabled, updated_at = excluded.updated_at", [name, subject, content, ts, ts]);
  }
  for (const [name, content] of Object.entries(defaultSubscribeTemplates)) {
    await runSqlIgnore(env, "INSERT INTO v2_subscribe_templates(name, type, content, template, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET content = CASE WHEN v2_subscribe_templates.content IS NULL OR v2_subscribe_templates.content = '' THEN excluded.content ELSE v2_subscribe_templates.content END, template = CASE WHEN v2_subscribe_templates.template IS NULL OR v2_subscribe_templates.template = '' THEN excluded.template ELSE v2_subscribe_templates.template END, enabled = 1, updated_at = excluded.updated_at", [name, name, content, content, ts, ts]);
    await runSqlIgnore(env, "INSERT INTO v2_subscribe_templates(name, content, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = CASE WHEN v2_subscribe_templates.content IS NULL OR v2_subscribe_templates.content = '' THEN excluded.content ELSE v2_subscribe_templates.content END, updated_at = excluded.updated_at", [name, content, ts, ts]);
  }
  await runSqlIgnore(env, "INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES ('system_bootstrap_edge_version', 'v10', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [ts, ts]);
  await optionalKvPut(env, "bootstrap:edge:v10", String(ts));
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

async function adminConfig(env: Env, request: Request) {
  const all = await settings(env.XBOARD_DB);
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
      server_pull_interval: pickSetting(all, "server_pull_interval", 60),
      server_push_interval: pickSetting(all, "server_push_interval", 60),
      device_limit_mode: Number(pickSetting(all, "device_limit_mode", 0)),
      server_ws_enable: !!pickSetting(all, "server_ws_enable", 1),
      server_ws_url: pickSetting(all, "server_ws_url", "")
    },
    email: {
      email_host: pickSetting(all, "resend_api_url", pickSetting(all, "email_host", "https://api.resend.com")),
      email_port: 443,
      email_username: pickSetting(all, "resend_from_name", pickSetting(all, "email_username", pickSetting(all, "app_name", "XBoard"))),
      email_password: pickSetting(all, "resend_api_key", pickSetting(all, "email_password", "")),
      email_from_address: pickSetting(all, "resend_from_address", pickSetting(all, "email_from_address", "")),
      resend_api_url: pickSetting(all, "resend_api_url", "https://api.resend.com"),
      resend_api_key: pickSetting(all, "resend_api_key", ""),
      resend_from_address: pickSetting(all, "resend_from_address", ""),
      resend_from_name: pickSetting(all, "resend_from_name", pickSetting(all, "app_name", "XBoard")),
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
    banned: Boolean(Number(row.banned || 0)),
    is_admin: Boolean(Number(row.is_admin || 0)),
    is_staff: Boolean(Number(row.is_staff || 0)),
    remind_expire: Boolean(Number(row.remind_expire || 0)),
    remind_traffic: Boolean(Number(row.remind_traffic || 0)),
    commission_auto_check: Boolean(Number(row.commission_auto_check || 0)),
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
  const configured = await env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('subscribe_url', 'subscribe_path')").all<{ name: string; value: string }>();
  const values = Object.fromEntries((configured.results || []).map(row => [row.name, row.value || ""]));
  const configuredBase = String(values.subscribe_url || new URL(request.url).origin).split(",").map(value => value.trim()).filter(Boolean)[0];
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(configuredBase) ? configuredBase : `https://${configuredBase}`;
  const path = String(values.subscribe_path || "s").replace(/^\/+|\/+$/g, "") || "s";
  return `${base.replace(/\/$/, "")}/${path}/${userToken}`;
}

async function guestApi(request: Request, env: Env, path: string) {
  if (request.method === "POST" && path === "/api/v1/guest/telegram/webhook") {
    const all = await settings(env.XBOARD_DB); const botToken = String(pickSetting(all, "telegram_bot_token", ""));
    if (new URL(request.url).searchParams.get("access_token") !== md5(botToken)) return fail("access_token is error", 401, 401);
    const update = await body<Record<string, any>>(request);
    const join = update.chat_join_request;
    if (join?.chat?.id && join?.from?.id) {
      const user = await env.XBOARD_DB.prepare("SELECT banned,expired_at,transfer_enable,u,d FROM v2_user WHERE telegram_id = ?").bind(Number(join.from.id)).first<Record<string, any>>();
      const available = !!user && !Number(user.banned) && (!user.expired_at || Number(user.expired_at) > now()) && (!Number(user.transfer_enable) || Number(user.u || 0) + Number(user.d || 0) < Number(user.transfer_enable));
      try { await telegramRequest(botToken, available ? "approveChatJoinRequest" : "declineChatJoinRequest", { chat_id: join.chat.id, user_id: join.from.id }); } catch (error: any) { return fail(error?.message || "Telegram request failed", 400, 400); }
    }
    return ok(true);
  }
  if (request.method === "GET" && path === "/api/v1/guest/plan/fetch") {
    return ok((await adminPlanRows(env)).filter(row => Number((row as any).show ?? 1) === 1 && Number((row as any).sell ?? 1) === 1));
  }
  if (request.method === "GET" && path === "/api/v1/guest/comm/config") {
    const all = await settings(env.XBOARD_DB);
    return ok({
      tos_url: pickSetting(all, "tos_url", ""),
      is_email_verify: Number(Boolean(pickSetting(all, "email_verify", 0))),
      is_invite_force: Number(Boolean(pickSetting(all, "invite_force", 0))),
      email_whitelist_suffix: pickSetting(all, "email_whitelist_enable", 0) ? pickSetting(all, "email_whitelist_suffix", []) : 0,
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
  const all = await settings(env.XBOARD_DB);
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
    const subscription = new URL(await subscribeUrl(request, env, String(user.token)));
    subscription.searchParams.set("flag", "clash");
    const response = await fetch(subscription, { headers: { "user-agent": request.headers.get("user-agent") || "Clash" } });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
  if (request.method === "GET" && path === "/api/v2/client/app/getConfig") {
    return ok({
      app_info: {
        app_name: pickSetting(all, "app_name", "XB加速器"),
        app_description: pickSetting(all, "app_description", "专业的网络加速服务"),
        app_url: pickSetting(all, "app_url", ""),
        logo: pickSetting(all, "logo", ""),
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
      last_updated: now()
    });
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
  return true;
}

function dayStart(ts = now()) {
  const date = new Date(ts * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
}

function monthStart(ts = now()) {
  const date = new Date(ts * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

async function adminStats(env: Env) {
  const today = dayStart();
  const month = monthStart();
  const lastMonthDate = new Date(month * 1000);
  lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonth = Math.floor(lastMonthDate.getTime() / 1000);
  const totalUsers = await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_user");
  const activeUsers = await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_user WHERE banned = 0");
  const currentMonthNewUsers = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${month}`);
  const lastMonthNewUsers = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${lastMonth} AND created_at < ${month}`);
  const monthUpload = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_user WHERE record_at >= ${month}`);
  const monthDownload = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_user WHERE record_at >= ${month}`);
  const todayUpload = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_user WHERE record_at >= ${today}`);
  const todayDownload = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_user WHERE record_at >= ${today}`);
  const userGrowth = lastMonthNewUsers > 0 ? Math.round(((currentMonthNewUsers - lastMonthNewUsers) / lastMonthNewUsers) * 100) : currentMonthNewUsers > 0 ? 100 : 0;
  return {
    todayIncome: 0,
    currentMonthIncome: 0,
    dayIncomeGrowth: 0,
    monthIncomeGrowth: 0,
    ticketPendingTotal: await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_ticket WHERE status = 0"),
    commissionPendingTotal: 0,
    currentMonthNewUsers,
    userGrowth,
    totalUsers,
    activeUsers,
    monthTraffic: { upload: monthUpload, download: monthDownload },
    todayTraffic: { upload: todayUpload, download: todayDownload }
  };
}

function dateString(ts: number) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function orderStats(url: URL) {
  const end = url.searchParams.get("end_date") || dateString(now());
  const start = url.searchParams.get("start_date") || end;
  return {
    summary: {
      start_date: start,
      end_date: end,
      paid_total: 0,
      paid_count: 0,
      avg_paid_amount: 0,
      commission_total: 0,
      commission_count: 0,
      commission_rate: 0
    },
    list: [{ date: start, paid_total: 0, paid_count: 0, commission_total: 0, commission_count: 0 }]
  };
}

async function trafficRank(env: Env, url: URL) {
  const type = url.searchParams.get("type") || "user";
  const start = Number(url.searchParams.get("start_time") || 0);
  const end = Number(url.searchParams.get("end_time") || now());
  if (type === "node") {
    try {
      const rows = await env.XBOARD_DB.prepare(
        "SELECT s.name AS name, COALESCE(SUM(ss.u + ss.d), 0) AS value FROM v2_stat_server ss LEFT JOIN v2_server s ON s.id = ss.server_id WHERE ss.record_at >= ? AND ss.record_at <= ? GROUP BY ss.server_id ORDER BY value DESC LIMIT 10"
      ).bind(start, end).all<{ name: string; value: number }>();
      return (rows.results || []).map(row => ({ name: row.name || "Node", value: Number(row.value || 0), change: 0 }));
    } catch {
      return [];
    }
  }
  try {
    const rows = await env.XBOARD_DB.prepare(
      "SELECT u.email AS name, COALESCE(SUM(su.u + su.d), 0) AS value FROM v2_stat_user su LEFT JOIN v2_user u ON u.id = su.user_id WHERE su.record_at >= ? AND su.record_at <= ? GROUP BY su.user_id ORDER BY value DESC LIMIT 10"
    ).bind(start, end).all<{ name: string; value: number }>();
    return (rows.results || []).map(row => ({ name: row.name || "User", value: Number(row.value || 0), change: 0 }));
  } catch {
    return [];
  }
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

async function adminUserList(env: Env, request: Request) {
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  const url = new URL(request.url);
  const page = Number(input.page || input.current || url.searchParams.get("page") || 1);
  const pageSize = Number(input.page_size || input.pageSize || input.limit || url.searchParams.get("page_size") || 20);
  const result = await list(env.XBOARD_DB, "v2_user", page, pageSize);
  const data = [];
  for (const row of result.data as any[]) {
    const plan = await planById(env, row.plan_id);
    const group = await groupById(env, row.group_id);
    data.push({
      ...safeUser(row),
      balance: Number(row.balance || 0) / 100,
      commission_balance: Number(row.commission_balance || 0) / 100,
      commission_type: Number(row.commission_type ?? 0),
      total_used: Number(row.u || 0) + Number(row.d || 0),
      used_traffic: Number(row.u || 0) + Number(row.d || 0),
      subscribe_url: await subscribeUrl(request, env, row.token),
      plan,
      group,
      invite_user: null,
      online_count: 0
    });
  }
  return paginated(data, Number(result.total || data.length), page, pageSize);
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

async function optionalKvGet(env: Env, key: string) {
  try { return await env.XBOARD_KV.get(key); } catch { return null; }
}

async function optionalKvPut(env: Env, key: string, value: string) {
  try { await env.XBOARD_KV.put(key, value); } catch { /* D1 remains the source of truth when KV is unavailable. */ }
}

async function optionalKvPutTtl(env: Env, key: string, value: string, expirationTtl: number) {
  try { await env.XBOARD_KV.put(key, value, { expirationTtl }); } catch { /* Verification mail can still be queued when KV is temporarily unavailable. */ }
}

async function adminServerRows(env: Env) {
  const servers = await rows(env.XBOARD_DB, "v2_server", 1000) as any[];
  const machines = await rows(env.XBOARD_DB, "v2_server_machine", 1000) as any[];
  const out = [];
  for (const server of servers) {
    const stateId = Number(server.parent_id || server.id);
    const ownId = Number(server.id);
    const machine = Number(server.machine_id) > 0 ? machines.find(item => Number(item.id) === Number(server.machine_id)) : null;
    const readState = async (key: string) => {
      const inherited = await optionalKvGet(env, `node:${key}:${stateId}`);
      return inherited ?? (stateId !== ownId ? await optionalKvGet(env, `node:${key}:${ownId}`) : null);
    };
    const [kvLastCheck, kvLastPush, kvOnline, kvLoad, kvMetrics, kvMachineLoad] = await Promise.all([
      readState("last_check"),
      readState("last_push"),
      readState("online"),
      readState("load"),
      readState("metrics"),
      machine ? optionalKvGet(env, `machine:load:${machine.id}`) : Promise.resolve(null)
    ]);
    const machineSeenAt = machine && Number(machine.is_active ?? machine.enabled ?? 1) === 1 ? Number(machine.last_seen_at || 0) : 0;
    const machineOnline = machineSeenAt > 0 && now() - 300 < machineSeenAt;
    const lastCheckAt = Math.max(Number(kvLastCheck || server.last_check_at || 0), machineOnline ? machineSeenAt : 0) || null;
    const lastPushAt = Math.max(Number(kvLastPush || server.last_push_at || 0), machineOnline ? machineSeenAt : 0) || null;
    const availableStatus = nodeAvailableStatus(lastCheckAt, lastPushAt);
    const loadStatus = parseKvObject(kvLoad) || parseKvObject(kvMachineLoad) || (machine?.load_status ? parseJsonObject(machine.load_status) : null);
    const metrics = parseKvObject(kvMetrics) || parseKvObject(server.metrics) || (loadStatus?.metrics && typeof loadStatus.metrics === "object" ? loadStatus.metrics : null);
    const groupIds = parseJsonArray(server.group_ids);
    const groups = [];
    for (const id of groupIds) {
      const group = await groupById(env, id);
      if (group) groups.push(group);
    }
    out.push({
      ...server,
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
      online: Number(kvOnline ?? server.online_user ?? 0),
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
  const machines = await rows(env.XBOARD_DB, "v2_server_machine", 1000) as any[];
  const out = [];
  for (const machine of machines) {
    out.push({
      ...machine,
      notes: machine.notes || "",
      is_active: Boolean(Number(machine.is_active ?? machine.enabled ?? 1)),
      last_seen_at: machine.last_seen_at || null,
      load_status: machine.load_status ? parseJsonObject(machine.load_status) : null,
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

  let query = "SELECT cpu, mem_total, mem_used, disk_total, disk_used, net_in_speed, net_out_speed, recorded_at FROM v2_server_machine_load_history WHERE machine_id = ?";
  const bindings: Array<number> = [machineId];
  if (rangeHours !== null) {
    query += " AND recorded_at >= ?";
    bindings.push(now() - rangeHours * 3600);
  }
  query += " ORDER BY recorded_at DESC LIMIT ?";
  bindings.push(limit);

  const result = await env.XBOARD_DB.prepare(query).bind(...bindings).all<Record<string, unknown>>();
  const history = (result.results || []).reverse().map(row => ({
    cpu: Number(row.cpu || 0),
    mem_total: Number(row.mem_total || 0),
    mem_used: Number(row.mem_used || 0),
    disk_total: Number(row.disk_total || 0),
    disk_used: Number(row.disk_used || 0),
    net_in_speed: row.net_in_speed === null || row.net_in_speed === undefined ? null : Number(row.net_in_speed),
    net_out_speed: row.net_out_speed === null || row.net_out_speed === undefined ? null : Number(row.net_out_speed),
    recorded_at: Number(row.recorded_at || 0)
  }));
  return ok(history);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function machineInstallCommand(request: Request, env: Env, machineToken: string, machineId: number) {
  const configured = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'app_url'").first<{ value: string }>();
  const panelUrl = String(configured?.value || new URL(request.url).origin).replace(/\/$/, "");
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

function normalizeServerInput(input: Record<string, any>) {
  const protocolSettings = parseJsonObject(input.protocol_settings);
  const serverType = String(input.type || input.server_type || protocolSettings.type || "shadowsocks");
  const port = Number(isNilLike(input.port) ? input.server_port || 443 : input.port);
  const serverPort = Number(isNilLike(input.server_port) ? input.port || 443 : input.server_port);
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

async function saveServer(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
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
      return fail(`保存服务器失败: ${fallbackError?.message || error?.message || "D1 写入失败"}`, 500, 500);
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
  await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id = ?`).bind(...Object.values(data), now(), id).run();
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
  server.name = `${server.name || "Node"} Copy`;
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
  const planId = nullableNumber(input.plan_id);
  const plan = planId ? await env.XBOARD_DB.prepare("SELECT id, group_id FROM v2_plan WHERE id = ?").bind(planId).first<Record<string, any>>() : null;
  if (planId && !plan) return fail("订阅计划不存在", 400, 400202);
  const generated: Record<string, any>[] = [];
  const ts = now();
  for (let index = 1; index <= count; index++) {
    const local = prefix ? (count > 1 ? `${prefix}_${index}` : prefix) : randomString(6).toLowerCase();
    const email = `${local}@${suffix}`;
    if (await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE email = ?").bind(email).first()) return fail(`邮箱 ${email} 已存在于系统中`, 400, 400201);
    const password = String(input.password || email);
    const userUuid = uuid();
    const userToken = token(16);
    const result = await env.XBOARD_DB.prepare(`INSERT INTO v2_user(email, password, uuid, token, plan_id, group_id, expired_at, transfer_enable, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      email, await hashPassword(password), userUuid, userToken, planId, plan?.group_id ?? null,
      nullableNumber(input.expired_at), Number(planId ? (await env.XBOARD_DB.prepare("SELECT transfer_enable FROM v2_plan WHERE id = ?").bind(planId).first<any>())?.transfer_enable || 0 : 0), ts, ts
    ).run();
    generated.push({ id: Number((result.meta as any)?.last_row_id || 0), email, password, expired_at: input.expired_at || null, uuid: userUuid, created_at: ts, subscribe_url: await subscribeUrl(request, env, userToken) });
  }
  if (input.download_csv) return csvResponse("users.csv", [["账号", "密码", "过期时间", "UUID", "创建时间", "订阅地址"], ...generated.map(user => [user.email, user.password, user.expired_at || "长期有效", user.uuid, user.created_at, user.subscribe_url])]);
  return json({ code: 0, message: count > 1 ? "批量生成成功" : "生成成功", data: count > 1 ? generated : true });
}

async function dumpAdminUsers(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const ids = parseJsonArray(input.user_ids || input.ids).map(Number).filter(Boolean);
  const scope = String(input.scope || (ids.length ? "selected" : "all"));
  if (scope === "selected" && !ids.length) return fail("user_ids不能为空", 422, 422);
  const query = `SELECT u.*, p.name AS plan_name FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id${scope === "selected" ? ` WHERE u.id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY u.id ASC`;
  const result = scope === "selected" ? await env.XBOARD_DB.prepare(query).bind(...ids).all<Record<string, any>>() : await env.XBOARD_DB.prepare(query).all<Record<string, any>>();
  const output: unknown[][] = [["邮箱", "余额", "推广佣金", "总流量", "剩余流量", "套餐到期时间", "订阅计划", "订阅地址"]];
  for (const user of result.results || []) output.push([
    user.email, (Number(user.balance || 0) / 100).toFixed(2), (Number(user.commission_balance || 0) / 100).toFixed(2),
    Number(user.transfer_enable || 0), Math.max(0, Number(user.transfer_enable || 0) - Number(user.u || 0) - Number(user.d || 0)),
    user.expired_at || "长期有效", user.plan_name || "无订阅", await subscribeUrl(request, env, user.token)
  ]);
  return csvResponse(`users_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.csv`, output);
}

async function batchUpdateServers(request: Request, env: Env) {
  const input = await body<Record<string, any>>(request);
  const ids = parseJsonArray(input.ids || input.server_ids).map(Number).filter(Boolean);
  if (!ids.length) return fail("ids不能为空", 422, 422);
  const columns = await tableColumns(env, "v2_server");
  const source = input.data && typeof input.data === "object" ? input.data : input;
  const allowed = Object.entries(source).filter(([key]) => columns.has(key) && !["id", "ids", "server_ids", "created_at", "updated_at", "u", "d"].includes(key));
  if (!allowed.length) return fail("没有可更新字段", 422, 422);
  const set = allowed.map(([key]) => `${key} = ?`).join(", ");
  for (const id of ids) await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id = ?`).bind(...allowed.map(([, value]) => bindValue(value)), now(), id).run();
  await bump(env.XBOARD_KV, "servers_version");
  return ok(true);
}

async function audit(env: Env, adminId: number, request: Request, path: string) {
  if (request.method !== "POST" && request.method !== "DELETE") return;
  try {
    await env.XBOARD_DB.prepare("INSERT INTO v2_admin_audit_log(admin_id, action, target, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(adminId, request.method, path, "{}", request.headers.get("cf-connecting-ip") || "", now()).run();
  } catch {
    // Audit logging must never break admin operations.
  }
}

const mailTemplateMeta: Record<string, { label: string; required_vars: string[]; optional_vars: string[] }> = {
  verify: { label: "邮箱验证码", required_vars: ["name", "code", "url"], optional_vars: [] },
  notify: { label: "站点通知", required_vars: ["name", "content", "url"], optional_vars: [] },
  remind_expire: { label: "服务到期提醒", required_vars: ["name", "url"], optional_vars: [] },
  remind_traffic: { label: "流量使用提醒", required_vars: ["name", "url"], optional_vars: [] }
};

const mailTemplateDefaults: Record<string, { subject: string; content: string }> = {
  verify: { subject: "{{name}} - 邮箱验证码", content: "您的验证码是：{{code}}。返回 {{url}}" },
  notify: { subject: "{{name}} - 站点通知", content: "{{content}}\n\n{{url}}" },
  remind_expire: { subject: "{{name}} - 服务即将到期", content: "您的服务即将到期，请及时续费。{{url}}" },
  remind_traffic: { subject: "{{name}} - 流量使用提醒", content: "您的流量使用量已接近上限。{{url}}" }
};

async function adminMailTemplateList(env: Env) {
  const result = await env.XBOARD_DB.prepare("SELECT name, subject, updated_at FROM v2_mail_templates").all<Record<string, any>>();
  const templates = new Map((result.results || []).map(row => [String(row.name), row]));
  return Object.entries(mailTemplateMeta).map(([name, meta]) => ({
    name,
    label: meta.label,
    customized: templates.has(name),
    subject: templates.get(name)?.subject || null,
    updated_at: templates.get(name)?.updated_at || null
  }));
}

async function adminMailTemplateGet(env: Env, name: string) {
  const meta = mailTemplateMeta[name];
  if (!meta) return null;
  const row = await env.XBOARD_DB.prepare("SELECT name, subject, content FROM v2_mail_templates WHERE name = ?").bind(name).first<Record<string, any>>();
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
  await env.MAIL_EVENTS.send({
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
  return queueMail(env, {
    to: email,
    subject: renderMailText(subjectOverride || template.subject, vars),
    content: renderMailText(template.content, vars),
    template_name: name
  });
}

async function sendTestMail(env: Env, email: string) {
  const all = await settings(env.XBOARD_DB);
  const template = await adminMailTemplateGet(env, "notify");
  const endpoint = String(pickSetting(all, "resend_api_url", "https://api.resend.com")).replace(/\/$/, "");
  const apiKey = String(pickSetting(all, "resend_api_key", ""));
  const fromAddress = String(pickSetting(all, "resend_from_address", ""));
  const fromName = String(pickSetting(all, "resend_from_name", pickSetting(all, "app_name", "XBoard")));
  const subject = "This is xboard test email";
  const vars = { name: pickSetting(all, "app_name", "XBoard"), content: subject, url: pickSetting(all, "app_url", "") };
  const content = renderMailText(template?.content || mailTemplateDefaults.notify.content, vars);
  const config = {
    driver: "resend",
    host: endpoint,
    port: 443,
    encryption: "HTTPS/TLS",
    from: { address: fromAddress, name: fromName },
    username: fromName
  };
  let error: string | null = null;
  try {
    if (!apiKey) throw new Error("Resend API Key 未配置");
    if (!fromAddress) throw new Error("Resend 发件人地址未配置");
    const response = await fetch(`${endpoint}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `${fromName} <${fromAddress}>`, to: [email], subject, html: mailHtml(content), text: content })
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Resend ${response.status}: ${responseText.slice(0, 500)}`);
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
  const page = Math.max(1, Number(input.page || url.searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.page_size || input.per_page || url.searchParams.get("page_size") || 20)));
  const offset = (page - 1) * pageSize;
  const result = await env.XBOARD_DB.prepare("SELECT l.*, u.email AS admin_email FROM v2_admin_audit_log l LEFT JOIN v2_user u ON u.id = l.admin_id ORDER BY l.id DESC LIMIT ? OFFSET ?").bind(pageSize, offset).all();
  const total = await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_admin_audit_log");
  return paginated((result.results || []) as Record<string, any>[], total, page, pageSize);
}

async function trafficResetLogs(env: Env, request: Request) {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.min(10000, Math.max(1, Number(url.searchParams.get("per_page") || 20)));
  const offset = (page - 1) * pageSize;
  const result = await env.XBOARD_DB.prepare("SELECT l.*, u.email AS user_email FROM v2_traffic_reset_logs l LEFT JOIN v2_user u ON u.id = l.user_id ORDER BY l.reset_time DESC LIMIT ? OFFSET ?").bind(pageSize, offset).all<Record<string, any>>();
  const data = (result.results || []).map(row => ({
    ...row,
    old_traffic: { upload: Number(row.old_u || 0), download: Number(row.old_d || 0), total: Number(row.old_u || 0) + Number(row.old_d || 0) },
    new_traffic: { upload: 0, download: 0, total: 0 },
    trigger_source: parseJsonObject(row.metadata).trigger_source || "manual",
    metadata: parseJsonObject(row.metadata)
  }));
  const total = await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_traffic_reset_logs");
  return { data, pagination: { current_page: page, last_page: Math.max(1, Math.ceil(total / pageSize)), per_page: pageSize, total } };
}

async function resetUserTraffic(env: Env, request: Request, adminId: number) {
  const input = await body<Record<string, any>>(request);
  const userId = nullableNumber(input.user_id);
  if (!userId) return fail("user_id 字段是必须的", 422, 422);
  const user = await env.XBOARD_DB.prepare("SELECT id, email, u, d, reset_count, next_reset_at FROM v2_user WHERE id = ?").bind(userId).first<Record<string, any>>();
  if (!user) return fail("用户不存在", 404, 404);
  const ts = now();
  const metadata = JSON.stringify({ reason: input.reason || "", admin_id: adminId, trigger_source: "manual" });
  await env.XBOARD_DB.batch([
    env.XBOARD_DB.prepare("INSERT INTO v2_traffic_reset_logs(user_id, reset_type, old_u, old_d, metadata, reset_time, created_at) VALUES (?, 'manual', ?, ?, ?, ?, ?)").bind(userId, Number(user.u || 0), Number(user.d || 0), metadata, ts, ts),
    env.XBOARD_DB.prepare("UPDATE v2_user SET u = 0, d = 0, reset_count = COALESCE(reset_count, 0) + 1, last_reset_at = ?, updated_at = ? WHERE id = ?").bind(ts, ts, userId)
  ]);
  await bump(env.XBOARD_KV, `user_version:${userId}`);
  return json({ message: "重置成功", data: { user_id: userId, email: user.email, reset_time: ts, next_reset_at: user.next_reset_at } });
}

async function login(request: Request, env: Env, admin = false) {
  const input = await body<any>(request);
  const email = String(input.email || input.username || "").trim().toLowerCase();
  const password = String(input.password || "");
  const all = await settings(env.XBOARD_DB); const limitEnabled = !!pickSetting(all, "password_limit_enable", 1);
  const limit = Math.max(1, Number(pickSetting(all, "password_limit_count", 5))); const windowSeconds = Math.max(60, Number(pickSetting(all, "password_limit_expire", 60)) * 60);
  const rateKey = `rate:login:${email}`; const attempts = Number(await optionalKvGet(env, rateKey) || 0);
  if (limitEnabled && attempts >= limit) return fail("登录尝试次数过多，请稍后再试", 429, 429);
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE email = ?").bind(email).first<any>();
  if (!user || (admin && Number(user.is_admin) !== 1) || !(await verifyPassword(password, String(user?.password || "")))) {
    if (limitEnabled) await optionalKvPutTtl(env, rateKey, String(attempts + 1), windowSeconds);
    return fail("账号或密码错误", 401, 401);
  }
  if (Number(user.banned || 0) === 1) return fail("账号已被封禁", 403, 403);
  try { await env.XBOARD_KV.delete(rateKey); } catch {}
  const accessToken = await createSession(env.XBOARD_DB, env.XBOARD_KV, user, admin);
  await env.XBOARD_DB.prepare("UPDATE v2_user SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), user.id).run();
  return ok({ token: accessToken, is_admin: !!user.is_admin, email: user.email, auth_data: accessToken });
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
  if (table === "v2_settings") await bump(env.XBOARD_KV, "settings_version");
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
      const ticket = await env.XBOARD_DB.prepare("SELECT t.*, u.email, u.plan_id, u.group_id FROM v2_ticket t JOIN v2_user u ON u.id = t.user_id WHERE t.id = ?").bind(id).first<Record<string, any>>();
      if (!ticket) return fail("工单不存在", 400, 400202);
      const messages = await env.XBOARD_DB.prepare("SELECT m.*, u.email FROM v2_ticket_message m LEFT JOIN v2_user u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id ASC").bind(id).all();
      return ok({ ...ticket, user: { id: ticket.user_id, email: ticket.email, plan_id: ticket.plan_id, group_id: ticket.group_id }, messages: messages.results || [] });
    }
    const current = Math.max(1, Number(input.current || url.searchParams.get("current") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || url.searchParams.get("pageSize") || 10)));
    const status = input.status ?? url.searchParams.get("status");
    const email = String(input.email ?? url.searchParams.get("email") ?? "").trim();
    const clauses: string[] = []; const binds: any[] = [];
    if (status !== null && status !== undefined && status !== "") { clauses.push("t.status = ?"); binds.push(Number(status)); }
    if (email) { clauses.push("u.email = ?"); binds.push(email); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const result = await env.XBOARD_DB.prepare(`SELECT t.*, u.email, u.plan_id, u.group_id FROM v2_ticket t JOIN v2_user u ON u.id = t.user_id${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, (current - 1) * pageSize).all<Record<string, any>>();
    const count = await env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_ticket t JOIN v2_user u ON u.id = t.user_id${where}`).bind(...binds).first<{ count: number }>();
    return json({ data: (result.results || []).map(ticket => ({ ...ticket, user: { id: ticket.user_id, email: ticket.email, plan_id: ticket.plan_id, group_id: ticket.group_id } })), total: Number(count?.count || 0) });
  }
  if (!id) return fail("工单ID不能为空", 422, 422);
  const ticket = await env.XBOARD_DB.prepare("SELECT id, status FROM v2_ticket WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!ticket) return fail("工单不存在", 400, 400202);
  if (route === "/ticket/reply") {
    if (!String(input.message || "").trim()) return fail("消息不能为空", 422, 422);
    if (Number(ticket.status)) return fail("工单已关闭，无法回复", 400, 400);
    const ts = now();
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, is_admin, message, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)").bind(id, adminId, String(input.message), ts, ts),
      env.XBOARD_DB.prepare("UPDATE v2_ticket SET reply_status = 0, last_reply_user_id = ?, updated_at = ? WHERE id = ?").bind(adminId, ts, id)
    ]);
    return ok(true);
  }
  if (route === "/ticket/close") {
    await env.XBOARD_DB.prepare("UPDATE v2_ticket SET status = 1, updated_at = ? WHERE id = ?").bind(now(), id).run();
    return ok(true);
  }
  return null;
}

function couponValue(input: Record<string, any>, key: string) {
  return ["limit_plan_ids", "limit_period"].includes(key) ? JSON.stringify(parseJsonArray(input[key])) : input[key];
}

async function adminCoupon(request: Request, env: Env, route: string): Promise<Response | null> {
  if (!route.startsWith("/coupon/")) return null;
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  if (route === "/coupon/fetch") {
    const url = new URL(request.url); const current = Math.max(1, Number(input.current || url.searchParams.get("current") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || url.searchParams.get("pageSize") || 10)));
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_coupon ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(pageSize, (current - 1) * pageSize).all<Record<string, any>>();
    const total = await firstNumber(env, "SELECT COUNT(*) AS count FROM v2_coupon");
    return json({ data: (result.results || []).map(row => ({ ...row, show: !!row.show, limit_plan_ids: parseJsonArray(row.limit_plan_ids), limit_period: parseJsonArray(row.limit_period) })), total });
  }
  const id = nullableNumber(input.id);
  if (route === "/coupon/generate") {
    const required = ["name", "type", "value", "started_at", "ended_at"];
    if (required.some(key => input[key] === undefined || input[key] === "")) return fail("优惠券参数不完整", 422, 422);
    if (![1, 2].includes(Number(input.type))) return fail("类型格式有误", 422, 422);
    const count = Math.min(500, Math.max(1, Number(input.generate_count || 1))); const ts = now();
    const statements = Array.from({ length: count }, (_, index) => {
      const code = count === 1 && input.code ? String(input.code) : randomString(8);
      const values = [code, String(input.name), Number(input.type), Number(input.value), boolNumber(input.show, 1), nullableNumber(input.limit_use), nullableNumber(input.limit_use_with_user), couponValue(input, "limit_plan_ids"), couponValue(input, "limit_period"), Number(input.started_at), Number(input.ended_at), ts, ts];
      if (id && index === 0) return env.XBOARD_DB.prepare("UPDATE v2_coupon SET code=?, name=?, type=?, value=?, show=?, limit_use=?, limit_use_with_user=?, limit_plan_ids=?, limit_period=?, started_at=?, ended_at=?, updated_at=? WHERE id=?").bind(...values.slice(0, 11), ts, id);
      return env.XBOARD_DB.prepare("INSERT INTO v2_coupon(code,name,type,value,show,limit_use,limit_use_with_user,limit_plan_ids,limit_period,started_at,ended_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...values);
    });
    try { await env.XBOARD_DB.batch(statements); } catch { return fail("优惠券代码已存在或参数无效", 400, 400); }
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
  const all = await settings(env.XBOARD_DB); const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
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

async function adminApi(request: Request, env: Env, path: string) {
  const route = path.replace(/^\/api\/v2\/admin/, "");
  if (request.method === "POST" && route === "/passport/auth/login") return login(request, env, true);
  if (!adminRouteAllowed(route, request.method)) return json({ message: "Not Found" }, 404);
  const admin = await currentUser(request, env.XBOARD_DB, env.XBOARD_KV, true);
  if (!admin) return fail("未授权", 401, 401);
  await audit(env, Number((admin as any).id || 0), request, path);
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
  if (path.includes("/config/fetch")) return ok(await adminConfig(env, request));
  if (path.includes("/config/save")) {
    const input = await body<Record<string, any>>(request);
    const ts = now();
    for (const [name, value] of Object.entries(input)) {
      if (await saveSubscribeTemplate(env, name, value)) continue;
      const aliases: Record<string, string> = {
        email_host: "resend_api_url",
        email_username: "resend_from_name",
        email_password: "resend_api_key",
        email_from_address: "resend_from_address"
      };
      const settingName = aliases[name] || name;
      await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(settingName, typeof value === "object" ? JSON.stringify(value) : String(value), ts, ts).run();
    }
    await bump(env.XBOARD_KV, "settings_version");
    return ok(true);
  }
  if (request.method === "GET" && route === "/config/getEmailTemplate") return ok(["default"]);
  if (request.method === "GET" && route === "/config/getThemeTemplate") return ok(["default"]);
  if (request.method === "POST" && route === "/config/testSendMail") {
    return ok(await sendTestMail(env, String((admin as any).email)));
  }
  if (request.method === "POST" && route === "/config/setTelegramWebhook") {
    const input = await body<Record<string, any>>(request); const all = await settings(env.XBOARD_DB);
    const botToken = String(input.telegram_bot_token || pickSetting(all, "telegram_bot_token", ""));
    const custom = String(pickSetting(all, "telegram_webhook_url", "")).trim();
    const base = (custom || String(pickSetting(all, "app_url", "")) || new URL(request.url).origin).replace(/\/$/, "");
    const webhookBase = base.includes("/api/v1/guest/telegram/webhook") ? base : `${base}/api/v1/guest/telegram/webhook`;
    const webhookUrl = `${webhookBase}?access_token=${md5(botToken)}`;
    try {
      await telegramRequest(botToken, "getMe");
      await telegramRequest(botToken, "setWebhook", { url: webhookUrl });
      await telegramRequest(botToken, "setMyCommands", { commands: [{ command: "start", description: "Start" }, { command: "bind", description: "Bind account" }, { command: "traffic", description: "Traffic usage" }, { command: "subscribe", description: "Subscription" }] });
      return ok({ success: true, webhook_url: webhookUrl, webhook_base_url: webhookBase });
    } catch (error: any) { return fail(error?.message || "Telegram Webhook 设置失败", 400, 400); }
  }
  if (request.method === "GET" && route === "/stat/getOverride") {
    const nodes = await adminServerRows(env);
    const today = dayStart();
    const month = monthStart();
    const todayU = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${today}`);
    const todayD = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${today}`);
    const monthU = await firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${month}`);
    const monthD = await firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${month}`);
    const totalU = await firstNumber(env, "SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server");
    const totalD = await firstNumber(env, "SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server");
    return ok({
      month_income: 0,
      month_register_total: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${month}`),
      ticket_pending_total: await firstNumber(env, "SELECT COUNT(*) AS c FROM v2_ticket WHERE status = 0"),
      commission_pending_total: 0,
      day_income: 0,
      last_month_income: 0,
      commission_month_payout: 0,
      commission_last_month_payout: 0,
      online_nodes: nodes.filter(node => Number((node as any).available_status) > 0).length,
      online_devices: nodes.reduce((sum, node) => sum + Number((node as any).online_conn || 0), 0),
      online_users: nodes.reduce((sum, node) => sum + Number((node as any).online || 0), 0),
      today_traffic: { upload: todayU, download: todayD, total: todayU + todayD },
      month_traffic: { upload: monthU, download: monthD, total: monthU + monthD },
      total_traffic: { upload: totalU, download: totalD, total: totalU + totalD }
    });
  }
  if (path.includes("/stat/getStats")) return ok(await adminStats(env));
  if (path.includes("/stat/getOrder")) return ok(orderStats(new URL(request.url)));
  if (path.includes("/stat/getTrafficRank")) return ok(await trafficRank(env, new URL(request.url)));
  if (request.method === "GET" && (route === "/stat/getServerLastRank" || route === "/stat/getServerYesterdayRank")) {
    const start = route.endsWith("YesterdayRank") ? dayStart() - 86400 : monthStart();
    const end = route.endsWith("YesterdayRank") ? dayStart() - 1 : now();
    const url = new URL(request.url); url.searchParams.set("type", "node"); url.searchParams.set("start_time", String(start)); url.searchParams.set("end_time", String(end));
    return ok(await trafficRank(env, url));
  }
  if ((request.method === "GET" || request.method === "POST") && route === "/stat/getStatUser") {
    const input: Record<string, any> = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
    if (request.method === "GET") new URL(request.url).searchParams.forEach((value, key) => { input[key] = value; });
    const userId = nullableNumber(input.user_id);
    if (!userId) return fail("user_id 字段是必须的", 422, 422);
    const page = Math.max(1, Number(input.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || input.page_size || 10)));
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_stat_user WHERE user_id = ? ORDER BY record_at DESC LIMIT ? OFFSET ?").bind(userId, pageSize, (page - 1) * pageSize).all();
    const total = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_stat_user WHERE user_id = ${userId}`);
    return json({
      data: (result.results || []).map((row: any) => ({
        ...row,
        u: Number(row.u || 0),
        d: Number(row.d || 0),
        server_rate: Number(row.server_rate ?? row.rate ?? 1) || 1
      })),
      total
    });
  }
  if (request.method === "GET" && route === "/stat/getRanking") {
    const result = await env.XBOARD_DB.prepare("SELECT id, email, u, d, (u + d) AS total FROM v2_user ORDER BY total DESC LIMIT 20").all();
    return ok(result.results || []);
  }
  if (request.method === "GET" && route === "/stat/getStatRecord") {
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_stat ORDER BY record_at DESC LIMIT 90").all();
    return ok(result.results || []);
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
    const name = String(input.name || "");
    if (!mailTemplateMeta[name] || !input.subject || !input.content) return fail("模板参数不正确", 422, 422);
    const ts = now();
    await env.XBOARD_DB.prepare("INSERT INTO v2_mail_templates(name, subject, content, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET subject = excluded.subject, content = excluded.content, enabled = 1, updated_at = excluded.updated_at")
      .bind(name, String(input.subject), String(input.content), ts, ts).run();
    return ok(true);
  }
  if (request.method === "POST" && route === "/mail/template/reset") {
    const input = await body<Record<string, any>>(request);
    if (!mailTemplateMeta[String(input.name || "")]) return fail("模板不存在", 404, 404);
    await env.XBOARD_DB.prepare("DELETE FROM v2_mail_templates WHERE name = ?").bind(String(input.name)).run();
    return ok(true);
  }
  if (request.method === "POST" && route === "/mail/template/test") {
    const input = await body<Record<string, any>>(request);
    const name = String(input.name || "");
    if (!mailTemplateMeta[name]) return fail("模板不存在", 404, 404);
    const all = await settings(env.XBOARD_DB);
    const vars = { name: pickSetting(all, "app_name", "XBoard"), code: "123456", content: "This is xboard test email", url: pickSetting(all, "app_url", "") };
    await queueTemplateMail(env, name, String(input.email || (admin as any).email), vars, `XBoard ${mailTemplateMeta[name].label}测试`);
    return ok(true);
  }
  if (path.includes("/system/getSystemStatus")) {
    const lastRun = await optionalKvGet(env, "schedule:last_run:xboard:statistics");
    return ok({ schedule: !!lastRun && now() - Number(lastRun) < 120, horizon: true, schedule_last_runtime: lastRun ? Number(lastRun) : null });
  }
  if (path.includes("/system/getQueueStats")) {
    const result = await env.XBOARD_DB.prepare("SELECT status, COUNT(*) AS count FROM v2_job_logs GROUP BY status").all<Record<string, any>>();
    const counts = Object.fromEntries((result.results || []).map(row => [String(row.status), Number(row.count || 0)]));
    const failedJobs = counts.failed || 0; const recentJobs = Object.values(counts).reduce((sum: number, value: any) => sum + Number(value || 0), 0);
    return ok({ failedJobs, jobsPerMinute: 0, pausedMasters: 0, periods: { failedJobs: 10080, recentJobs: 60 }, processes: 1, queueWithMaxRuntime: null, queueWithMaxThroughput: null, recentJobs, status: true, wait: { "cloudflare-queues:default": 0 } });
  }
  if (path.includes("/system/getQueueWorkload")) {
    const result = await env.XBOARD_DB.prepare("SELECT type AS name, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS length FROM v2_job_logs GROUP BY type ORDER BY type").all<Record<string, any>>();
    return ok((result.results || []).map(row => ({ name: row.name, length: Number(row.length || 0), wait: 0, processes: 1, split_queues: [String(row.name)] })));
  }
  if (path.includes("/system/getQueueMasters")) return ok([{ name: "xboard-jobs", status: "running", environment: "cloudflare-queues" }]);
  if (request.method === "GET" && route === "/system/getHorizonFailedJobs") {
    const result = await env.XBOARD_DB.prepare("SELECT * FROM failed_jobs ORDER BY id DESC LIMIT 100").all();
    return json({ data: result.results || [], total: (result.results || []).length, current_page: 1, per_page: 100 });
  }
  if ((request.method === "GET" || request.method === "POST") && route === "/system/getAuditLog") return ok(await adminAuditLogs(env, request));
  if (path.includes("/server/manage/save")) return saveServer(request, env);
  if (path.includes("/server/manage/update")) return updateServer(request, env);
  if (path.includes("/server/manage/sort")) return sortServers(request, env);
  if (path.includes("/server/manage/drop")) {
    const input = await body<Record<string, any>>(request.clone());
    if (input.id) await env.XBOARD_DB.prepare("DELETE FROM v2_server WHERE id = ?").bind(input.id).run();
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
  }
  if (path.includes("/server/manage/batchDelete")) {
    const input = await body<Record<string, any>>(request.clone());
    const ids = parseJsonArray(input.ids);
    for (const id of ids) await env.XBOARD_DB.prepare("DELETE FROM v2_server WHERE id = ?").bind(Number(id)).run();
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
    const data = machineId ? (await rows(env.XBOARD_DB, "v2_server", 1000) as any[]).filter(row => Number(row.machine_id || 0) === machineId) : [];
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
    return result.success ? ok({ token: machineToken }) : fail("服务器不存在", 404, 400202);
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
    if (ids.length) {
      for (const id of ids) {
        await env.XBOARD_DB.prepare("UPDATE v2_user SET banned = 1, updated_at = ? WHERE id = ?").bind(now(), Number(id)).run();
        await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ?").bind(Number(id)).run();
      }
    } else if (String(input.scope || "") === "all") {
      await env.XBOARD_DB.prepare("UPDATE v2_user SET banned = 1, updated_at = ? WHERE is_admin = 0").bind(now()).run();
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
    const ticketIds = await env.XBOARD_DB.prepare("SELECT id FROM v2_ticket WHERE user_id = ?").bind(id).all<{ id: number }>();
    for (const ticket of ticketIds.results || []) await env.XBOARD_DB.prepare("DELETE FROM v2_ticket_message WHERE ticket_id = ?").bind(ticket.id).run();
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("DELETE FROM v2_ticket WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_stat_user WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_order WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_invite_code WHERE user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ?").bind(id),
      env.XBOARD_DB.prepare("UPDATE v2_user SET invite_user_id = NULL WHERE invite_user_id = ?").bind(id),
      env.XBOARD_DB.prepare("DELETE FROM v2_user WHERE id = ? AND is_admin = 0").bind(id)
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
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email))) return fail("邮箱格式不正确", 422, 422);
    if (values.password) { if (String(values.password).length < 8) return fail("密码长度最小8位", 422, 422); values.password = await hashPassword(String(values.password)); }
    if (values.balance !== undefined) values.balance = Math.round(Number(values.balance) * 100);
    if (values.commission_balance !== undefined) values.commission_balance = Math.round(Number(values.commission_balance) * 100);
    for (const key of ["banned", "is_admin", "is_staff"]) if (values[key] !== undefined) values[key] = boolNumber(values[key]);
    for (const key of ["commission_rate", "discount"]) if (values[key] !== undefined && values[key] !== null && (Number(values[key]) < 0 || Number(values[key]) > 100)) return fail(`${key} 必须在0到100之间`, 422, 422);
    if (values.plan_id) {
      const plan = await env.XBOARD_DB.prepare("SELECT group_id FROM v2_plan WHERE id = ?").bind(Number(values.plan_id)).first<{ group_id: number }>();
      if (!plan) return fail("订阅计划不存在", 400, 400202);
      values.group_id = plan.group_id;
    } else if (values.plan_id === null || values.plan_id === "") { values.plan_id = null; values.group_id = null; }
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
    const users = scope === "selected"
      ? await env.XBOARD_DB.prepare(`SELECT u.*, p.name AS plan_name FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id WHERE u.id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Record<string, any>>()
      : await env.XBOARD_DB.prepare("SELECT u.*, p.name AS plan_name FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id ORDER BY u.id DESC").all<Record<string, any>>();
    const all = await settings(env.XBOARD_DB);
    for (const recipient of users.results || []) {
      const vars = {
        "app.name": pickSetting(all, "app_name", "XBoard"), "app.url": pickSetting(all, "app_url", ""),
        name: pickSetting(all, "app_name", "XBoard"), url: pickSetting(all, "app_url", ""), content,
        "user.id": recipient.id, "user.email": recipient.email, "user.uuid": recipient.uuid,
        "user.plan_name": recipient.plan_name || "", "user.expired_at": recipient.expired_at || "",
        "user.transfer_enable": Number(recipient.transfer_enable || 0), "user.transfer_used": Number(recipient.u || 0) + Number(recipient.d || 0),
        "user.transfer_left": Number(recipient.transfer_enable || 0) - Number(recipient.u || 0) - Number(recipient.d || 0)
      };
      await queueMail(env, { to: String(recipient.email), subject: renderMailText(subject, vars), content: renderMailText(content, vars), template_name: "notify" });
    }
    return ok(true);
  }
  if (path.includes("/user/dumpCSV")) return dumpAdminUsers(request, env);
  if (request.method === "GET" && route === "/traffic-reset/logs") return json(await trafficResetLogs(env, request));
  if (request.method === "GET" && route === "/traffic-reset/stats") {
    const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get("days") || 30)));
    const since = now() - days * 86400;
    const total = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_traffic_reset_logs WHERE reset_time >= ${since}`);
    const manual = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_traffic_reset_logs WHERE reset_time >= ${since} AND reset_type = 'manual'`);
    return json({ data: { total_resets: total, auto_resets: total - manual, manual_resets: manual, cron_resets: 0 } });
  }
  if (request.method === "POST" && route === "/traffic-reset/reset-user") return resetUserTraffic(env, request, Number((admin as any).id));
  const historyMatch = route.match(/^\/traffic-reset\/user\/(\d+)\/history$/);
  if (request.method === "GET" && historyMatch) {
    const userId = Number(historyMatch[1]);
    const user = await env.XBOARD_DB.prepare("SELECT id, email, reset_count, last_reset_at, next_reset_at FROM v2_user WHERE id = ?").bind(userId).first();
    if (!user) return fail("用户不存在", 404, 404);
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_traffic_reset_logs WHERE user_id = ? ORDER BY reset_time DESC LIMIT ?").bind(userId, Math.min(50, Number(new URL(request.url).searchParams.get("limit") || 10))).all();
    return json({ data: { user, history: result.results || [] } });
  }
  for (const [suffix, table] of Object.entries(directFetchTables)) {
    if (path.includes(suffix)) {
      if (suffix === "/server/group/fetch") return ok(await adminServerGroupRows(env));
      if (suffix === "/server/manage/getNodes") return ok(await adminServerRows(env));
      if (suffix === "/server/machine/fetch") return ok(await adminMachineRows(env));
      if (suffix === "/server/route/fetch") return ok(await adminRouteRows(env));
      if (suffix === "/plan/fetch") return ok(await adminPlanRows(env));
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
  if (path.match(/order|coupon|commission|gift-card/)) return json({ data: [], total: 0, current_page: 1, per_page: 20 });
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
}

async function userApi(request: Request, env: Env, path: string) {
  if (request.method === "GET" && path.includes("/passport/auth/token2Login")) {
    const url = new URL(request.url); const directToken = url.searchParams.get("token"); const verify = url.searchParams.get("verify");
    if (directToken) {
      const all = await settings(env.XBOARD_DB); const base = String(pickSetting(all, "app_url", "") || url.origin).replace(/\/$/, "");
      return Response.redirect(`${base}/#/login?verify=${encodeURIComponent(directToken)}&redirect=${encodeURIComponent(url.searchParams.get("redirect") || "dashboard")}`, 302);
    }
    if (verify) {
      const userId = Number(await optionalKvGet(env, `quick_login:${verify}`) || 0);
      if (!userId) return json({ message: "Token error" }, 400);
      const target = await env.XBOARD_DB.prepare("SELECT id,email,is_admin,banned FROM v2_user WHERE id=?").bind(userId).first<Record<string, any>>();
      if (!target || Number(target.banned)) return json({ message: "User not found" }, 400);
      try { await env.XBOARD_KV.delete(`quick_login:${verify}`); } catch {}
      const accessToken = await createSession(env.XBOARD_DB, env.XBOARD_KV, target as any, false);
      return ok({ token: accessToken, is_admin: !!target.is_admin, email: target.email, auth_data: accessToken });
    }
    return json({ message: "Invalid request" }, 400);
  }
  if (request.method === "POST" && path.includes("/passport/auth/getQuickLoginUrl")) {
    const input = await body<Record<string, any>>(request.clone());
    const authData = String(input.auth_data || request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const authRequest = new Request(request.url, { headers: { authorization: `Bearer ${authData}` } });
    const target = await currentUser(authRequest, env.XBOARD_DB, env.XBOARD_KV, false);
    if (!target) return json({ message: "Unauthorized or expired" }, 401);
    const verify = randomString(32); await optionalKvPutTtl(env, `quick_login:${verify}`, String((target as any).id), 300);
    const all = await settings(env.XBOARD_DB); const base = String(pickSetting(all, "app_url", "") || new URL(request.url).origin).replace(/\/$/, "");
    return ok(`${base}/api/v1/passport/auth/token2Login?token=${verify}&redirect=${encodeURIComponent(String(input.redirect || "dashboard"))}`);
  }
  if (request.method === "POST" && path.includes("/passport/comm/sendEmailVerify")) {
    const input = await body<Record<string, any>>(request);
    const email = String(input.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Email format is incorrect", 422, 422);
    const all = await settings(env.XBOARD_DB);
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
    const expected = await optionalKvGet(env, `verify:email:${email}`);
    if (!expected || expected !== String(input.email_code || "")) return fail("Email verification code is incorrect", 400, 400);
    if (!String(input.password || "")) return fail("Password can not be empty", 422, 422);
    const password = await hashPassword(String(input.password));
    const result = await env.XBOARD_DB.prepare("UPDATE v2_user SET password = ?, updated_at = ? WHERE email = ?").bind(password, now(), email).run();
    if (!Number((result.meta as any)?.changes || 0)) return fail("User does not exist", 400, 400);
    try { await env.XBOARD_KV.delete(`verify:email:${email}`); } catch {}
    return ok(true);
  }
  if (path.includes("/passport/auth/login")) return login(request, env, false);
  if (path.includes("/passport/auth/register")) {
    const input = await body<any>(request);
    const ts = now();
    const password = await hashPassword(String(input.password || ""));
    await env.XBOARD_DB.prepare("INSERT INTO v2_user(email, password, uuid, token, transfer_enable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(String(input.email), password, uuid(), token(16), 0, ts, ts).run();
    return login(new Request(request.url, { method: "POST", body: JSON.stringify({ email: input.email, password: input.password }), headers: { "content-type": "application/json" } }), env, false);
  }
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
    const all = await settings(env.XBOARD_DB);
    const limit = Number(pickSetting(all, "invite_gen_limit", 5));
    const count = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_invite_code WHERE user_id = ${Number((user as any).id)} AND status = 0`);
    if (count >= limit) return fail("已达到最大创建数量", 400, 400);
    const ts = now();
    await env.XBOARD_DB.prepare("INSERT INTO v2_invite_code(user_id, code, status, pv, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)").bind((user as any).id, randomString(8), ts, ts).run();
    return ok(true);
  }
  if (request.method === "GET" && route === "/invite/fetch") {
    const all = await settings(env.XBOARD_DB);
    const codes = await env.XBOARD_DB.prepare("SELECT id, code, status, pv, created_at, updated_at FROM v2_invite_code WHERE user_id = ? AND status = 0 ORDER BY id DESC").bind((user as any).id).all();
    const invited = await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE invite_user_id = ${Number((user as any).id)}`);
    const commission = await firstNumber(env, `SELECT COALESCE(SUM(amount), 0) AS c FROM v2_commission_log WHERE user_id = ${Number((user as any).id)}`);
    const rate = Number((user as any).commission_rate || pickSetting(all, "invite_commission", 10));
    return ok({ codes: codes.results || [], stat: [invited, commission, 0, rate, Number((user as any).commission_balance || 0)] });
  }
  if (request.method === "GET" && route === "/invite/details") {
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_commission_log WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind((user as any).id).all();
    return json({ data: result.results || [], total: (result.results || []).length });
  }
  if (request.method === "GET" && route === "/comm/config") {
    const all = await settings(env.XBOARD_DB);
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
    const all = await settings(env.XBOARD_DB);
    return ok({ enabled: Boolean(pickSetting(all, "telegram_bot_enable", 0)), username: pickSetting(all, "telegram_bot_username", ""), discuss_link: pickSetting(all, "telegram_discuss_link", "") });
  }
  if (request.method === "GET" && route === "/knowledge/getCategory") {
    const result = await env.XBOARD_DB.prepare("SELECT DISTINCT category FROM v2_knowledge WHERE show = 1 AND category IS NOT NULL AND category != '' ORDER BY category").all<{ category: string }>();
    return ok((result.results || []).map(row => row.category));
  }
  if (request.method === "GET" && route === "/stat/getTrafficLog") {
    const start = new Date();
    start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_stat_user WHERE user_id = ? AND record_at >= ? ORDER BY record_at DESC").bind((user as any).id, Math.floor(start.getTime() / 1000)).all();
    return ok(result.results || []);
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
    return ok({
      plan_id: (user as any).plan_id, token: (user as any).token, expired_at: (user as any).expired_at, u: Number((user as any).u || 0), d: Number((user as any).d || 0),
      transfer_enable: Number((user as any).transfer_enable || 0), email: (user as any).email, uuid: (user as any).uuid,
      device_limit: (user as any).device_limit, speed_limit: (user as any).speed_limit, next_reset_at: (user as any).next_reset_at,
      plan: plan ? { ...plan, prices: parseJsonObject(plan.prices), tags: parseJsonArray(plan.tags) } : null,
      subscribe_url: await subscribeUrl(request, env, (user as any).token), reset_day: null
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
    if (!(await verifyPassword(oldPassword, String((user as any).password || "")))) return fail("旧密码错误", 400, 400);
    const password = await hashPassword(newPassword);
    await env.XBOARD_DB.prepare("UPDATE v2_user SET password = ?, updated_at = ? WHERE id = ?").bind(password, now(), (user as any).id).run();
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || request.headers.get("x-token") || request.headers.get("token") || "";
    if (bearer) await env.XBOARD_DB.prepare("DELETE FROM personal_access_tokens WHERE tokenable_id = ? AND token != ?").bind((user as any).id, bearer).run();
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
    await env.XBOARD_DB.prepare("UPDATE v2_user SET commission_balance = commission_balance - ?, balance = balance + ?, updated_at = ? WHERE id = ? AND commission_balance >= ?")
      .bind(amount, amount, now(), (user as any).id, amount).run();
    return ok(true);
  }
  if (request.method === "POST" && route === "/getQuickLoginUrl") {
    const input = await body<Record<string, any>>(request); const verify = randomString(32);
    await optionalKvPutTtl(env, `quick_login:${verify}`, String((user as any).id), 300);
    const all = await settings(env.XBOARD_DB); const base = String(pickSetting(all, "app_url", "") || new URL(request.url).origin).replace(/\/$/, "");
    return ok(`${base}/api/v1/passport/auth/token2Login?token=${verify}&redirect=${encodeURIComponent(String(input.redirect || "dashboard"))}`);
  }
  if (request.method === "POST" && route === "/coupon/check") {
    const input = await body<Record<string, any>>(request);
    const code = String(input.code || "").trim();
    if (!code) return fail("优惠券不能为空", 422, 422);
    const coupon = await env.XBOARD_DB.prepare("SELECT * FROM v2_coupon WHERE code = ? AND show = 1").bind(code).first<Record<string, any>>();
    if (!coupon) return fail("优惠券无效", 400, 400);
    return ok(coupon);
  }
  if (path.includes("/plan/fetch")) return ok((await adminPlanRows(env)).filter(row => Number((row as any).show ?? 1) === 1 && Number((row as any).sell ?? 1) === 1));
  if (path.includes("/server/fetch")) return ok((await adminServerRows(env)).filter(row => Number((row as any).show ?? 1) === 1 && Number((row as any).enabled ?? 1) === 1));
  if (path.includes("/notice/fetch")) return ok((await rows(env.XBOARD_DB, "v2_notice", 50) as any[]).filter(row => Number(row.show ?? 1) === 1));
  if (path.includes("/knowledge/fetch")) return ok((await rows(env.XBOARD_DB, "v2_knowledge", 50) as any[]).filter(row => Number(row.show ?? 1) === 1));
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
    const ts = now();
    const result = await env.XBOARD_DB.prepare("INSERT INTO v2_ticket(user_id, subject, level, status, reply_status, last_reply_user_id, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?)")
      .bind((user as any).id, String(input.subject), Number(input.level || 0), (user as any).id, ts, ts).run();
    await env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(Number((result.meta as any)?.last_row_id || 0), (user as any).id, String(input.message), ts, ts).run();
    return ok(true);
  }
  if (path.includes("/ticket/close")) {
    const input = await body<Record<string, any>>(request);
    await env.XBOARD_DB.prepare("UPDATE v2_ticket SET status = 1, updated_at = ? WHERE id = ? AND user_id = ?").bind(now(), input.id, (user as any).id).run();
    return ok(true);
  }
  if (request.method === "POST" && route === "/ticket/reply") {
    const input = await body<Record<string, any>>(request);
    if (!input.id || !input.message) return fail("参数不正确", 400, 400);
    const ticket = await env.XBOARD_DB.prepare("SELECT id, status FROM v2_ticket WHERE id = ? AND user_id = ?").bind(input.id, (user as any).id).first<Record<string, any>>();
    if (!ticket) return fail("工单不存在", 400, 400);
    if (Number(ticket.status)) return fail("工单已关闭，无法回复", 400, 400);
    const ts = now();
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(ticket.id, (user as any).id, String(input.message), ts, ts),
      env.XBOARD_DB.prepare("UPDATE v2_ticket SET reply_status = 1, last_reply_user_id = ?, updated_at = ? WHERE id = ?").bind((user as any).id, ts, ticket.id)
    ]);
    return ok(true);
  }
  if (request.method === "POST" && route === "/ticket/withdraw") {
    const input = await body<Record<string, any>>(request); const all = await settings(env.XBOARD_DB);
    if (Number(pickSetting(all, "withdraw_close_enable", 0))) return fail("Unsupported withdraw", 400, 400);
    const methods = pickSetting(all, "commission_withdraw_method", ["USDT", "支付宝"]);
    if (!Array.isArray(methods) || !methods.includes(input.withdraw_method)) return fail("Unsupported withdrawal method", 422, 422);
    const limit = Number(pickSetting(all, "commission_withdraw_limit", 100));
    if (Number((user as any).commission_balance || 0) / 100 < limit) return fail(`The current required minimum withdrawal commission is ${limit}`, 422, 422);
    if (!String(input.withdraw_account || "").trim()) return fail("Withdrawal account is required", 422, 422);
    const ts = now(); const result = await env.XBOARD_DB.prepare("INSERT INTO v2_ticket(user_id,subject,level,status,reply_status,last_reply_user_id,created_at,updated_at) VALUES (?, ?, 2, 0, 1, ?, ?, ?)")
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

async function adminUi(request: Request, env: Env) {
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/images/favicon.svg" />
    <link rel="icon" type="image/png" href="/images/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admin</title>
    <meta name="description" content="Admin Dashboard UI built with Shadcn and Vite." />
    <script src="/settings.js"></script>
    <script src="/settings.local.js"></script>
    <script src="/locales/en-US.js"></script>
    <script src="/locales/zh-CN.js"></script>
    <script src="/locales/ru-RU.js"></script>
    <script type="module" crossorigin src="/assets/index-CF20260713.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-DiYa-_z_.css">
  </head>
  <body>
    <div id="root"></div>
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isNodeProtocolPath(url.pathname, request.method)) return env.XBOARD_SERVER.fetch(request);
    if (url.pathname === "/api/v1/client/subscribe" || url.pathname.startsWith("/s/") || url.pathname.startsWith("/sub/")) return env.XBOARD_SUBSCRIPTION.fetch(request);
    if (url.pathname.startsWith("/admin/api/")) {
      url.pathname = url.pathname.slice("/admin".length);
      request = new Request(url.toString(), request);
    }
    if (!url.pathname.startsWith("/assets/") && !url.pathname.startsWith("/locales/") && !url.pathname.startsWith("/images/")) {
      await ensureBootstrap(env);
    }
    if (url.pathname === "/health") return ok({ service: "xboard-edge", time: now() });
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return adminUi(request, env);
    if (["/settings.js", "/settings.local.js", "/manifest.json"].includes(url.pathname) || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/locales/") || url.pathname.startsWith("/images/")) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname.startsWith("/api/v1/passport") || url.pathname.startsWith("/api/v2/passport")) {
      return userApi(request, env, url.pathname);
    }
    if (url.pathname.startsWith("/api/v1/guest")) return guestApi(request, env, url.pathname);
    if (url.pathname.startsWith("/api/v1/client") || url.pathname.startsWith("/api/v2/client")) {
      return clientApi(request, env, url.pathname);
    }
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
};
