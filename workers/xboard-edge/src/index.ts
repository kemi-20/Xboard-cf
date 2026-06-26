import type { D1Database, Fetcher, KVNamespace } from "./types";
import { body, fail, json, now, ok, token, uuid } from "./compat";
import { createSession, currentUser, hashPassword, verifyPassword } from "./auth";
import { list, settings } from "./db";
import { bump } from "./kv";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; ASSETS: Fetcher; }

const adminTables: Record<string, string> = {
  user: "v2_user", plan: "v2_plan", server: "v2_server", group: "v2_server_group", route: "v2_server_route",
  machine: "v2_server_machine", notice: "v2_notice", knowledge: "v2_knowledge", ticket: "v2_ticket",
  mail_template: "v2_mail_templates", audit: "v2_admin_audit_log"
};

async function firstNumber(env: Env, sql: string, fallback = 0) {
  try {
    const row = await env.XBOARD_DB.prepare(sql).first<Record<string, number>>();
    const value = row ? Object.values(row)[0] : fallback;
    return Number(value || fallback);
  } catch {
    return fallback;
  }
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

async function login(request: Request, env: Env, admin = false) {
  const input = await body<any>(request);
  const email = String(input.email || input.username || "");
  const password = String(input.password || "");
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE email = ?").bind(email).first<any>();
  if (!user || (admin && Number(user.is_admin) !== 1)) return fail("账号或密码错误", 401, 401);
  if (!(await verifyPassword(password, user.password))) return fail("账号或密码错误", 401, 401);
  const accessToken = await createSession(env.XBOARD_DB, env.XBOARD_KV, user, admin);
  await env.XBOARD_DB.prepare("UPDATE v2_user SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), user.id).run();
  return ok({ token: accessToken, is_admin: !!user.is_admin, email: user.email, auth_data: accessToken });
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
  const allowed = Object.entries(input).filter(([k]) => /^[a-zA-Z0-9_]+$/.test(k));
  if (id) {
    const set = allowed.map(([k]) => `${k} = ?`).join(", ");
    if (set) await env.XBOARD_DB.prepare(`UPDATE ${table} SET ${set}, updated_at = ? WHERE id = ?`).bind(...allowed.map(([, v]) => typeof v === "object" ? JSON.stringify(v) : v), ts, id).run();
  } else {
    const cols = [...allowed.map(([k]) => k), "created_at", "updated_at"];
    const marks = cols.map(() => "?").join(", ");
    await env.XBOARD_DB.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${marks})`).bind(...allowed.map(([, v]) => typeof v === "object" ? JSON.stringify(v) : v), ts, ts).run();
  }
  if (["v2_settings", "v2_server", "v2_plan", "v2_user"].includes(table)) await bump(env.XBOARD_KV, table === "v2_settings" ? "settings_version" : table === "v2_server" ? "servers_version" : "settings_version");
  return ok(true);
}

async function adminApi(request: Request, env: Env, path: string) {
  if (path.includes("/passport/auth/login")) return login(request, env, true);
  const admin = await currentUser(request, env.XBOARD_DB, env.XBOARD_KV, true);
  if (!admin) return fail("未授权", 401, 401);
  if (path.includes("/config/fetch")) return ok(await settings(env.XBOARD_DB));
  if (path.includes("/config/save")) {
    const input = await body<Record<string, any>>(request);
    const ts = now();
    for (const [name, value] of Object.entries(input)) {
      await env.XBOARD_DB.prepare("INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(name, typeof value === "object" ? JSON.stringify(value) : String(value), ts, ts).run();
    }
    await bump(env.XBOARD_KV, "settings_version");
    return ok(true);
  }
  if (path.includes("/stat/getStats")) return ok(await adminStats(env));
  if (path.includes("/stat/getOrder")) return ok(orderStats(new URL(request.url)));
  if (path.includes("/stat/getTrafficRank")) return ok(await trafficRank(env, new URL(request.url)));
  if (path.includes("/plugin/getPlugins")) return ok([]);
  if (path.includes("/plugin/types")) return ok([]);
  if (path.includes("/plugin/config")) return ok({});
  if (path.match(/\/plugin\/(upload|delete|install|uninstall|enable|disable|upgrade)/)) return ok(true);
  if (path.match(/payment|order|coupon|commission|gift-card/)) return ok({ enabled: false, message: "Payment features are disabled in this build.", data: [], total: 0 });
  const entry = Object.entries(adminTables).find(([key]) => path.includes(`/${key}`) || path.includes(`/${key.replace("_", "-")}`));
  if (entry) {
    const [, table] = entry;
    const url = new URL(request.url);
    if (request.method === "GET" && (path.endsWith("/fetch") || path.endsWith("/list") || !path.match(/\/\d+$/))) return ok(await list(env.XBOARD_DB, table, Number(url.searchParams.get("page") || 1), Number(url.searchParams.get("page_size") || 20)));
    const id = path.match(/\/(\d+)(?:\/|$)/)?.[1] || url.searchParams.get("id") || undefined;
    if (request.method === "DELETE" && id) {
      await env.XBOARD_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
      return ok(true);
    }
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
  if (path.includes("/plan/fetch")) return ok(await list(env.XBOARD_DB, "v2_plan", 1, 100));
  if (path.includes("/server/fetch")) return ok(await list(env.XBOARD_DB, "v2_server", 1, 500));
  if (path.includes("/notice/fetch")) return ok(await list(env.XBOARD_DB, "v2_notice", 1, 50));
  if (path.includes("/knowledge/fetch")) return ok(await list(env.XBOARD_DB, "v2_knowledge", 1, 50));
  if (path.includes("/ticket/fetch")) return ok(await list(env.XBOARD_DB, "v2_ticket", 1, 50));
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return ok({ service: "xboard-edge", time: now() });
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return adminUi(request, env);
    if (["/settings.js", "/settings.local.js", "/manifest.json"].includes(url.pathname) || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/locales/") || url.pathname.startsWith("/images/")) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname.startsWith("/api/v2/passport")) return adminApi(request, env, url.pathname.replace("/api/v2", "/api/v2/admin"));
    if (url.pathname.startsWith("/api/v2/admin")) return adminApi(request, env, url.pathname);
    if (url.pathname.startsWith("/api/v1") || url.pathname.startsWith("/api/v2/user")) return userApi(request, env, url.pathname);
    if (url.pathname === "/") return new Response("200", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ status: 200 });
  }
};
