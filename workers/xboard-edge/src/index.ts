import type { D1Database, Fetcher, KVNamespace } from "./types";
import { body, fail, json, now, ok, token, uuid } from "./compat";
import { createSession, currentUser, hashPassword, verifyPassword } from "./auth";
import { list, rows, settings } from "./db";
import { bump } from "./kv";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; ASSETS: Fetcher; }

const adminTables: Record<string, string> = {
  user: "v2_user", plan: "v2_plan", server: "v2_server", group: "v2_server_group", route: "v2_server_route",
  machine: "v2_server_machine", notice: "v2_notice", knowledge: "v2_knowledge", ticket: "v2_ticket",
  mail_template: "v2_mail_templates", audit: "v2_admin_audit_log"
};

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
  const marker = await env.XBOARD_KV.get("bootstrap:edge:v4");
  if (marker) return;
  const alters = [
    "ALTER TABLE v2_user ADD COLUMN speed_limit INTEGER DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN discount INTEGER DEFAULT NULL",
    "ALTER TABLE v2_user ADD COLUMN commission_rate INTEGER DEFAULT NULL",
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
    "ALTER TABLE v2_server ADD COLUMN transfer_enable INTEGER DEFAULT 0",
    "ALTER TABLE v2_server ADD COLUMN excludes TEXT",
    "ALTER TABLE v2_server ADD COLUMN ips TEXT",
    "ALTER TABLE v2_server ADD COLUMN code TEXT",
    "ALTER TABLE v2_subscribe_templates ADD COLUMN content TEXT",
    "ALTER TABLE v2_subscribe_templates ADD COLUMN template TEXT",
    "ALTER TABLE v2_ticket ADD COLUMN reply_status INTEGER DEFAULT 0",
    "ALTER TABLE v2_ticket ADD COLUMN last_reply_user_id INTEGER DEFAULT NULL"
  ];
  for (const sql of alters) await runSqlIgnore(env, sql);
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
    password_limit_count: 5, password_limit_expire: 60, email_host: "", email_port: "", email_username: "",
    email_password: "", email_encryption: "", email_from_address: "", remind_mail_enable: 0,
    telegram_bot_enable: 0, telegram_bot_token: "", telegram_webhook_url: "", telegram_discuss_link: "",
    windows_version: "", windows_download_url: "", macos_version: "", macos_download_url: "", android_version: "", android_download_url: ""
  };
  for (const [name, value] of Object.entries(settingsDefaults)) {
    await runSqlIgnore(env, "INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = CASE WHEN v2_settings.value IS NULL OR v2_settings.value = '' THEN excluded.value ELSE v2_settings.value END, updated_at = excluded.updated_at",
      [name, typeof value === "object" ? JSON.stringify(value) : String(value), ts, ts]);
  }
  await runSqlIgnore(env, "INSERT INTO v2_server_group(id, name, created_at, updated_at) VALUES (1, 'Default', ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at", [ts, ts]);
  await runSqlIgnore(env, "INSERT INTO v2_plan(id, group_id, transfer_enable, name, speed_limit, device_limit, capacity_limit, reset_traffic_method, prices, content, tags, show, sell, renew, sort, created_at, updated_at) VALUES (1, 1, 1099511627776, 'Default Trial', NULL, NULL, NULL, 0, '{\"monthly\":0}', 'Default seeded plan for first-run compatibility.', '[]', 1, 1, 1, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, transfer_enable = excluded.transfer_enable, name = excluded.name, show = excluded.show, sell = excluded.sell, renew = excluded.renew, updated_at = excluded.updated_at", [ts, ts]);
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
  await env.XBOARD_KV.put("bootstrap:edge:v4", String(ts));
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
      email_host: pickSetting(all, "email_host", ""),
      email_port: pickSetting(all, "email_port", ""),
      email_username: pickSetting(all, "email_username", ""),
      email_password: pickSetting(all, "email_password", ""),
      email_encryption: pickSetting(all, "email_encryption", ""),
      email_from_address: pickSetting(all, "email_from_address", ""),
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

function subscribeUrl(request: Request, userToken: string) {
  const url = new URL(request.url);
  return `${url.origin}/s/${userToken}`;
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
      ...row,
      balance: Number(row.balance || 0) / 100,
      commission_balance: Number(row.commission_balance || 0) / 100,
      total_used: Number(row.u || 0) + Number(row.d || 0),
      used_traffic: Number(row.u || 0) + Number(row.d || 0),
      subscribe_url: subscribeUrl(request, row.token),
      plan,
      group,
      invite_user: null,
      online_count: 0
    });
  }
  return { ...paginated(data, Number(result.total || data.length), page, pageSize), meta: result };
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

async function adminServerRows(env: Env) {
  const servers = await rows(env.XBOARD_DB, "v2_server", 1000) as any[];
  const out = [];
  for (const server of servers) {
    const groupIds = parseJsonArray(server.group_ids);
    const groups = [];
    for (const id of groupIds) {
      const group = await groupById(env, id);
      if (group) groups.push(group);
    }
    out.push({
      ...server,
      group_ids: groupIds,
      route_ids: parseJsonArray(server.route_ids),
      tags: parseJsonArray(server.tags),
      groups,
      parent: server.parent_id ? servers.find(s => Number(s.id) === Number(server.parent_id)) || null : null,
      online: Number(server.online_user || 0)
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
      is_active: machine.is_active ?? machine.enabled ?? 1,
      last_seen_at: machine.last_seen_at || null,
      servers_count: await firstNumber(env, `SELECT COUNT(*) AS c FROM v2_server WHERE machine_id = ${Number(machine.id)}`)
    });
  }
  return out;
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
  const port = Number(input.port || input.server_port || 443);
  const serverPort = Number(input.server_port || input.port || 443);
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
    cert_config: input.cert_config === undefined ? null : JSON.stringify(input.cert_config),
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
  try {
    if (id) {
      const set = allowed.map(([key]) => `${key} = ?`).join(", ");
      await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id = ?`).bind(...allowed.map(([, value]) => value), ts, id).run();
    } else {
      const cols = [...allowed.map(([key]) => key), "created_at", "updated_at"];
      await env.XBOARD_DB.prepare(`INSERT INTO v2_server(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...allowed.map(([, value]) => value), ts, ts).run();
    }
    await bump(env.XBOARD_KV, "servers_version");
    return ok(true);
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
        await env.XBOARD_DB.prepare(`UPDATE v2_server SET ${set}, updated_at = ? WHERE id = ?`).bind(...fallbackAllowed.map(([, value]) => value), ts, id).run();
      } else {
        const cols = [...fallbackAllowed.map(([key]) => key), "created_at", "updated_at"];
        await env.XBOARD_DB.prepare(`INSERT INTO v2_server(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...fallbackAllowed.map(([, value]) => value), ts, ts).run();
      }
      await bump(env.XBOARD_KV, "servers_version");
      return ok(true);
    } catch (fallbackError: any) {
      return fail(`保存服务器失败: ${fallbackError?.message || error?.message || "D1 写入失败"}`, 500, 500);
    }
  }
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

async function audit(env: Env, adminId: number, request: Request, path: string) {
  if (request.method !== "POST" && request.method !== "DELETE") return;
  try {
    await env.XBOARD_DB.prepare("INSERT INTO v2_admin_audit_log(admin_id, action, target, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(adminId, request.method, path, "{}", request.headers.get("cf-connecting-ip") || "", now()).run();
  } catch {
    // Audit logging must never break admin operations.
  }
}

async function login(request: Request, env: Env, admin = false) {
  const input = await body<any>(request);
  const email = String(input.email || input.username || "");
  const password = String(input.password || "");
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE email = ?").bind(email).first<any>();
  if (!user || (admin && Number(user.is_admin) !== 1)) return fail("账号或密码错误", 401, 401);
  if (Number(user.banned || 0) === 1) return fail("账号已被封禁", 403, 403);
  if (!(await verifyPassword(password, user.password))) return fail("账号或密码错误", 401, 401);
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
    if (set) await env.XBOARD_DB.prepare(`UPDATE ${table} SET ${set}, updated_at = ? WHERE id = ?`).bind(...allowed.map(([, v]) => typeof v === "object" ? JSON.stringify(v) : v), ts, id).run();
  } else {
    const cols = [...allowed.map(([k]) => k), "created_at", "updated_at"];
    const marks = cols.map(() => "?").join(", ");
    await env.XBOARD_DB.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${marks})`).bind(...allowed.map(([, v]) => typeof v === "object" ? JSON.stringify(v) : v), ts, ts).run();
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

async function adminApi(request: Request, env: Env, path: string) {
  if (path.includes("/passport/auth/login")) return login(request, env, true);
  const admin = await currentUser(request, env.XBOARD_DB, env.XBOARD_KV, true);
  if (!admin) return fail("未授权", 401, 401);
  await audit(env, Number((admin as any).id || 0), request, path);
  if (path.includes("/config/fetch")) return ok(await adminConfig(env, request));
  if (path.includes("/config/save")) {
    const input = await body<Record<string, any>>(request);
    const ts = now();
    for (const [name, value] of Object.entries(input)) {
      if (await saveSubscribeTemplate(env, name, value)) continue;
      await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(name, typeof value === "object" ? JSON.stringify(value) : String(value), ts, ts).run();
    }
    await bump(env.XBOARD_KV, "settings_version");
    return ok(true);
  }
  if (path.includes("/stat/getStats")) return ok(await adminStats(env));
  if (path.includes("/stat/getOrder")) return ok(orderStats(new URL(request.url)));
  if (path.includes("/stat/getTrafficRank")) return ok(await trafficRank(env, new URL(request.url)));
  if (path.includes("/theme/getThemes")) return ok({ themes: {}, active: "default" });
  if (path.includes("/theme/getThemeConfig")) return ok({});
  if (path.match(/\/theme\/(saveThemeConfig|upload|delete)/)) return ok(true);
  if (path.includes("/plugin/getPlugins")) return ok([]);
  if (path.includes("/plugin/types")) return ok([]);
  if (path.includes("/plugin/config")) return ok({});
  if (path.match(/\/plugin\/(upload|delete|install|uninstall|enable|disable|upgrade)/)) return ok(true);
  if (path.includes("/payment/getPaymentMethods")) return ok([]);
  if (path.includes("/payment/getPaymentForm")) return ok({ enabled: false, message: "Payment features are disabled in this build." });
  if (path.match(/\/payment\/(save|drop|show|sort)/)) return ok(true);
  if (path.includes("/mail/template/list")) return ok(await rows(env.XBOARD_DB, "v2_mail_templates", 100));
  if (path.includes("/mail/template/get")) return ok({ name: new URL(request.url).searchParams.get("name") || "", subject: "", content: "", enabled: 1 });
  if (path.match(/\/mail\/template\/(save|reset|test)/)) return ok(true);
  if (path.includes("/system/getSystemStatus")) return ok({ ok: true, time: now() });
  if (path.includes("/system/getQueueStats") || path.includes("/system/getQueueWorkload") || path.includes("/system/getQueueMasters")) return ok([]);
  if (path.includes("/system/getHorizonFailedJobs")) return json({ data: [], total: 0, current_page: 1, per_page: 20 });
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
  if (path.includes("/server/machine/nodes")) {
    const machineId = Number(new URL(request.url).searchParams.get("machine_id") || 0);
    const data = machineId ? (await rows(env.XBOARD_DB, "v2_server", 1000) as any[]).filter(row => Number(row.machine_id || 0) === machineId) : [];
    return ok(data);
  }
  if (path.includes("/server/machine/history")) return ok([]);
  if (path.includes("/server/machine/getToken")) return ok({ token: "" });
  if (path.includes("/server/machine/installCommand")) return ok({ command: "" });
  if (path.includes("/server/machine/resetToken")) return ok({ token: token(24) });
  if (path.includes("/server/manage/generateEchKey")) return ok({ key: "", config: "" });
  if (path.includes("/user/resetSecret")) {
    const input = await body<Record<string, any>>(request.clone());
    const newToken = token(16);
    const newUuid = uuid();
    await env.XBOARD_DB.prepare("UPDATE v2_user SET token = ?, uuid = ?, updated_at = ? WHERE id = ?").bind(newToken, newUuid, now(), input.id).run();
    await bump(env.XBOARD_KV, `user_version:${input.id}`);
    return ok(true);
  }
  if (path.includes("/user/ban")) return ok(true);
  if (path.includes("/user/destroy")) {
    const input = await body<Record<string, any>>(request.clone());
    if (input.id) await env.XBOARD_DB.prepare("DELETE FROM v2_user WHERE id = ?").bind(input.id).run();
    return ok(true);
  }
  if (path.includes("/user/update")) return createOrUpdate("v2_user", request, env, String((await body<Record<string, any>>(request.clone())).id || ""));
  if (path.includes("/user/generate")) return ok([]);
  if (path.includes("/user/sendMail")) return ok(true);
  if (path.includes("/user/dumpCSV")) return ok([]);
  if (path.includes("/traffic-reset/logs")) return json({ data: [], total: 0, current_page: 1, per_page: 20 });
  if (path.includes("/traffic-reset/reset-user")) return ok(true);
  if (path.includes("/traffic-reset/user/")) return ok([]);
  for (const [suffix, table] of Object.entries(directFetchTables)) {
    if (path.includes(suffix)) {
      if (suffix === "/server/manage/getNodes") return ok(await adminServerRows(env));
      if (suffix === "/server/machine/fetch") return ok(await adminMachineRows(env));
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
  const entry = Object.entries(adminTables).find(([key]) => path.includes(`/${key}`) || path.includes(`/${key.replace("_", "-")}`));
  if (entry) {
    const [, table] = entry;
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
  return ok({ message: "compatible placeholder", path });
}

async function userApi(request: Request, env: Env, path: string) {
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
  if (path.includes("/user/info")) return ok(user);
  if (path.includes("/user/checkLogin")) return ok(true);
  if (path.includes("/user/getSubscribe")) return ok({ subscribe_url: subscribeUrl(request, (user as any).token), token: (user as any).token });
  if (path.includes("/user/getStat")) return ok({ u: (user as any).u || 0, d: (user as any).d || 0, transfer_enable: (user as any).transfer_enable || 0 });
  if (path.includes("/user/resetSecurity")) {
    const newToken = token(16);
    const newUuid = uuid();
    await env.XBOARD_DB.prepare("UPDATE v2_user SET token = ?, uuid = ?, updated_at = ? WHERE id = ?").bind(newToken, newUuid, now(), (user as any).id).run();
    await bump(env.XBOARD_KV, `user_version:${(user as any).id}`);
    return ok(true);
  }
  if (path.includes("/user/changePassword")) {
    const input = await body<Record<string, any>>(request);
    const password = await hashPassword(String(input.new_password || input.password || ""));
    await env.XBOARD_DB.prepare("UPDATE v2_user SET password = ?, updated_at = ? WHERE id = ?").bind(password, now(), (user as any).id).run();
    return ok(true);
  }
  if (path.includes("/user/update")) return createOrUpdate("v2_user", request, env, String((user as any).id));
  if (path.includes("/plan/fetch")) return ok(await adminPlanRows(env));
  if (path.includes("/server/fetch")) return ok(await adminServerRows(env));
  if (path.includes("/notice/fetch")) return ok((await rows(env.XBOARD_DB, "v2_notice", 50) as any[]).filter(row => Number(row.show ?? 1) === 1));
  if (path.includes("/knowledge/fetch")) return ok((await rows(env.XBOARD_DB, "v2_knowledge", 50) as any[]).filter(row => Number(row.show ?? 1) === 1));
  if (path.includes("/ticket/fetch")) {
    const data = await env.XBOARD_DB.prepare("SELECT * FROM v2_ticket WHERE user_id = ? ORDER BY id DESC LIMIT 50").bind((user as any).id).all();
    return ok(data.results || []);
  }
  if (path.includes("/ticket/save")) {
    const input = await body<Record<string, any>>(request);
    await env.XBOARD_DB.prepare("INSERT INTO v2_ticket(user_id, subject, level, status, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
      .bind((user as any).id, String(input.subject || "Ticket"), Number(input.level || 0), now(), now()).run();
    return ok(true);
  }
  if (path.includes("/ticket/close")) {
    const input = await body<Record<string, any>>(request);
    await env.XBOARD_DB.prepare("UPDATE v2_ticket SET status = 1, updated_at = ? WHERE id = ? AND user_id = ?").bind(now(), input.id, (user as any).id).run();
    return ok(true);
  }
  if (path.includes("/ticket/reply") || path.includes("/ticket/withdraw")) return ok(true);
  return ok({ message: "compatible placeholder", path });
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
    <script type="module" crossorigin src="/assets/index-CEIYH7i8.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-DiYa-_z_.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
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
    "/api/v2/traffic-reset/"
  ];
  if (adminPrefixes.some(prefix => pathname.startsWith(prefix))) return true;
  const adminUserPaths = [
    "/api/v2/user/fetch",
    "/api/v2/user/update",
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
    if (url.pathname.startsWith("/api/v2/passport")) return adminApi(request, env, url.pathname.replace("/api/v2", "/api/v2/admin"));
    if (url.pathname.startsWith("/api/v2/admin")) return adminApi(request, env, url.pathname);
    if (isAdminDistAlias(url.pathname)) return adminApi(request, env, url.pathname.replace("/api/v2", "/api/v2/admin"));
    if (url.pathname.startsWith("/api/v1") || url.pathname.startsWith("/api/v2/user")) return userApi(request, env, url.pathname);
    if (url.pathname === "/") return new Response("200", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ status: 200 });
  }
};
