import type { D1Database, KVNamespace } from "./types";
import { fail, now } from "./compat";
import { cached } from "./kv";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; }

function b64(s: string) {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}
function clientOf(request: Request) {
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const url = new URL(request.url);
  const flag = (url.searchParams.get("flag") || url.searchParams.get("target") || "").toLowerCase();
  if (flag.includes("surge") || ua.includes("surge")) return "surge";
  if (flag.includes("quan") || ua.includes("quantumult")) return "quantumultx";
  if (flag.includes("loon") || ua.includes("loon")) return "loon";
  if (flag.includes("shadowrocket") || ua.includes("shadowrocket")) return "shadowrocket";
  if (flag.includes("clash") || ua.includes("clash")) return flag.includes("meta") ? "clashmeta" : "clash";
  return "plain";
}
function plain(user: any, servers: any[]) {
  return servers.map(s => {
    const ps = JSON.parse(s.protocol_settings || "{}");
    const name = `[${s.type}] ${s.name}`;
    if (s.type === "shadowsocks") return `ss://${b64(`${ps.cipher || "aes-128-gcm"}:${user.uuid}@${s.host}:${s.port}`)}#${encodeURIComponent(name)}`;
    return `vmess://${b64(JSON.stringify({ v: "2", ps: name, add: s.host, port: String(s.port), id: user.uuid, aid: "0", net: ps.network || "tcp", type: "none", host: ps.host || "", path: ps.path || "", tls: ps.tls ? "tls" : "" }))}`;
  }).join("\n");
}
function clash(user: any, servers: any[]) {
  const proxies = servers.map(s => {
    const ps = JSON.parse(s.protocol_settings || "{}");
    return `  - name: "${s.name}"\n    type: ${s.type === "shadowsocks" ? "ss" : s.type}\n    server: ${s.host}\n    port: ${s.port}\n    uuid: ${user.uuid}\n    cipher: ${ps.cipher || "auto"}\n    udp: true`;
  }).join("\n");
  const names = servers.map(s => `"${s.name}"`).join(", ");
  return `port: 7890\nsocks-port: 7891\nallow-lan: true\nmode: rule\nproxies:\n${proxies}\nproxy-groups:\n  - name: Proxy\n    type: select\n    proxies: [${names}]\nrules:\n  - MATCH,Proxy\n`;
}
function profile(client: string, user: any, servers: any[]) {
  if (client === "plain" || client === "shadowrocket") return plain(user, servers);
  if (["clash", "clashmeta", "surge", "quantumultx", "loon"].includes(client)) return clash(user, servers);
  return plain(user, servers);
}
async function build(request: Request, env: Env, token: string) {
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE token = ?").bind(token).first<any>();
  if (!user || Number(user.banned) === 1) return { status: 403, body: "Forbidden", headers: {} };
  if (user.expired_at && Number(user.expired_at) < now()) return { status: 403, body: "Subscription expired", headers: {} };
  if (Number(user.transfer_enable || 0) > 0 && Number(user.u || 0) + Number(user.d || 0) >= Number(user.transfer_enable)) return { status: 403, body: "Traffic exhausted", headers: {} };
  const url = new URL(request.url);
  const types = (url.searchParams.get("types") || "").split(",").map(x => x.trim()).filter(Boolean);
  const filter = (url.searchParams.get("filter") || "").toLowerCase();
  const serversAll = (await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE enabled = 1 AND show = 1 ORDER BY sort DESC, id ASC").all<any>()).results || [];
  const servers = serversAll.filter(server => {
    if (types.length && !types.includes(server.type)) return false;
    if (filter && !`${server.name} ${server.tags || ""}`.toLowerCase().includes(filter)) return false;
    let groupIds: number[] = [];
    try { groupIds = JSON.parse(server.group_ids || "[]").map(Number); } catch {}
    return groupIds.length === 0 || groupIds.includes(Number(user.group_id || 0));
  });
  const client = clientOf(request);
  const body = profile(client, user, servers);
  const upload = Number(user.u || 0), download = Number(user.d || 0), total = Number(user.transfer_enable || 0), expire = Number(user.expired_at || 0);
  return { status: 200, body, headers: { "subscription-userinfo": `upload=${upload}; download=${download}; total=${total}; expire=${expire}`, "profile-update-interval": "24", "content-type": client === "plain" || client === "shadowrocket" ? "text/plain; charset=utf-8" : "text/yaml; charset=utf-8" } };
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response(JSON.stringify({ data: { service: "xboard-subscription", time: now() } }), { headers: { "content-type": "application/json" } });
    const token = url.pathname.split("/").filter(Boolean).pop() || url.searchParams.get("token") || "";
    if (!token) return fail("Token required", 400);
    const user = await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE token = ?").bind(token).first<any>();
    if (!user) return new Response("Forbidden", { status: 403 });
    const settingsVersion = await env.XBOARD_KV.get("settings_version") || "0";
    const serversVersion = await env.XBOARD_KV.get("servers_version") || "0";
    const userVersion = await env.XBOARD_KV.get(`user_version:${user.id}`) || "0";
    const client = clientOf(request);
    const cacheKey = `subscribe:${token}:${client}:${settingsVersion}:${serversVersion}:${userVersion}`;
    const result = await cached(env.XBOARD_KV, cacheKey, 60, () => build(request, env, token));
    return new Response(result.body, { status: result.status, headers: result.headers as HeadersInit });
  }
};
