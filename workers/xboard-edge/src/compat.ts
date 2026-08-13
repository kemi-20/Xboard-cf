export const now = () => Math.floor(Date.now() / 1000);
export const ONLINE_RETENTION_SECONDS = 900;
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});
export const ok = (data: unknown = true) => json({
  status: "success",
  message: "操作成功",
  data,
  error: null
});
export const fail = (message = "Error", status = 400, code = 400) => json({ message, errors: message, code }, status);
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  status = 413;

  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

async function boundedBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(chunk.value);
  }
  const value = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

export async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  const bytes = await boundedBody(request);
  const text = new TextDecoder().decode(bytes);
  if (type.includes("application/json")) return (text ? JSON.parse(text) : {}) as T;
  const out: Record<string, unknown> = {};
  const append = (key: string, value: unknown) => {
    if (!(key in out)) out[key] = value;
    else if (Array.isArray(out[key])) (out[key] as unknown[]).push(value);
    else out[key] = [out[key], value];
  };
  if (type.includes("application/x-www-form-urlencoded")) {
    new URLSearchParams(text).forEach((value, key) => append(key, value));
    return out as T;
  }
  if (type.includes("multipart/form-data")) {
    const form = await new Request(request.url, { method: "POST", headers: request.headers, body: bytes }).formData();
    form.forEach((value, key) => append(key, value));
    return out as T;
  }
  if (text) new URLSearchParams(text).forEach((value, key) => append(key, value));
  return out as T;
}
export function uuid(): string {
  return crypto.randomUUID();
}
export function token(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function randomString(length = 32): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  while (result.length < length) {
    const data = new Uint8Array(length - result.length);
    crypto.getRandomValues(data);
    for (const value of data) {
      if (value >= 248) continue;
      result += alphabet[value % alphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function leftRotate(value: number, amount: number) {
  return (value << amount) | (value >>> (32 - amount));
}

const COMPAT_MD5_SHIFTS = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
const COMPAT_MD5_CONSTANTS = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

export function md5(input: string) {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < data.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const next = d;
      d = c;
      c = b;
      b = (b + leftRotate((a + f + COMPAT_MD5_CONSTANTS[i] + words[g]) >>> 0, COMPAT_MD5_SHIFTS[i])) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0,b0,c0,d0].map(value => [0,8,16,24].map(shift => ((value >>> shift) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

export function getBearer(request: Request): string | null {
  const h = (request.headers.get("authorization") || "").trim();
  if (h) {
    if (/^bearer(?:\s|$)/i.test(h)) return h.replace(/^bearer\s*/i, "").trim() || null;
    return h;
  }
  return request.headers.get("x-token") || request.headers.get("token");
}
