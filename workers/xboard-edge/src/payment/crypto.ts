const encoder = new TextEncoder();

function concatBytes(...parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function derLength(length: number) {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, value: Uint8Array) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derSequence(...values: Uint8Array[]) {
  return der(0x30, concatBytes(...values));
}

function derOid(...values: number[]) {
  const body = [values[0] * 40 + values[1]];
  for (const value of values.slice(2)) {
    const encoded = [value & 0x7f];
    for (let rest = value >>> 7; rest; rest >>>= 7) encoded.unshift(0x80 | (rest & 0x7f));
    body.push(...encoded);
  }
  return der(0x06, new Uint8Array(body));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function base64Url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemBytes(value: string) {
  const normalized = value.replaceAll("\\n", "\n").trim();
  const match = normalized.match(/-----BEGIN ([^-]+)-----([\s\S]+?)-----END \1-----/);
  if (!match) return { type: "RAW", bytes: base64ToBytes(normalized) };
  return { type: match[1].trim(), bytes: base64ToBytes(match[2]) };
}

function rsaPkcs1ToPkcs8(key: Uint8Array) {
  const algorithm = derSequence(derOid(1, 2, 840, 113549, 1, 1, 1), der(0x05, new Uint8Array()));
  return derSequence(der(0x02, new Uint8Array([0])), algorithm, der(0x04, key));
}

function rsaPkcs1PublicToSpki(key: Uint8Array) {
  const algorithm = derSequence(derOid(1, 2, 840, 113549, 1, 1, 1), der(0x05, new Uint8Array()));
  return derSequence(algorithm, der(0x03, concatBytes(new Uint8Array([0]), key)));
}

function ecSec1ToPkcs8(key: Uint8Array) {
  const algorithm = derSequence(derOid(1, 2, 840, 10045, 2, 1), derOid(1, 2, 840, 10045, 3, 1, 7));
  return derSequence(der(0x02, new Uint8Array([0])), algorithm, der(0x04, key));
}

async function importRsaPrivate(value: string) {
  const parsed = pemBytes(value);
  const bytes = parsed.type === "RSA PRIVATE KEY" ? rsaPkcs1ToPkcs8(parsed.bytes) : parsed.bytes;
  return crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function importRsaPublic(value: string) {
  const parsed = pemBytes(value);
  const bytes = parsed.type === "RSA PUBLIC KEY" ? rsaPkcs1PublicToSpki(parsed.bytes) : parsed.bytes;
  return crypto.subtle.importKey("spki", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function importEcPrivate(value: string) {
  const parsed = pemBytes(value);
  const bytes = parsed.type === "EC PRIVATE KEY" ? ecSec1ToPkcs8(parsed.bytes) : parsed.bytes;
  return crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function rsa2Sign(value: string, privateKey: string) {
  const key = await importRsaPrivate(privateKey);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(value))));
}

export async function rsa2Verify(value: string, signature: string, publicKey: string) {
  try {
    const key = await importRsaPublic(publicKey);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64ToBytes(signature), encoder.encode(value));
  } catch {
    return false;
  }
}

async function hmacBytes(algorithm: "SHA-256" | "SHA-512", secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: algorithm }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function hmacHex(algorithm: "SHA-256" | "SHA-512", secret: string, value: string) {
  return [...await hmacBytes(algorithm, secret, value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

export async function coinbaseJwt(keyName: string, privateKey: string, method: string, url: URL, timestamp = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: keyName, nonce: crypto.randomUUID().replaceAll("-", "") }));
  const payload = base64Url(JSON.stringify({
    iss: "cdp",
    nbf: timestamp,
    exp: timestamp + 120,
    sub: keyName,
    uri: `${method.toUpperCase()} ${url.host}${url.pathname}`
  }));
  const input = `${header}.${payload}`;
  const key = await importEcPrivate(privateKey);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input)));
  return `${input}.${base64Url(signature)}`;
}
