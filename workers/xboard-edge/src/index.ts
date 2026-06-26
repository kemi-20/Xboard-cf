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
  return env.ASSETS.fetch(assetRequest(request, "/index.html"));
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
    return json({ name: "XBoard CF Edge", admin: "/admin" });
  }
};
