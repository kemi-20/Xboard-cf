export type Row = Record<string, any>;

export const VALID_NODE_TYPES = [
  "hysteria", "vless", "trojan", "vmess", "tuic", "shadowsocks",
  "anytls", "socks", "naive", "http", "mieru"
] as const;

export function normalizeNodeType(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const type = String(value).toLowerCase();
  if (type === "v2node") return null;
  if (type === "v2ray") return "vmess";
  if (type === "hysteria2") return "hysteria";
  return type;
}

export function isValidNodeType(value: unknown): boolean {
  const type = normalizeNodeType(value);
  return type === null || (VALID_NODE_TYPES as readonly string[]).includes(type);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function objectAt(value: unknown): Row {
  const parsed = parseJson<Row>(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function arrayAt<T = any>(value: unknown): T[] {
  const parsed = parseJson<T[]>(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function get(value: unknown, path: string, fallback: any = null): any {
  let cursor: any = value;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return fallback;
    cursor = cursor[part];
  }
  return cursor ?? fallback;
}

function nullableNested(value: unknown) {
  if (Array.isArray(value) && value.length === 0) return null;
  if (value && typeof value === "object" && Object.keys(value as Row).length === 0) return null;
  return value ?? null;
}

function int(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function leftRotate(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}

// Small MD5 implementation used only for the official Shadowsocks 2022 server key.
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  for (let offset = 0; offset < data.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const next = d;
      d = c;
      c = b;
      b = (b + leftRotate((a + f + constants[i] + words[g]) >>> 0, shifts[i])) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0,b0,c0,d0].map(value => [0,8,16,24].map(shift => ((value >>> shift) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function shadowsocksServerKey(createdAt: unknown, length: number): string {
  return base64(md5(String(createdAt)).slice(0, length));
}

export function buildNodeConfig(node: Row, routeRows: Row[] = []): Row {
  const type = normalizeNodeType(node.type) || String(node.type || "");
  const settings = objectAt(node.protocol_settings);
  const base = {
    protocol: type,
    listen_ip: "0.0.0.0",
    server_port: int(node.server_port),
    network: get(settings, "network", null),
    networkSettings: nullableNested(get(settings, "network_settings", null))
  };
  let response: Row;
  switch (type) {
    case "shadowsocks": {
      const cipher = get(settings, "cipher", null);
      const keyLength = cipher === "2022-blake3-aes-128-gcm" ? 16 : cipher === "2022-blake3-aes-256-gcm" ? 32 : 0;
      response = { ...base, cipher, plugin: get(settings, "plugin", null), plugin_opts: get(settings, "plugin_opts", null), server_key: keyLength ? shadowsocksServerKey(node.created_at, keyLength) : null };
      break;
    }
    case "vmess":
      response = { ...base, tls: int(get(settings, "tls", 0)), tls_settings: get(settings, "tls_settings", null), multiplex: get(settings, "multiplex", null) };
      break;
    case "trojan": {
      const tls = int(get(settings, "tls", 1));
      response = { ...base, host: node.host, server_name: get(settings, "tls_settings.server_name", null), multiplex: get(settings, "multiplex", null), tls, tls_settings: tls === 2 ? get(settings, "reality_settings", null) : get(settings, "tls_settings", null) };
      break;
    }
    case "vless": {
      const tls = int(get(settings, "tls", 0));
      response = { ...base, tls, flow: get(settings, "flow", null), decryption: bool(get(settings, "encryption.enabled", false)) ? get(settings, "encryption.decryption", null) : null, tls_settings: tls === 2 ? get(settings, "reality_settings", null) : get(settings, "tls_settings", null), multiplex: get(settings, "multiplex", null) };
      break;
    }
    case "hysteria": {
      const version = int(get(settings, "version", 2));
      response = { ...base, server_port: int(node.server_port), version, host: node.host, server_name: get(settings, "tls.server_name", null), tls_settings: get(settings, "tls", null), up_mbps: int(get(settings, "bandwidth.up", 0)), down_mbps: int(get(settings, "bandwidth.down", 0)) };
      if (version === 1) response.obfs = get(settings, "obfs.password", null);
      if (version === 2) {
        response.obfs = bool(get(settings, "obfs.open", false)) ? get(settings, "obfs.type", null) : null;
        response["obfs-password"] = get(settings, "obfs.password", null);
      }
      break;
    }
    case "tuic":
      response = { ...base, version: int(get(settings, "version", 5)), server_port: int(node.server_port), server_name: get(settings, "tls.server_name", null), congestion_control: get(settings, "congestion_control", "cubic"), tls_settings: get(settings, "tls", null), auth_timeout: "3s", zero_rtt_handshake: false, heartbeat: "3s" };
      break;
    case "anytls":
      response = { ...base, server_port: int(node.server_port), server_name: get(settings, "tls.server_name", null), tls_settings: get(settings, "tls", null), padding_scheme: get(settings, "padding_scheme", [
        "stop=8", "0=30-30", "1=100-400", "2=400-500,c,500-1000,c,500-1000,c,500-1000,c,500-1000",
        "3=9-9,500-1000", "4=500-1000", "5=500-1000", "6=500-1000", "7=500-1000"
      ]) };
      break;
    case "socks":
    case "naive":
    case "http":
      response = { ...base, server_port: int(node.server_port), tls: int(get(settings, "tls", 0)), tls_settings: get(settings, "tls_settings", null) };
      break;
    case "mieru":
      response = { ...base, server_port: int(node.server_port), transport: get(settings, "transport", "TCP"), traffic_pattern: get(settings, "traffic_pattern", "") };
      break;
    default:
      response = {};
  }
  if (routeRows.length) response.routes = routeRows.map(route => ({ id: int(route.id), match: arrayAt<string>(route.match), action: route.action, action_value: route.action_value }));
  const outbounds = arrayAt(node.custom_outbounds);
  const customRoutes = arrayAt(node.custom_routes);
  if (outbounds.length) response.custom_outbounds = outbounds;
  if (customRoutes.length) response.custom_routes = customRoutes;
  const cert = objectAt(node.cert_config);
  if (Object.keys(cert).length) {
    if (cert.mode !== null && cert.mode !== undefined && cert.cert_mode === undefined) { cert.cert_mode = cert.mode; delete cert.mode; }
    if (cert.cert_mode !== "none") response.cert_config = cert;
  }
  return response;
}

export function availableUser(row: Row): Row {
  return {
    id: int(row.id),
    uuid: String(row.uuid || ""),
    speed_limit: row.speed_limit === null || row.speed_limit === undefined ? null : int(row.speed_limit),
    device_limit: row.device_limit === null || row.device_limit === undefined ? null : int(row.device_limit)
  };
}

export function parseTraffic(input: unknown): Array<{ user_id: number; u: number; d: number }> {
  if (!input || typeof input !== "object") return [];
  const output: Array<{ user_id: number; u: number; d: number }> = [];
  for (const [key, value] of Object.entries(input as Row)) {
    if (!Array.isArray(value) || value.length !== 2) continue;
    const userId = Number(key), u = Number(value[0]), d = Number(value[1]);
    if (Number.isFinite(userId) && Number.isFinite(u) && Number.isFinite(d)) output.push({ user_id: userId, u: Math.max(0, u), d: Math.max(0, d) });
  }
  return output;
}

export function billableTraffic(rows: Array<{ user_id: number; u: number; d: number }>) {
  return rows.filter(row => row.u > 0 || row.d > 0);
}

export async function responseEtag(data: unknown): Promise<string> {
  // PHP json_encode escapes slashes and each UTF-16 code unit, including surrogate pairs.
  const encoded = JSON.stringify(data)
    .replaceAll("/", "\\/")
    .replace(/[\u0080-\uFFFF]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(encoded));
  return `"${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}"`;
}
