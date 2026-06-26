import type { KVNamespace } from "./types";
export async function bump(kv: KVNamespace, key: string) {
  await kv.put(key, String(Date.now()));
}
export async function cached<T>(kv: KVNamespace, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await kv.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  return value;
}
