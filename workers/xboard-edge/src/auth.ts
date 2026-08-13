import type { D1Database, KVNamespace } from "./types.ts";
import bcrypt from "bcryptjs";
import { getBearer, md5, token, now, sha256Hex } from "./compat.ts";

function equalText(actual: string, expected: string) {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) different |= (a[index] || 0) ^ (b[index] || 0);
  return different === 0;
}

export const sessionTokenDigest = sha256Hex;

async function verifyPbkdf2(password: string, encoded: string) {
  const [scheme, digest, iterationsRaw, salt, expected] = encoded.split("$");
  if (scheme !== "pbkdf2" || digest !== "sha256" || !salt || !expected) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: Number(iterationsRaw) }, key, 256);
  const actual = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  return equalText(actual, expected);
}

export async function verifyPassword(password: string, encoded: string, algorithm?: string | null, salt?: string | null): Promise<boolean> {
  if (encoded.startsWith("pbkdf2$")) return verifyPbkdf2(password, encoded);
  const algo = String(algorithm || "").toLowerCase();
  if (algo === "pbkdf2") return verifyPbkdf2(password, encoded);
  if (algo === "md5") return equalText(md5(password), encoded);
  if (algo === "sha256") return equalText(await sha256Hex(password), encoded);
  if (algo === "md5salt") return equalText(md5(password + String(salt || "")), encoded);
  if (algo === "sha256salt") return equalText(await sha256Hex(password + String(salt || "")), encoded);
  if (/^\$2[aby]\$/.test(encoded)) return bcrypt.compare(password, encoded);
  return !encoded.includes("$") && equalText(password, encoded);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function passwordNeedsUpgrade(encoded: string, algorithm?: string | null) {
  return !/^\$2[aby]\$/.test(encoded) || String(algorithm || "").toLowerCase() !== "bcrypt";
}

export async function createSession(db: D1Database, kv: KVNamespace, user: { id: number; email: string; is_admin?: number }, admin = false) {
  const value = token(32);
  const issuedAt = now();
  await db.prepare("INSERT INTO personal_access_tokens(tokenable_id, name, token, abilities, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(user.id, admin ? "admin" : "user", await sha256Hex(value), admin ? '["admin"]' : '["user"]', issuedAt + 31536000, issuedAt, issuedAt).run();
  try {
    await kv.put(`${admin ? "admin_session" : "session"}:${value}`, JSON.stringify({ id: user.id, email: user.email, is_admin: !!user.is_admin, created_at: now() }), { expirationTtl: 86400 * 7 });
  } catch {
    // D1 tokens remain authoritative when KV is unavailable or its write quota is exhausted.
  }
  return value;
}

export async function currentUser(request: Request, db: D1Database, kv: KVNamespace, admin = false): Promise<any | null> {
  const bearer = getBearer(request);
  if (!bearer) return null;
  const hashed = await sha256Hex(bearer);
  const cached = await kv.get(`${admin ? "admin_session" : "session"}:${bearer}`);
  if (cached) {
    const session = JSON.parse(cached);
    const user = await db.prepare("SELECT u.* FROM personal_access_tokens t JOIN v2_user u ON u.id = t.tokenable_id WHERE t.tokenable_id = ? AND t.token IN (?, ?) AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.banned = 0")
      .bind(session.id, hashed, bearer, now()).first();
    if (user && (!admin || Number((user as any).is_admin) === 1)) return user;
  }
  const row = await db.prepare("SELECT u.* FROM personal_access_tokens t JOIN v2_user u ON u.id = t.tokenable_id WHERE t.token IN (?, ?) AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.banned = 0")
    .bind(hashed, bearer, now()).first();
  if (row && (!admin || Number((row as any).is_admin) === 1)) return row;
  return null;
}
