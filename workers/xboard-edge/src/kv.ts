import type { KVNamespace } from "./types";
export async function bump(kv: KVNamespace, key: string) {
  try {
    await kv.put(key, String(Date.now()));
  } catch {
    // Version keys only invalidate caches; D1 writes must still succeed when KV is unavailable or over quota.
  }
}
export async function cached<T>(kv: KVNamespace, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await kv.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  return value;
}
