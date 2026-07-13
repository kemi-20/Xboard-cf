import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { D1Database, KVNamespace } from "./types.ts";
import { fail, now } from "./compat.ts";
import { cached } from "./kv.ts";
import { settings as loadSettings } from "./db.ts";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; }

type Client = "plain" | "shadowrocket" | "clash" | "clashmeta" | "stash" | "surge" | "surfboard" | "singbox" | "quantumultx" | "loon";
type Config = Record<string, any>;

function b64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64url(value: string) {
  return b64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value && typeof value === "object") return value as T;
  try { return JSON.parse(String(value || "")) as T; } catch { return fallback; }
}

function boolSetting(config: Config, key: string, fallback = false) {
  const value = config[key];
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}

function clientOf(request: Request): Client {
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const url = new URL(request.url);
  const flag = (url.searchParams.get("flag") || url.searchParams.get("target") || ua).toLowerCase();
  if (flag.includes("surge")) return "surge";
  if (flag.includes("surfboard")) return "surfboard";
  if (flag.includes("quantumult")) return "quantumultx";
  if (flag.includes("loon")) return "loon";
  if (flag.includes("shadowrocket")) return "shadowrocket";
  if (flag.includes("stash")) return "stash";
  if (flag.includes("sing-box") || flag.includes("singbox") || flag.includes("hiddify") || flag.includes("sfm")) return "singbox";
  if (["meta", "verge", "flclash", "nekobox", "clashmetaforandroid"].some(name => flag.includes(name))) return "clashmeta";
  if (flag.includes("clash")) return "clash";
  return "plain";
}

function protocolPrefix(server: any) {
  if (server.type === "hysteria") return Number(server.protocol_settings?.version || 1) === 2 ? "[Hy2]" : "[Hy]";
  const prefixes: Config = { vless: "[vless]", shadowsocks: "[ss]", vmess: "[vmess]", trojan: "[trojan]", tuic: "[tuic]", socks: "[socks]", anytls: "[anytls]", http: "[http]" };
  return prefixes[server.type] || "";
}

function traffic(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = Math.max(0, value || 0), unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${Math.round(amount * 100) / 100} ${units[unit]}`;
}

function decorateServers(servers: any[], user: any, config: Config, rejected: number) {
  if (!servers.length) return servers;
  const output = servers.map(server => ({ ...server, protocol_settings: { ...server.protocol_settings } }));
  if (rejected > 0) output.unshift({ ...output[0], name: `过滤掉${rejected}条线路` });
  if (boolSetting(config, "show_info_to_server_enable")) {
    const expire = user.expired_at ? new Date(Number(user.expired_at) * 1000).toISOString().slice(0, 10) : "长期有效";
    output.unshift({ ...output[0], name: `套餐到期：${expire}` });
    if (user.next_reset_at) {
      const days = Math.max(0, Math.ceil((Number(user.next_reset_at) - now()) / 86400));
      output.unshift({ ...output[0], name: `距离下次重置剩余：${days} 天` });
    }
    output.unshift({ ...output[0], name: `剩余流量：${traffic(Number(user.transfer_enable || 0) - Number(user.u || 0) - Number(user.d || 0))}` });
  }
  if (boolSetting(config, "show_protocol_to_server_enable")) {
    for (const server of output) server.name = `${protocolPrefix(server)}${server.name}`;
  }
  return output;
}

function hostOf(server: any) {
  const host = String(server.host || "");
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function query(params: Config) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "" && value !== false) result.set(key, String(value));
  }
  return result.toString();
}

function generalUri(user: any, server: any) {
  const ps = server.protocol_settings || {};
  const password = user.uuid;
  const name = encodeURIComponent(server.name);
  const address = hostOf(server);
  if (server.type === "shadowsocks") {
    const auth = b64url(`${ps.cipher || "aes-128-gcm"}:${password}`);
    const plugin = ps.plugin && ps.plugin_opts ? `/?plugin=${encodeURIComponent(`${ps.plugin};${ps.plugin_opts}`)}` : "";
    return `ss://${auth}@${address}:${server.port}${plugin}#${name}`;
  }
  if (server.type === "vmess") {
    const network = ps.network || "tcp";
    const networkSettings = ps.network_settings || {};
    return `vmess://${b64(JSON.stringify({ v: "2", ps: server.name, add: server.host, port: String(server.port), id: password, aid: "0", net: network, type: networkSettings?.header?.type || "none", host: networkSettings?.headers?.Host || networkSettings?.host || "", path: networkSettings?.path || networkSettings?.serviceName || "", tls: ps.tls ? "tls" : "", sni: ps.tls_settings?.server_name || "" }))}`;
  }
  if (server.type === "vless") {
    const security = Number(ps.tls || 0) === 2 ? "reality" : Number(ps.tls || 0) === 1 ? "tls" : "none";
    const params = query({ encryption: ps.encryption?.enabled ? ps.encryption?.encryption : "none", security, type: ps.network || "tcp", flow: ps.flow, sni: ps.reality_settings?.server_name || ps.tls_settings?.server_name, pbk: ps.reality_settings?.public_key, sid: ps.reality_settings?.short_id, path: ps.network_settings?.path || ps.network_settings?.serviceName, host: ps.network_settings?.headers?.Host || ps.network_settings?.host, fp: ps.utls?.enabled ? ps.utls?.fingerprint || "chrome" : undefined });
    return `vless://${password}@${address}:${server.port}?${params}#${name}`;
  }
  if (server.type === "trojan") {
    const params = query({ security: Number(ps.tls || 1) === 2 ? "reality" : "tls", type: ps.network || "tcp", sni: ps.reality_settings?.server_name || ps.tls_settings?.server_name, pbk: ps.reality_settings?.public_key, sid: ps.reality_settings?.short_id, path: ps.network_settings?.path || ps.network_settings?.serviceName, host: ps.network_settings?.headers?.Host || ps.network_settings?.host, allowInsecure: ps.tls_settings?.allow_insecure ? 1 : undefined });
    return `trojan://${password}@${address}:${server.port}?${params}#${name}`;
  }
  if (server.type === "hysteria") {
    const common = { sni: ps.tls?.server_name, insecure: ps.tls?.allow_insecure ? 1 : undefined, obfs: ps.obfs?.open ? ps.obfs?.type : undefined, "obfs-password": ps.obfs?.password };
    return Number(ps.version || 1) === 2
      ? `hysteria2://${password}@${address}:${server.port}?${query(common)}#${name}`
      : `hysteria://${address}:${server.port}?${query({ ...common, auth: password, upmbps: ps.bandwidth?.up, downmbps: ps.bandwidth?.down })}#${name}`;
  }
  if (server.type === "tuic") return `tuic://${address}:${server.port}?${query({ uuid: password, password, token: Number(ps.version) === 4 ? password : undefined, alpn: Array.isArray(ps.alpn) ? ps.alpn.join(",") : ps.alpn, sni: ps.tls?.server_name, insecure: ps.tls?.allow_insecure ? 1 : undefined, congestion_control: ps.congestion_control || "cubic" })}#${name}`;
  if (server.type === "anytls") return `anytls://${password}@${address}:${server.port}?${query({ sni: ps.tls?.server_name, insecure: ps.tls?.allow_insecure ? 1 : undefined })}#${name}`;
  if (server.type === "socks") return `socks://${b64(`${password}:${password}@${address}:${server.port}`)}?method=auto#${name}`;
  if (server.type === "http") return `http://${b64(`${password}:${password}`)}@${address}:${server.port}#${name}`;
  return "";
}

function general(user: any, servers: any[], encode = true) {
  const content = servers.map(server => generalUri(user, server)).filter(Boolean).join("\r\n") + "\r\n";
  return encode ? b64(content) : content;
}

function clashProxy(user: any, server: any) {
  const ps = server.protocol_settings || {};
  const base: Config = { name: server.name, type: server.type === "shadowsocks" ? "ss" : server.type, server: server.host, port: Number(server.port), udp: true };
  if (server.type === "shadowsocks") Object.assign(base, { cipher: ps.cipher || "aes-128-gcm", password: user.uuid });
  else if (server.type === "vmess") Object.assign(base, { uuid: user.uuid, alterId: 0, cipher: "auto", network: ps.network || "tcp", tls: Boolean(ps.tls), servername: ps.tls_settings?.server_name, "skip-cert-verify": Boolean(ps.tls_settings?.allow_insecure) });
  else if (server.type === "vless") Object.assign(base, { uuid: user.uuid, network: ps.network || "tcp", tls: Number(ps.tls) === 1, reality: Number(ps.tls) === 2 ? { "public-key": ps.reality_settings?.public_key, "short-id": ps.reality_settings?.short_id } : undefined, servername: ps.reality_settings?.server_name || ps.tls_settings?.server_name, flow: ps.flow });
  else if (server.type === "trojan") Object.assign(base, { password: user.uuid, sni: ps.reality_settings?.server_name || ps.tls_settings?.server_name, network: ps.network || "tcp", "skip-cert-verify": Boolean(ps.tls_settings?.allow_insecure) });
  else if (server.type === "hysteria") Object.assign(base, { type: Number(ps.version || 1) === 2 ? "hysteria2" : "hysteria", password: user.uuid, auth: user.uuid, sni: ps.tls?.server_name, "skip-cert-verify": Boolean(ps.tls?.allow_insecure) });
  else if (server.type === "tuic") Object.assign(base, { uuid: user.uuid, password: user.uuid, sni: ps.tls?.server_name, "skip-cert-verify": Boolean(ps.tls?.allow_insecure), "congestion-controller": ps.congestion_control || "cubic" });
  else if (server.type === "anytls") Object.assign(base, { password: user.uuid, sni: ps.tls?.server_name, "skip-cert-verify": Boolean(ps.tls?.allow_insecure) });
  else Object.assign(base, { username: user.uuid, password: user.uuid });
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}

function regexValue(value: unknown) {
  if (typeof value !== "string" || value.length < 2 || !value.startsWith("/") || value.lastIndexOf("/") === 0) return null;
  const end = value.lastIndexOf("/");
  try { return new RegExp(value.slice(1, end), value.slice(end + 1)); } catch { return null; }
}

function yamlProfile(client: Client, template: string, config: Config, user: any, servers: any[], request: Request) {
  let document: Config;
  try { document = parseYaml(template || "") || {}; } catch { document = {}; }
  const proxies = servers.map(server => clashProxy(user, server));
  const names = proxies.map(proxy => proxy.name);
  document.proxies = [...(Array.isArray(document.proxies) ? document.proxies : []), ...proxies];
  const groups = Array.isArray(document["proxy-groups"]) ? document["proxy-groups"] : [];
  for (const group of groups) {
    const configured = Array.isArray(group.proxies) ? group.proxies : [];
    const patterns = configured.map(regexValue).filter(Boolean) as RegExp[];
    group.proxies = patterns.length
      ? [...configured.filter((item: unknown) => !regexValue(item)), ...names.filter(name => patterns.some(pattern => pattern.test(name)))]
      : [...configured, ...names];
  }
  document["proxy-groups"] = groups.filter((group: any) => Array.isArray(group.proxies) && group.proxies.length);
  document.rules = Array.isArray(document.rules) ? document.rules : [];
  document.rules.unshift(`DOMAIN,${new URL(request.url).hostname},DIRECT`);
  return stringifyYaml(document, { lineWidth: 0 }).replaceAll("$app_name", String(config.app_name || "XBoard"));
}

function singboxOutbound(user: any, server: any) {
  const ps = server.protocol_settings || {};
  const outbound: Config = { type: server.type === "hysteria" && Number(ps.version || 1) === 2 ? "hysteria2" : server.type, tag: server.name, server: server.host, server_port: Number(server.port) };
  if (["vmess", "vless", "trojan", "hysteria", "tuic", "anytls"].includes(server.type)) outbound.uuid = user.uuid;
  if (["shadowsocks", "trojan", "hysteria", "tuic", "anytls", "socks", "http"].includes(server.type)) outbound.password = user.uuid;
  if (server.type === "shadowsocks") outbound.method = ps.cipher || "aes-128-gcm";
  if (ps.tls || ps.tls_settings || ps.reality_settings || ps.tls?.server_name) outbound.tls = { enabled: Boolean(ps.tls || ps.tls?.server_name), server_name: ps.reality_settings?.server_name || ps.tls_settings?.server_name || ps.tls?.server_name, insecure: Boolean(ps.tls_settings?.allow_insecure || ps.tls?.allow_insecure) };
  return outbound;
}

function singboxProfile(template: string, user: any, servers: any[]) {
  let document: Config;
  try { document = JSON.parse(template || "{}"); } catch { document = {}; }
  const proxies = servers.map(server => singboxOutbound(user, server));
  const names = proxies.map(proxy => proxy.tag);
  const outbounds = Array.isArray(document.outbounds) ? document.outbounds : [];
  for (const outbound of outbounds) {
    if (!["selector", "urltest"].includes(outbound.type)) continue;
    outbound.outbounds = [...(Array.isArray(outbound.outbounds) ? outbound.outbounds : []), ...names];
  }
  document.outbounds = [...outbounds, ...proxies];
  return JSON.stringify(document, null, 2);
}

function proxyLine(user: any, server: any, style: "surge" | "surfboard") {
  const ps = server.protocol_settings || {};
  const type = server.type === "shadowsocks" ? "ss" : server.type;
  const separator = style === "surge" ? " = " : "=";
  const parts = [`${server.name}${separator}${type}`, server.host, server.port];
  if (server.type === "shadowsocks") parts.push(`encrypt-method=${ps.cipher || "aes-128-gcm"}`, `password=${user.uuid}`);
  else if (server.type === "vmess") parts.push(`username=${user.uuid}`, "vmess-aead=true");
  else parts.push(`password=${user.uuid}`);
  parts.push("tfo=true", "udp-relay=true");
  return `${parts.join(",")}\r\n`;
}

function subscriptionUrl(request: Request, config: Config, token: string) {
  const configured = String(config.subscribe_url || "").split(",").map(value => value.trim()).filter(Boolean)[0];
  const path = String(config.subscribe_path || "s").replace(/^\/+|\/+$/g, "") || "s";
  if (!configured) return `${new URL(request.url).origin}/${path}/${token}`;
  return `${configured.replace(/\/$/, "")}/${path}/${token}`;
}

function subscribeInfo(config: Config, user: any) {
  const gb = (value: number) => Math.round(value / 1073741824 * 100) / 100;
  const upload = gb(Number(user.u || 0)), download = gb(Number(user.d || 0)), total = gb(Number(user.transfer_enable || 0));
  const expire = user.expired_at ? new Date(Number(user.expired_at) * 1000).toISOString().replace("T", " ").slice(0, 19) : "长期有效";
  return `title=${config.app_name || "XBoard"}订阅信息, content=上传流量：${upload}GB\\n下载流量：${download}GB\\n剩余流量：${Math.max(0, total - upload - download)}GB\\n套餐流量：${total}GB\\n到期时间：${expire}`;
}

function textTemplateProfile(client: "surge" | "surfboard", template: string, config: Config, user: any, servers: any[], request: Request, token: string) {
  const proxies = servers.map(server => proxyLine(user, server, client)).join("");
  const names = servers.map(server => server.name).join(", ");
  return String(template || "")
    .replaceAll("$subs_link", subscriptionUrl(request, config, token))
    .replaceAll("$subs_domain", new URL(request.url).hostname)
    .replaceAll("$proxies", proxies)
    .replaceAll("$proxy_group", names)
    .replaceAll("$subscribe_info", subscribeInfo(config, user))
    .replaceAll("$app_name", String(config.app_name || "XBoard"));
}

async function templates(env: Env) {
  try {
    const result = await env.XBOARD_DB.prepare("SELECT name, COALESCE(content, template, '') AS content FROM v2_subscribe_templates WHERE enabled = 1").all<{ name: string; content: string }>();
    return Object.fromEntries((result.results || []).map(row => [row.name, row.content]));
  } catch {
    const result = await env.XBOARD_DB.prepare("SELECT name, COALESCE(content, '') AS content FROM v2_subscribe_templates").all<{ name: string; content: string }>();
    return Object.fromEntries((result.results || []).map(row => [row.name, row.content]));
  }
}

function output(client: Client, config: Config, templateMap: Config, user: any, servers: any[], request: Request, token: string) {
  if (["clash", "clashmeta", "stash"].includes(client)) return yamlProfile(client, String(templateMap[client] || templateMap.clash || ""), config, user, servers, request);
  if (client === "singbox") return singboxProfile(String(templateMap.singbox || ""), user, servers);
  if (client === "surge" || client === "surfboard") return textTemplateProfile(client, String(templateMap[client] || ""), config, user, servers, request, token);
  if (client === "shadowrocket") {
    const status = `STATUS=🚀↑:${Math.round(Number(user.u || 0) / 1073741824 * 100) / 100}GB,↓:${Math.round(Number(user.d || 0) / 1073741824 * 100) / 100}GB,TOT:${Math.round(Number(user.transfer_enable || 0) / 1073741824 * 100) / 100}GB💡Expires:${user.expired_at ? new Date(Number(user.expired_at) * 1000).toISOString().slice(0, 10) : "长期有效"}\r\n`;
    return b64(status + general(user, servers, false));
  }
  if (client === "loon" || client === "quantumultx") return general(user, servers, false);
  return general(user, servers);
}

async function build(request: Request, env: Env, token: string) {
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE token = ?").bind(token).first<any>();
  if (!user || Number(user.banned) === 1) return { status: 403, body: "Forbidden", headers: {} };
  if (user.expired_at && Number(user.expired_at) < now()) return { status: 403, body: "", headers: { "content-type": "text/plain" } };
  if (Number(user.transfer_enable || 0) > 0 && Number(user.u || 0) + Number(user.d || 0) >= Number(user.transfer_enable)) return { status: 403, body: "", headers: { "content-type": "text/plain" } };

  const config = await loadSettings(env.XBOARD_DB);
  const templateMap = await templates(env);
  const url = new URL(request.url);
  const requestedTypes = (url.searchParams.get("types") || "all").split(/[|,｜]+/).map(value => value.trim()).filter(Boolean);
  const filterKeywords = (url.searchParams.get("filter") || "").length <= 20 ? (url.searchParams.get("filter") || "").split(/[|,｜]+/).map(value => value.trim().toLowerCase()).filter(Boolean) : [];
  const all = (await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE enabled = 1 AND show = 1 ORDER BY sort ASC, id ASC").all<any>()).results || [];
  const available = all.filter(server => {
    if (Number(server.transfer_enable || 0) > 0 && Number(server.u || 0) + Number(server.d || 0) >= Number(server.transfer_enable)) return false;
    const groups = jsonValue<any[]>(server.group_ids, []).map(Number);
    return !groups.length || groups.includes(Number(user.group_id || 0));
  }).map(server => ({ ...server, group_ids: jsonValue(server.group_ids, []), tags: jsonValue(server.tags, []), protocol_settings: jsonValue(server.protocol_settings, {}) }));
  const filtered = available.filter(server => {
    if (!requestedTypes.includes("all") && !requestedTypes.includes(server.type)) return false;
    if (filterKeywords.length && !filterKeywords.some(keyword => String(server.name).toLowerCase().includes(keyword) || server.tags.map((tag: unknown) => String(tag).toLowerCase()).includes(keyword))) return false;
    return true;
  });
  const servers = decorateServers(filtered, user, config, available.length - filtered.length);
  const client = clientOf(request);
  const body = output(client, config, templateMap, user, servers, request, token);
  const appName = String(config.app_name || "XBoard");
  const contentType = ["clash", "clashmeta", "stash"].includes(client) ? "text/yaml; charset=utf-8" : client === "singbox" ? "application/json; charset=utf-8" : client === "surge" || client === "surfboard" ? "application/octet-stream" : "text/plain; charset=utf-8";
  const headers: Config = {
    "subscription-userinfo": `upload=${Number(user.u || 0)}; download=${Number(user.d || 0)}; total=${Number(user.transfer_enable || 0)}; expire=${Number(user.expired_at || 0)}`,
    "profile-update-interval": "24",
    "content-type": contentType,
    "content-disposition": `attachment;filename*=UTF-8''${encodeURIComponent(appName)}${client === "surge" || client === "surfboard" ? ".conf" : ""}`
  };
  if (config.app_url) headers["profile-web-page-url"] = String(config.app_url);
  if (client === "singbox") headers["profile-title"] = `base64:${b64(appName)}`;
  return { status: 200, body, headers };
}

export const __test = { decorateServers, yamlProfile, textTemplateProfile };

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
    const variant = b64url(`${url.searchParams.get("types") || "all"}|${url.searchParams.get("filter") || ""}|${url.hostname}`);
    const cacheKey = `subscribe:${token}:${client}:${variant}:${settingsVersion}:${serversVersion}:${userVersion}`;
    const result = await cached(env.XBOARD_KV, cacheKey, 60, () => build(request, env, token));
    return new Response(result.body, { status: result.status, headers: result.headers as HeadersInit });
  }
};
