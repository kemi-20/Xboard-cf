import type { KVNamespace } from "./types.ts";
export async function bump(kv: KVNamespace, key: string) {
  await kv.put(key, String(Date.now()));
}
export async function cached<T>(kv: KVNamespace, key: string, ttl: number, load: () => Promise<T>, shouldCache: (value: T) => boolean = () => true): Promise<T> {
  try {
    const hit = await kv.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    // Subscription generation remains available when KV reads or cached JSON fail.
  }
  const value = await load();
  if (!shouldCache(value)) return value;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // KV is an optional short cache; D1 and generated output are authoritative.
  }
  return value;
}
