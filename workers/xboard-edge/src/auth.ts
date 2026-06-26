import type { D1Database, KVNamespace } from "./types";
import { getBearer, token, now } from "./compat";

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!encoded.includes("$")) return password === encoded;
  const [scheme, digest, iterationsRaw, salt, expected] = encoded.split("$");
  if (scheme !== "pbkdf2" || digest !== "sha256") return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: Number(iterationsRaw) }, key, 256);
  const actual = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  return actual === expected;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = token(12);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  const hash = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$sha256$100000$${salt}$${hash}`;
}

export async function createSession(db: D1Database, kv: KVNamespace, user: { id: number; email: string; is_admin?: number }, admin = false) {
  const value = token(32);
  await kv.put(`${admin ? "admin_session" : "session"}:${value}`, JSON.stringify({ id: user.id, email: user.email, is_admin: !!user.is_admin, created_at: now() }), { expirationTtl: 86400 * 7 });
  await db.prepare("INSERT INTO personal_access_tokens(tokenable_id, name, token, abilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(user.id, admin ? "admin" : "user", value, admin ? '["admin"]' : '["user"]', now(), now()).run();
  return value;
}

export async function currentUser(request: Request, db: D1Database, kv: KVNamespace, admin = false): Promise<any | null> {
  const bearer = getBearer(request);
  if (!bearer) return null;
  const cached = await kv.get(`${admin ? "admin_session" : "session"}:${bearer}`);
  if (cached) {
    const session = JSON.parse(cached);
    const user = await db.prepare("SELECT * FROM v2_user WHERE id = ?").bind(session.id).first();
    if (user && (!admin || Number((user as any).is_admin) === 1)) return user;
  }
  const row = await db.prepare("SELECT u.* FROM personal_access_tokens t JOIN v2_user u ON u.id = t.tokenable_id WHERE t.token = ?").bind(bearer).first();
  if (row && (!admin || Number((row as any).is_admin) === 1)) return row;
  return null;
}
