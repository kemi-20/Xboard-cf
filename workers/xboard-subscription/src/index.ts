import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { D1Database, KVNamespace } from "./types.ts";
import { fail, now } from "./compat.ts";
import { cached } from "./kv.ts";
import { settings as loadSettings } from "./db.ts";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; }

type Client = "plain" | "shadowrocket" | "shadowsocks" | "clash" | "clashmeta" | "stash" | "surge" | "surfboard" | "singbox" | "quantumultx" | "loon";
type Config = Record<string, any>;

const validServerTypes = new Set(["shadowsocks", "vmess", "vless", "trojan", "hysteria", "tuic", "anytls", "socks", "http", "mieru", "naive"]);
const allowedProtocols: Record<Client, Set<string>> = {
  plain: new Set(["vmess", "vless", "shadowsocks", "trojan", "hysteria", "anytls", "socks", "tuic", "http"]),
  clash: new Set(["shadowsocks", "vmess", "trojan", "socks", "http"]),
  clashmeta: new Set(["shadowsocks", "vmess", "trojan", "vless", "hysteria", "tuic", "anytls", "socks", "http", "mieru"]),
  stash: new Set(["shadowsocks", "vmess", "vless", "hysteria", "trojan", "tuic", "anytls", "socks", "http"]),
  singbox: new Set(["shadowsocks", "trojan", "vmess", "vless", "hysteria", "tuic", "anytls", "socks", "http"]),
  surge: new Set(["shadowsocks", "vmess", "trojan", "hysteria", "anytls", "socks", "http"]),
  surfboard: new Set(["shadowsocks", "vmess", "trojan", "anytls"]),
  shadowrocket: new Set(["shadowsocks", "vmess", "vless", "trojan", "hysteria", "tuic", "anytls", "socks"]),
  shadowsocks: new Set(["shadowsocks"]),
  quantumultx: new Set(["shadowsocks", "vmess", "vless", "trojan", "anytls", "socks", "http"]),
  loon: new Set(["shadowsocks", "vmess", "trojan", "hysteria", "vless", "anytls"])
};

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
  const flag = (url.searchParams.get("flag") || ua).toLowerCase();
  if (flag.includes("surge")) return "surge";
  if (flag.includes("surfboard")) return "surfboard";
  if (flag.includes("stash")) return "stash";
  if (flag.includes("sing-box") || flag.includes("singbox") || flag.includes("hiddify") || flag.includes("sfm")) return "singbox";
  if (flag.includes("shadowsocks")) return "shadowsocks";
  if (flag.includes("shadowrocket")) return "shadowrocket";
  if (flag.includes("quantumult%20x") || flag.includes("quantumult x") || flag.includes("quantumult-x")) return "quantumultx";
  if (flag.includes("loon")) return "loon";
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

function tlsFingerprint(ps: Config) {
  return ps.utls?.enabled ? ps.utls?.fingerprint || "chrome" : undefined;
}

function networkFields(ps: Config, fallbackHost: string) {
  const network = ps.network || "tcp";
  const ns = ps.network_settings || {};
  const fields: Config = { type: network };
  if (network === "ws") Object.assign(fields, { path: ns.path, host: ns.headers?.Host });
  else if (network === "grpc") Object.assign(fields, { serviceName: ns.serviceName });
  else if (network === "h2") Object.assign(fields, { type: "http", path: ns.path, host: Array.isArray(ns.host) ? ns.host.join(",") : ns.host });
  else if (network === "kcp") Object.assign(fields, { type: ns.header?.type || "none", path: ns.seed });
  else if (network === "httpupgrade") Object.assign(fields, { path: ns.path, host: ns.host || fallbackHost });
  else if (network === "xhttp") Object.assign(fields, { path: ns.path, host: ns.host || fallbackHost, mode: ns.mode || "auto", extra: ns.extra && Object.keys(ns.extra).length ? JSON.stringify(ns.extra) : undefined });
  return fields;
}

function trojanNetworkFields(ps: Config, fallbackHost: string) {
  const network = ps.network || "tcp";
  const ns = ps.network_settings || {};
  if (network === "ws") return { type: "ws", path: ns.path, host: ns.headers?.Host };
  if (network === "grpc") return { type: "grpc", serviceName: ns.serviceName };
  if (network === "h2") return { type: "http", path: ns.path, host: Array.isArray(ns.host) ? ns.host.join(",") : ns.host };
  if (network === "httpupgrade") return { type: "httpupgrade", path: ns.path, host: ns.host || fallbackHost };
  if (network === "xhttp") return { type: "xhttp", path: ns.path, host: ns.host || fallbackHost, mode: ns.mode || "auto", extra: ns.extra && Object.keys(ns.extra).length ? JSON.stringify(ns.extra) : undefined };
  return {};
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
    const config: Config = { v: "2", ps: server.name, add: server.host, port: String(server.port), id: password, aid: "0", net: network, type: "none", host: "", path: "", tls: ps.tls ? "tls" : "" };
    if (ps.tls_settings?.server_name) config.sni = ps.tls_settings.server_name;
    if (tlsFingerprint(ps)) config.fp = tlsFingerprint(ps);
    if (network === "tcp" && networkSettings.header?.type && networkSettings.header.type !== "none") Object.assign(config, { type: networkSettings.header.type, path: networkSettings.header?.request?.path?.[0] || "/", host: networkSettings.header?.request?.headers?.Host?.[0] || "" });
    else if (network === "ws") Object.assign(config, { type: "ws", path: networkSettings.path || "", host: networkSettings.headers?.Host || "" });
    else if (network === "grpc") Object.assign(config, { type: "grpc", path: networkSettings.serviceName || "" });
    else if (network === "h2") Object.assign(config, { net: "h2", type: "h2", path: networkSettings.path || "", host: Array.isArray(networkSettings.host) ? networkSettings.host.join(",") : networkSettings.host || "" });
    else if (network === "httpupgrade") Object.assign(config, { net: "httpupgrade", type: "httpupgrade", path: networkSettings.path || "", host: networkSettings.host || server.host });
    else if (network === "xhttp") Object.assign(config, { net: "xhttp", type: "xhttp", path: networkSettings.path || "", host: networkSettings.host || server.host, mode: networkSettings.mode || "auto", extra: networkSettings.extra && Object.keys(networkSettings.extra).length ? JSON.stringify(networkSettings.extra) : undefined });
    return `vmess://${b64(JSON.stringify(Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))))}`;
  }
  if (server.type === "vless") {
    const tlsMode = Number(ps.tls || 0);
    const params: Config = { mode: "multi", security: tlsMode === 2 ? "reality" : tlsMode === 1 ? "tls" : "", encryption: ps.encryption?.enabled ? ps.encryption?.encryption || "none" : "none", flow: ps.flow, ...networkFields(ps, server.host) };
    if (tlsMode === 1) Object.assign(params, { sni: ps.tls_settings?.server_name, allowInsecure: ps.tls_settings?.allow_insecure ? "1" : undefined, fp: tlsFingerprint(ps) });
    if (tlsMode === 2) Object.assign(params, { pbk: ps.reality_settings?.public_key, sid: ps.reality_settings?.short_id, sni: ps.reality_settings?.server_name, servername: ps.reality_settings?.server_name, spx: "/", fp: tlsFingerprint(ps) });
    return `vless://${password}@${address}:${server.port}?${query(params)}#${name}`;
  }
  if (server.type === "trojan") {
    const tlsMode = Number(ps.tls ?? 1);
    const params: Config = { ...trojanNetworkFields(ps, server.host) };
    if (tlsMode === 2) Object.assign(params, { security: "reality", pbk: ps.reality_settings?.public_key, sid: ps.reality_settings?.short_id, sni: ps.reality_settings?.server_name, fp: tlsFingerprint(ps) });
    else Object.assign(params, { allowInsecure: ps.tls_settings?.allow_insecure ? "1" : "0", peer: ps.tls_settings?.server_name, sni: ps.tls_settings?.server_name, fp: tlsFingerprint(ps) });
    return `trojan://${password}@${address}:${server.port}?${query(params)}#${name}`;
  }
  if (server.type === "hysteria") {
    const version = Number(ps.version || 2);
    if (version === 2) {
      return `hysteria2://${password}@${address}:${server.port}?${query({ sni: ps.tls?.server_name, insecure: ps.tls?.allow_insecure ? "1" : "0", obfs: ps.obfs?.open ? "salamander" : undefined, "obfs-password": ps.obfs?.open ? ps.obfs?.password : undefined, mport: server.ports })}#${name}`;
    }
    return `hysteria://${address}:${server.port}?${query({ protocol: "udp", auth: password, sni: ps.tls?.server_name, insecure: ps.tls?.allow_insecure ? "1" : "0", upmbps: ps.bandwidth?.up, downmbps: ps.bandwidth?.down, obfs: ps.obfs?.open && ps.obfs?.password ? "xplus" : undefined, obfsParam: ps.obfs?.open ? ps.obfs?.password : undefined })}#${name}`;
  }
  if (server.type === "tuic") return `tuic://${password}:${password}@${address}:${server.port}?${query({ alpn: Array.isArray(ps.alpn) ? ps.alpn.join(",") : ps.alpn, sni: ps.tls?.server_name, insecure: ps.tls?.allow_insecure ? 1 : undefined, congestion_control: ps.congestion_control || "cubic", "udp-relay-mode": ps.udp_relay_mode || "native" })}#${name}`;
  if (server.type === "anytls") return `anytls://${password}@${address}:${server.port}?${query({ sni: ps.tls?.server_name, insecure: ps.tls?.allow_insecure ? "1" : "0" })}#${name}`;
  if (server.type === "socks") return `socks://${b64(`${password}:${password}`)}@${address}:${server.port}#${name}`;
  if (server.type === "http") return `http://${b64(`${password}:${password}`)}@${address}:${server.port}${ps.tls ? `?${query({ security: "tls", sni: ps.tls_settings?.server_name, allowInsecure: ps.tls_settings?.allow_insecure ? "1" : "0" })}` : ""}#${name}`;
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
  else if (server.type === "vless") {
    Object.assign(base, { uuid: user.uuid, alterId: 0, cipher: "auto", flow: ps.flow, encryption: ps.encryption?.enabled ? ps.encryption?.encryption || "none" : "none", tls: Boolean(ps.tls), "skip-cert-verify": Number(ps.tls) === 2 ? Boolean(ps.reality_settings?.allow_insecure) : Boolean(ps.tls_settings?.allow_insecure), servername: ps.reality_settings?.server_name || ps.tls_settings?.server_name });
    if (Number(ps.tls) === 2) base["reality-opts"] = { "public-key": ps.reality_settings?.public_key, "short-id": ps.reality_settings?.short_id };
    if (tlsFingerprint(ps)) base["client-fingerprint"] = tlsFingerprint(ps);
    const ns = ps.network_settings || {};
    if (ps.network === "tcp" && ns.header?.type === "http") Object.assign(base, { network: "http", "http-opts": { headers: ns.header?.request?.headers, path: ns.header?.request?.path || ["/"] } });
    else if (ps.network === "ws") Object.assign(base, { network: "ws", "ws-opts": { path: ns.path, headers: ns.headers?.Host ? { Host: ns.headers.Host } : undefined } });
    else if (ps.network === "grpc") Object.assign(base, { network: "grpc", "grpc-opts": { "grpc-service-name": ns.serviceName } });
    else if (ps.network === "h2") Object.assign(base, { network: "h2", "h2-opts": { path: ns.path, host: Array.isArray(ns.host) ? ns.host : ns.host ? [ns.host] : undefined } });
    else if (ps.network === "httpupgrade") Object.assign(base, { network: "ws", "ws-opts": { "v2ray-http-upgrade": true, path: ns.path, headers: ns.host ? { Host: ns.host } : undefined } });
    else if (ps.network === "xhttp") Object.assign(base, { network: "xhttp", "xhttp-opts": { path: ns.path, host: ns.host, mode: ns.mode } });
    else base.network = "tcp";
    if (ps.multiplex?.enabled) base.smux = { enabled: true, protocol: ps.multiplex.protocol || "yamux", "max-connections": ps.multiplex.max_connections, padding: ps.multiplex.padding ? true : undefined, "brutal-opts": ps.multiplex.brutal?.enabled ? { enabled: true, up: ps.multiplex.brutal.up_mbps, down: ps.multiplex.brutal.down_mbps } : undefined };
    if (Number(ps.tls) === 1 && ps.tls_settings?.ech?.enabled) base["ech-opts"] = { enable: true, config: ps.tls_settings.ech.config, "query-server-name": ps.tls_settings.ech.query_server_name };
  }
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
  const outbound: Config = { type: server.type === "hysteria" && Number(ps.version || 2) === 2 ? "hysteria2" : server.type, tag: server.name, server: server.host, server_port: Number(server.port) };
  if (["vmess", "vless", "trojan", "hysteria", "tuic", "anytls"].includes(server.type)) outbound.uuid = user.uuid;
  if (["shadowsocks", "trojan", "hysteria", "tuic", "anytls", "socks", "http"].includes(server.type)) outbound.password = user.uuid;
  if (server.type === "shadowsocks") outbound.method = ps.cipher || "aes-128-gcm";
  if (server.type === "vless") {
    outbound.packet_encoding = "xudp";
    if (ps.flow) outbound.flow = ps.flow;
  }
  if (ps.tls || ps.tls_settings || ps.reality_settings || ps.tls?.server_name) {
    outbound.tls = { enabled: Boolean(ps.tls || ps.tls?.server_name), server_name: ps.reality_settings?.server_name || ps.tls_settings?.server_name || ps.tls?.server_name, insecure: Number(ps.tls) === 2 ? Boolean(ps.reality_settings?.allow_insecure) : Boolean(ps.tls_settings?.allow_insecure || ps.tls?.allow_insecure) };
    if (Number(ps.tls) === 2) outbound.tls.reality = { enabled: true, public_key: ps.reality_settings?.public_key, short_id: ps.reality_settings?.short_id };
    if (tlsFingerprint(ps)) outbound.tls.utls = { enabled: true, fingerprint: tlsFingerprint(ps) };
    const ech = ps.tls_settings?.ech || ps.tls?.ech;
    if (ech?.enabled) outbound.tls.ech = { enabled: true, config: ech.config ? [ech.config] : undefined, query_server_name: ech.query_server_name };
  }
  if (ps.multiplex?.enabled) outbound.multiplex = { enabled: true, protocol: ps.multiplex.protocol || "yamux", max_connections: ps.multiplex.max_connections, min_streams: ps.multiplex.min_streams, max_streams: ps.multiplex.max_streams, padding: Boolean(ps.multiplex.padding), brutal: ps.multiplex.brutal?.enabled ? { enabled: true, up_mbps: ps.multiplex.brutal.up_mbps, down_mbps: ps.multiplex.brutal.down_mbps } : undefined };
  const ns = ps.network_settings || {};
  if (ps.network === "tcp" && ns.header?.type === "http") outbound.transport = { type: "http", path: ns.header?.request?.path?.[0] || "/", host: ns.header?.request?.headers?.Host || [] };
  else if (ps.network === "ws") outbound.transport = { type: "ws", path: ns.path, headers: ns.headers?.Host ? { Host: ns.headers.Host } : undefined, max_early_data: 0 };
  else if (ps.network === "grpc") outbound.transport = { type: "grpc", service_name: ns.serviceName };
  else if (ps.network === "h2" || ps.network === "http") outbound.transport = { type: "http", host: ns.host, path: ns.path };
  else if (ps.network === "httpupgrade") outbound.transport = { type: "httpupgrade", host: ns.host || server.host, path: ns.path, headers: ns.headers };
  else if (ps.network === "quic") outbound.transport = { type: "quic" };
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

function shadowsocksProfile(user: any, servers: any[]) {
  const supportedCiphers = new Set(["aes-128-gcm", "aes-256-gcm", "aes-192-gcm", "chacha20-ietf-poly1305"]);
  const items = servers.filter(server => server.type === "shadowsocks" && supportedCiphers.has(server.protocol_settings?.cipher)).map(server => ({
    id: server.id,
    remarks: server.name,
    server: server.host,
    server_port: Number(server.port),
    password: user.uuid,
    method: server.protocol_settings?.cipher
  }));
  const used = Number(user.u || 0) + Number(user.d || 0);
  return JSON.stringify({
    servers: items,
    bytes_used: used,
    bytes_remaining: Number(user.transfer_enable || 0) - used,
    version: 1
  });
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
  servers = servers.filter(server => allowedProtocols[client].has(server.type));
  if (["clash", "clashmeta", "stash"].includes(client)) return yamlProfile(client, String(templateMap[client] || templateMap.clash || ""), config, user, servers, request);
  if (client === "singbox") return singboxProfile(String(templateMap.singbox || ""), user, servers);
  if (client === "shadowsocks") return shadowsocksProfile(user, servers);
  if (client === "surge" || client === "surfboard") return textTemplateProfile(client, String(templateMap[client] || ""), config, user, servers, request, token);
  if (client === "shadowrocket") {
    const status = `STATUS=🚀↑:${Math.round(Number(user.u || 0) / 1073741824 * 100) / 100}GB,↓:${Math.round(Number(user.d || 0) / 1073741824 * 100) / 100}GB,TOT:${Math.round(Number(user.transfer_enable || 0) / 1073741824 * 100) / 100}GB💡Expires:${user.expired_at ? new Date(Number(user.expired_at) * 1000).toISOString().slice(0, 10) : "长期有效"}\r\n`;
    return b64(status + general(user, servers, false));
  }
  if (client === "loon") return general(user, servers, false);
  if (client === "quantumultx") return general(user, servers);
  return general(user, servers);
}

function responseHeaders(client: Client, config: Config, user: any) {
  const appName = String(config.app_name || "XBoard");
  const userInfo = `upload=${Number(user.u || 0)}; download=${Number(user.d || 0)}; total=${Number(user.transfer_enable || 0)}; expire=${Number(user.expired_at || 0)}`;
  const headers: Config = {};

  if (["clash", "clashmeta", "stash"].includes(client)) {
    headers["content-type"] = "text/yaml";
    headers["subscription-userinfo"] = userInfo;
    headers["profile-update-interval"] = "24";
    headers["content-disposition"] = `attachment;filename*=UTF-8''${encodeURIComponent(appName)}`;
    if (client === "clash" && config.app_url) headers["profile-web-page-url"] = String(config.app_url);
    return headers;
  }
  if (client === "singbox") {
    return {
      "content-type": "application/json",
      "profile-title": `base64:${b64(appName)}`,
      "subscription-userinfo": userInfo,
      "profile-update-interval": "24"
    };
  }
  if (client === "surge") {
    return {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment;filename*=UTF-8''${encodeURIComponent(appName)}.conf`
    };
  }
  if (client === "surfboard") {
    return {
      "content-type": "text/html; charset=UTF-8",
      "content-disposition": `attachment;filename*=UTF-8''${encodeURIComponent(appName)}.conf`
    };
  }
  if (client === "shadowsocks") return { "content-type": "application/json" };
  if (client === "shadowrocket") return { "content-type": "text/plain" };
  return { "content-type": "text/plain", "subscription-userinfo": userInfo };
}

async function build(request: Request, env: Env, token: string) {
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE token = ?").bind(token).first<any>();
  if (!user || Number(user.banned) === 1) return { status: 403, body: "Forbidden", headers: {} };
  if (user.expired_at && Number(user.expired_at) < now()) return { status: 403, body: "", headers: { "content-type": "text/plain" } };
  if (Number(user.transfer_enable || 0) > 0 && Number(user.u || 0) + Number(user.d || 0) >= Number(user.transfer_enable)) return { status: 403, body: "", headers: { "content-type": "text/plain" } };

  const config = await loadSettings(env.XBOARD_DB);
  const templateMap = await templates(env);
  const url = new URL(request.url);
  const requestedTypeInput = url.searchParams.get("types") || "all";
  const requestedTypes = requestedTypeInput === "all" ? [...validServerTypes] : requestedTypeInput.split(/[|,｜]+/).map(value => value.trim()).filter(value => validServerTypes.has(value));
  const filterKeywords = (url.searchParams.get("filter") || "").length <= 20 ? (url.searchParams.get("filter") || "").split(/[|,｜]+/).map(value => value.trim().toLowerCase()).filter(Boolean) : [];
  const all = (await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE enabled = 1 AND show = 1 ORDER BY sort ASC, id ASC").all<any>()).results || [];
  const available = all.filter(server => {
    if (Number(server.transfer_enable || 0) > 0 && Number(server.u || 0) + Number(server.d || 0) >= Number(server.transfer_enable)) return false;
    const groups = jsonValue<any[]>(server.group_ids, []).map(Number);
    return !groups.length || groups.includes(Number(user.group_id || 0));
  }).map(server => ({ ...server, group_ids: jsonValue(server.group_ids, []), tags: jsonValue(server.tags, []), protocol_settings: jsonValue(server.protocol_settings, {}) }));
  const filtered = available.filter(server => {
    if (requestedTypes.length && !requestedTypes.includes(server.type)) return false;
    if (filterKeywords.length && !filterKeywords.some(keyword => String(server.name).toLowerCase().includes(keyword) || server.tags.map((tag: unknown) => String(tag).toLowerCase()).includes(keyword))) return false;
    return true;
  });
  const servers = decorateServers(filtered, user, config, available.length - filtered.length);
  const client = clientOf(request);
  const body = output(client, config, templateMap, user, servers, request, token);
  return { status: 200, body, headers: responseHeaders(client, config, user) };
}

export const __test = { clientOf, decorateServers, general, generalUri, yamlProfile, clashProxy, singboxOutbound, shadowsocksProfile, textTemplateProfile, output, responseHeaders };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response(JSON.stringify({ data: { service: "xboard-subscription", time: now() } }), { headers: { "content-type": "application/json" } });
    const token = url.pathname === "/api/v1/client/subscribe"
      ? url.searchParams.get("token") || ""
      : url.pathname.split("/").filter(Boolean).pop() || url.searchParams.get("token") || "";
    if (!token) return fail("Token required", 400);
    const user = await env.XBOARD_DB.prepare("SELECT id FROM v2_user WHERE token = ?").bind(token).first<any>();
    if (!user) return new Response("Forbidden", { status: 403 });
    const settingsVersion = await env.XBOARD_KV.get("settings_version") || "0";
    const serversVersion = await env.XBOARD_KV.get("servers_version") || "0";
    const userVersion = await env.XBOARD_KV.get(`user_version:${user.id}`) || "0";
    const client = clientOf(request);
    const variant = b64url(`${url.searchParams.get("types") || "all"}|${url.searchParams.get("filter") || ""}|${url.hostname}`);
    const cacheKey = `subscribe:v2:${token}:${client}:${variant}:${settingsVersion}:${serversVersion}:${userVersion}`;
    const result = await cached(env.XBOARD_KV, cacheKey, 60, () => build(request, env, token));
    return new Response(result.body, { status: result.status, headers: result.headers as HeadersInit });
  }
};
